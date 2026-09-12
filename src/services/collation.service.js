import { query, one } from '../lib/db.js';
import * as sheets from '../lib/sheets.js';
import { notifyAdminsOfLowStock } from '../bot/notify.js';
import { getCatalogForSheets } from './catalog.service.js';
import config from '../config.js';
import log from '../lib/logger.js';

/**
 * Everything that has to happen *after* the shop has already answered.
 *
 * Writing a row into Google Sheets takes the better part of a second, and
 * Telegram can take longer. Neither belongs on the path a shopper is waiting
 * on, and neither is allowed to fail an order that Postgres has already
 * accepted. So the rest of the system calls in here and moves on, and this
 * module does the slow, best-effort part behind it.
 *
 * It is the one place that knows the spreadsheet exists, which is what keeps
 * "the sheet is out of date" from being a bug you have to hunt for in five
 * different services.
 */

/**
 * Run work nobody is waiting on.
 *
 * Nothing in here may reject: an unhandled rejection from a fire-and-forget
 * task takes the whole process down on Node, and losing the shop because
 * Google returned a 503 would be a poor trade.
 */
export function queue(label, task) {
  const work = Promise.resolve()
    .then(task)
    .catch((err) => log.error(`${label} failed`, { error: err.message }));
  return work;
}

// ---------------------------------------------------------------------------
// Durable job queue
// ---------------------------------------------------------------------------

let activeRunner = null;
let runnerRequested = false;

async function enqueueJobs(entries) {
  if (entries.length === 0) return true;
  const params = [];
  const values = entries.map((entry) => {
    const start = params.length;
    params.push(entry.kind, entry.key, JSON.stringify(entry.payload ?? {}));
    return `($${start + 1}, $${start + 2}, $${start + 3}::jsonb)`;
  });

  try {
    await query(
      `insert into background_jobs(kind, entity_key, payload)
       values ${values.join(', ')}
       on conflict (kind, entity_key) do update set
         payload = excluded.payload,
         revision = background_jobs.revision + 1,
         attempts = 0,
         run_after = now(),
         updated_at = now(),
         last_error = null`,
      params
    );
    kickJobRunner();
    return true;
  } catch (err) {
    // During a rolling deployment, keep the old best-effort behavior until
    // schema.sql has created the queue table.
    if (err.code === '42P01' || /background_jobs/i.test(err.message)) return false;
    throw err;
  }
}

async function claimJobs(limit) {
  return query(
    `with due as (
       select id from background_jobs
        where run_after <= now()
          and (claimed_at is null or claimed_at < now() - interval '10 minutes')
        order by run_after, id
        limit $1
        for update skip locked
     )
     update background_jobs j
        set claimed_at = now(), attempts = attempts + 1, updated_at = now()
       from due
      where j.id = due.id
     returning j.*`,
    [limit]
  );
}

async function performJob(job) {
  if (job.kind === 'order_sheet_sync') {
    if (!(await syncOrderToSheets(job.entity_key))) throw new Error('Order sheet sync was not accepted');
    return;
  }
  if (job.kind === 'catalog_sheet_sync') {
    if (!(await syncCatalogItemsToSheets([job.entity_key]))) {
      throw new Error('Catalogue sheet sync was not accepted');
    }
    return;
  }
  if (job.kind === 'stock_ledger_sync') {
    if ((await syncStockLedger()) < 0) throw new Error('Stock ledger sync was not accepted');
    return;
  }
  if (job.kind === 'low_stock_check') {
    await checkLowStock();
    return;
  }
  throw new Error(`Unknown background job kind: ${job.kind}`);
}

/** Process due follow-up work. Safe for the boot loop, Vercel, and cron. */
export async function drainBackgroundJobs({ limit = 50 } = {}) {
  let processed = 0;
  while (processed < limit) {
    const jobs = await claimJobs(Math.min(10, limit - processed));
    if (jobs.length === 0) break;

    for (const job of jobs) {
      try {
        await performJob(job);
        const deleted = await query(
          'delete from background_jobs where id = $1 and revision = $2 returning id',
          [job.id, job.revision]
        );
        // A newer request arrived while this one ran. Leave it due and unlock it.
        if (deleted.length === 0) {
          await query('update background_jobs set claimed_at = null where id = $1', [job.id]);
        }
      } catch (err) {
        const delaySeconds = Math.min(3600, 5 * (2 ** Math.min(job.attempts, 9)));
        await query(
          `update background_jobs
              set claimed_at = null,
                  run_after = now() + ($3 * interval '1 second'),
                  last_error = left($4, 1000),
                  updated_at = now()
            where id = $1 and revision = $2`,
          [job.id, job.revision, delaySeconds, err.message]
        );
        log.error('Background job failed', {
          kind: job.kind, key: job.entity_key, attempt: job.attempts, error: err.message,
        });
      }
      processed += 1;
    }
  }
  return processed;
}

/** Start one worker. Unfinished work remains in Postgres for the next run. */
export function kickJobRunner() {
  if (activeRunner) {
    runnerRequested = true;
    return activeRunner;
  }
  activeRunner = drainBackgroundJobs()
    .catch((err) => log.error('Background job runner failed', { error: err.message }))
    .finally(() => {
      activeRunner = null;
      if (runnerRequested) {
        runnerRequested = false;
        kickJobRunner();
      }
    });
  return activeRunner;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const ORDER_SHEET_SQL = `
  select o.id, o.code, o.user_id, o.telegram_id, o.buyer_name, o.status,
         o.subtotal_cents, o.total_cents, o.collection_points, o.note,
         o.payment_proof_id, o.payment_ref, o.proof_source, o.review_note,
         o.reviewed_at, o.sheet_row, o.created_at,
         u.username,
         a.first_name as reviewer_first, a.last_name as reviewer_last,
         a.username   as reviewer_username
    from orders o
    join app_users u on u.id = o.user_id
    left join app_users a on a.id = o.reviewed_by
   where o.id = $1
`;

/**
 * Put an order into the spreadsheet, or refresh the row it already has.
 *
 * Called on every transition an order makes, so the Orders tab tracks the
 * shop rather than lagging behind it. The row number we wrote is remembered
 * on the order, which turns the next update into one write instead of a scan
 * of the whole column.
 */
export async function syncOrderToSheets(orderId) {
  if (!sheets.sheetsEnabled()) return false;

  const order = await one(ORDER_SHEET_SQL, [orderId]);
  if (!order) return false;

  const items = await query(
    `select oi.*, c.name as category_name
       from order_items oi
       left join items i     on i.id = oi.item_id
       left join categories c on c.id = i.category_id
      where oi.order_id = $1
      order by oi.created_at`,
    [orderId]
  );

  const reviewerName = [order.reviewer_first, order.reviewer_last].filter(Boolean).join(' ')
    || order.reviewer_username
    || '';

  const row = await sheets.upsertOrder({
    order: { ...order, reviewer_name: reviewerName },
    items,
    user: { username: order.username },
    knownRow: order.sheet_row,
  });

  if (row > 0) {
    await query(
      'update orders set sheet_synced_at = now(), sheet_row = $2 where id = $1',
      [orderId, row]
    );
  }
  return row > 0;
}

/** Persist an order sync before replying, then run it in the background. */
export async function queueOrderSync(orderId) {
  if (!sheets.sheetsEnabled()) return true;
  const durable = await enqueueJobs([
    { kind: 'order_sheet_sync', key: String(orderId) },
  ]);
  if (!durable) queue('Order sheet sync', () => syncOrderToSheets(orderId));
  return durable;
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/**
 * Copy anything new in the stock ledger into the Stock Movements tab.
 *
 * Sales are the bulk of what moves stock, and only the admin's own
 * stock-takes used to reach the sheet, so the ledger tab described a shop
 * where nothing was ever sold.
 *
 * The tab is append-only, so the rows to copy are *claimed* in the same
 * statement that selects them. Several things move stock and each of them
 * asks for a sync, so without the claim an order settled and then approved
 * would write its sale twice and the sheet would say the shop sold twice what
 * it did. A failed write hands the rows back for the next attempt.
 */
export async function syncStockLedger({ limit = 200 } = {}) {
  if (!sheets.sheetsEnabled()) return 0;

  const rows = await query(
     `with claimed as (
       select id from stock_movements
        where sheeted_at is null
          and (sheet_claimed_at is null or sheet_claimed_at < now() - interval '10 minutes')
        order by created_at
        limit $1
        for update skip locked
     )
     update stock_movements m
        set sheet_claimed_at = now()
       from claimed c
      where m.id = c.id
     returning m.id, m.delta, m.balance_after, m.reason, m.note, m.created_at,
               m.item_id, m.order_id, m.actor_id`,
    [limit]
  );
  if (rows.length === 0) {
    const pending = await one(
      'select exists(select 1 from stock_movements where sheeted_at is null) as yes'
    );
    return pending?.yes ? -1 : 0;
  }

  // Names for the ids, in one round trip rather than one per row.
  const [items, orders, actors] = await Promise.all([
    query('select id, sku, name, variant from items where id = any($1::uuid[])',
      [[...new Set(rows.map((r) => r.item_id))]]),
    query('select id, code from orders where id = any($1::uuid[])',
      [[...new Set(rows.map((r) => r.order_id).filter(Boolean))]]),
    query('select id, first_name, last_name, username from app_users where id = any($1::uuid[])',
      [[...new Set(rows.map((r) => r.actor_id).filter(Boolean))]]),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const ok = await sheets.recordStockMovement(rows
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((r) => {
      const item = itemById.get(r.item_id);
      const actor = actorById.get(r.actor_id);
      return {
        id: r.id,
        created_at: r.created_at,
        sku: item?.sku ?? '',
        item_name: item ? [item.name, item.variant].filter(Boolean).join(' - ') : 'Deleted item',
        delta: r.delta,
        balance_after: r.balance_after,
        reason: r.reason,
        order_code: orderById.get(r.order_id)?.code ?? '',
        actor_name: actor
          ? [actor.first_name, actor.last_name].filter(Boolean).join(' ') || actor.username || ''
          : 'system',
        note: r.note ?? '',
      };
    }));

  if (!ok) {
    // Hand them back rather than losing them to a Google hiccup.
    await query('update stock_movements set sheet_claimed_at = null where id = any($1::uuid[])',
      [rows.map((r) => r.id)]);
    return -1;
  }
  await query(
    `update stock_movements
        set sheeted_at = now(), sheet_claimed_at = null
      where id = any($1::uuid[])`,
    [rows.map((r) => r.id)]
  );
  return rows.length;
}

/** Push the whole catalogue into the "Items & Stock" tab. */
export async function syncCatalogToSheets() {
  if (!sheets.sheetsEnabled()) return false;
  try {
    return await sheets.syncCatalog(await getCatalogForSheets());
  } catch (err) {
    log.error('Catalog sheet sync failed', { error: err.message });
    return false;
  }
}

/** Refresh only specified catalogue rows during routine shop activity. */
export async function syncCatalogItemsToSheets(skus) {
  if (!sheets.sheetsEnabled()) return false;
  try {
    const wanted = [...new Set((skus ?? []).filter(Boolean))];
    if (wanted.length === 0) return true;
    return await sheets.syncCatalogItems(await getCatalogForSheets({ skus: wanted }));
  } catch (err) {
    log.error('Catalogue row sync failed', { error: err.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Low stock
// ---------------------------------------------------------------------------

/**
 * Tell the admins about anything that has just fallen to the last few units.
 *
 * The alert is on the crossing, not on the state. `low_stock_alerted_at` is
 * stamped when the message goes out and cleared the moment the shelf is back
 * above the line, so a line sitting at 1 for a week produces one message, and
 * restocking then selling down again produces the next one.
 *
 * Availability, not raw stock, is what decides it: two packets held by an
 * unpaid order are two packets nobody else can buy.
 */
export async function checkLowStock() {
  const threshold = config.store.lowStockAlertAt;
  if (!Number.isFinite(threshold) || threshold < 0) return 0;

  // Back above the line: arm the alert again for next time.
  await query(
    `update items set low_stock_alerted_at = null
      where low_stock_alerted_at is not null
        and greatest(stock - reserved, 0) > $1`,
    [threshold]
  );

  // Claim the rows in the same statement that selects them, so two sales
  // landing together cannot both decide they are the one to send the message.
  const due = await query(
    `update items
        set low_stock_alerted_at = now()
      where is_active
        and low_stock_alerted_at is null
        and greatest(stock - reserved, 0) <= $1
      returning sku, name, variant, greatest(stock - reserved, 0) as available`,
    [threshold]
  );
  if (due.length === 0) return 0;

  log.info('Low stock alert', { items: due.map((i) => i.sku), threshold });

  const sent = await notifyAdminsOfLowStock(due, threshold);
  if (sent === 0) {
    // Nobody heard it. Un-claim, so the next movement tries again rather than
    // the shelf running out in silence.
    await query(
      'update items set low_stock_alerted_at = null where sku = any($1::text[])',
      [due.map((i) => i.sku)]
    );
  }
  return sent;
}

/**
 * The whole after-the-shelf-moved routine: ledger, mirror, then the alert.
 *
 * A sale, a stock take, a cancellation and an edit typed into the spreadsheet
 * all end here, so the ledger tab, the stock column and the admins' low-stock
 * alerts cannot drift apart from the database or from each other.
 */
export async function queueStockFollowUp(skus = []) {
  const wanted = [...new Set(skus.filter(Boolean))];
  const jobs = [
    { kind: 'stock_ledger_sync', key: 'singleton' },
    { kind: 'low_stock_check', key: 'singleton' },
    ...wanted.map((sku) => ({ kind: 'catalog_sheet_sync', key: sku })),
  ].filter((job) => sheets.sheetsEnabled() || job.kind === 'low_stock_check');

  const durable = await enqueueJobs(jobs);
  if (!durable) {
    queue('Stock follow-up', async () => {
      await syncStockLedger();
      await syncCatalogItemsToSheets(wanted);
      await checkLowStock();
    });
  }
  return durable;
}

export default {
  queue, syncOrderToSheets, queueOrderSync, syncStockLedger,
  syncCatalogToSheets, syncCatalogItemsToSheets, checkLowStock,
  queueStockFollowUp, drainBackgroundJobs, kickJobRunner,
};
