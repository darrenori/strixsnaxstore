import { query, one, rpc, parseDbError } from '../lib/db.js';
import * as sheets from '../lib/sheets.js';
import { syncCatalogToSheets, queueStockFollowUp } from './collation.service.js';
import { getCatalogForSheets } from './catalog.service.js';
import log from '../lib/logger.js';

export class AdminError extends Error {
  constructor(message, code = 'ADMIN_ERROR', status = 400) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
    this.status = status;
  }
}

function adminName(admin) {
  if (!admin) return 'system';
  return [admin.first_name, admin.last_name].filter(Boolean).join(' ')
    || admin.username
    || `TG:${admin.telegram_id}`;
}

function toAdminError(err, fallback) {
  const friendly = parseDbError(err);
  return new AdminError(friendly?.message ?? fallback, friendly?.code ?? 'DB_ERROR', 400);
}

// ---------------------------------------------------------------------------
// Stock taking
// ---------------------------------------------------------------------------

/**
 * Set an absolute count, which is what a physical stock-take produces.
 *
 * `collate` is off for the bulk path, so a stock-take of twenty lines pushes
 * the spreadsheet once at the end rather than twenty times over.
 */
export async function setStock({ itemId, admin, count, note, collate = true }) {
  let item;
  try {
    item = await rpc('set_stock', [itemId, admin.id, count, note ?? 'Stock take']);
  } catch (err) {
    throw toAdminError(err, 'Could not update stock.');
  }
  if (collate) queueStockFollowUp();

  log.info('Stock set', { sku: item.sku, count, admin: admin.telegram_id });
  return item;
}

/** Relative change: restocking a box of 24, or writing off a spoiled one. */
export async function adjustStock({ itemId, admin, delta, reason = 'manual_adjust', note }) {
  let item;
  try {
    item = await rpc('adjust_stock', [itemId, admin.id, delta, reason, note ?? null]);
  } catch (err) {
    throw toAdminError(err, 'Could not adjust stock.');
  }
  queueStockFollowUp();

  log.info('Stock adjusted', { sku: item.sku, delta, admin: admin.telegram_id });
  return item;
}

/** Apply a whole stock-take sheet in one go. */
export async function bulkSetStock({ admin, entries }) {
  const results = [];

  for (const entry of entries) {
    try {
      results.push({
        itemId: entry.itemId,
        ok: true,
        item: await setStock({ ...entry, admin, collate: false }),
      });
    } catch (err) {
      results.push({ itemId: entry.itemId, ok: false, error: err.message });
    }
  }

  queueStockFollowUp();
  return results;
}

export async function listStockMovements({ itemId = null, limit = 50 } = {}) {
  const rows = await query(
    `select m.id, m.delta, m.balance_after, m.reason, m.note, m.created_at,
            i.sku, i.name, i.variant,
            o.code as order_code,
            a.username, a.first_name, a.last_name, a.telegram_id
       from stock_movements m
       left join items i     on i.id = m.item_id
       left join orders o    on o.id = m.order_id
       left join app_users a on a.id = m.actor_id
      where ($1::uuid is null or m.item_id = $1::uuid)
      order by m.created_at desc
      limit $2`,
    [itemId, limit]
  );

  return rows.map((r) => ({
    id: r.id,
    delta: r.delta,
    balanceAfter: r.balance_after,
    reason: r.reason,
    note: r.note,
    createdAt: r.created_at,
    sku: r.sku ?? '',
    itemName: r.name ? [r.name, r.variant].filter(Boolean).join(' - ') : 'Deleted item',
    orderCode: r.order_code ?? null,
    actor: r.telegram_id ? adminName(r) : 'system',
  }));
}

// ---------------------------------------------------------------------------
// Item + category management
// ---------------------------------------------------------------------------

/** Derive a stable SKU from a name/variant, e.g. "Hello Panda"/"Milk" -> HP-MILK. */
function suggestSku(name, variant) {
  const initials = String(name).trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  const tail = String(variant || name).toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14);
  return `${initials || 'ITEM'}-${tail || 'X'}`;
}

export async function createItem({ admin, payload }) {
  const category = await one('select id from categories where id = $1', [payload.categoryId]);
  if (!category) throw new AdminError('Pick a valid category.', 'BAD_CATEGORY', 400);

  let sku = (payload.sku || suggestSku(payload.name, payload.variant)).toUpperCase();
  if (await one('select id from items where sku = $1', [sku])) {
    sku = `${sku}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  }

  const item = await one(
    `insert into items(category_id, sku, name, variant, description, price_cents, emoji,
                       image_url, is_special, is_top_pick, is_active, stock, low_stock_at, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    [
      payload.categoryId, sku, payload.name, payload.variant || null,
      payload.description || null, payload.priceCents, payload.emoji || null,
      payload.imageUrl || null, Boolean(payload.isSpecial), Boolean(payload.isTopPick),
      payload.isActive !== false, payload.stock ?? 0, payload.lowStockAt ?? 5,
      payload.sortOrder ?? 999,
    ]
  );

  if ((payload.stock ?? 0) > 0) {
    await query(
      `insert into stock_movements(item_id, delta, balance_after, reason, actor_id, note)
       values ($1, $2, $3, 'restock', $4, 'Opening stock')`,
      [item.id, payload.stock, item.stock, admin.id]
    );
  }

  log.info('Item created', { sku: item.sku, admin: admin.telegram_id });
  queueStockFollowUp();
  return item;
}

const EDITABLE = {
  name: 'name', variant: 'variant', description: 'description', emoji: 'emoji',
  imageUrl: 'image_url', isSpecial: 'is_special', isTopPick: 'is_top_pick',
  isActive: 'is_active', lowStockAt: 'low_stock_at', sortOrder: 'sort_order',
  priceCents: 'price_cents', categoryId: 'category_id',
};

/**
 * Update an item. Note `stock` is deliberately not editable here - it can only
 * move through setStock/adjustStock so that every change lands in the ledger.
 */
export async function updateItem({ admin, itemId, patch }) {
  const sets = [];
  const values = [];

  for (const [key, column] of Object.entries(EDITABLE)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) throw new AdminError('Nothing to update.', 'EMPTY_PATCH', 400);

  values.push(itemId);
  const item = await one(
    `update items set ${sets.join(', ')} where id = $${values.length} returning *`,
    values
  );
  if (!item) throw new AdminError('No such item.', 'ITEM_NOT_FOUND', 404);

  log.info('Item updated', { sku: item.sku, fields: Object.keys(patch), admin: admin.telegram_id });
  queueStockFollowUp();
  return item;
}

/**
 * Items are archived, never deleted - order history references them, and a
 * hard delete would blow a hole in past receipts.
 */
export async function archiveItem({ admin, itemId }) {
  const item = await one('update items set is_active = false where id = $1 returning *', [itemId]);
  if (!item) throw new AdminError('No such item.', 'ITEM_NOT_FOUND', 404);
  log.info('Item archived', { sku: item.sku, admin: admin.telegram_id });
  queueStockFollowUp();
  return item;
}

export async function createCategory({ admin, payload }) {
  const slug = (payload.slug || payload.name)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const category = await one(
    `insert into categories(slug, name, kind, collection_point, tagline, accent, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [
      slug, payload.name, payload.kind,
      payload.collectionPoint || (payload.kind === 'drink' ? 'Blk B Pantry' : 'Blk B Lounge'),
      payload.tagline || null, payload.accent || 'blue', payload.sortOrder ?? 999,
    ]
  );
  log.info('Category created', { slug, admin: admin.telegram_id });
  return category;
}

// ---------------------------------------------------------------------------
// Admin roster
// ---------------------------------------------------------------------------

export async function listUsers({ adminsOnly = false, limit = 100 } = {}) {
  const rows = await query(
    `select id, telegram_id, username, first_name, last_name, display_name,
            is_admin, is_blocked, orders_count, created_at, last_seen_at
       from app_users
      where ($1::boolean is false or is_admin)
      order by last_seen_at desc
      limit $2`,
    [adminsOnly, limit]
  );
  return rows.map((u) => ({ ...u, telegram_id: String(u.telegram_id), name: adminName(u) }));
}

export async function setAdmin({ admin, targetTelegramId, isAdmin }) {
  const target = await one('select * from app_users where telegram_id = $1', [targetTelegramId]);
  if (!target) {
    throw new AdminError(
      'That person has not opened the store yet - ask them to press Start on the bot first.',
      'USER_NOT_FOUND', 404
    );
  }
  if (!isAdmin && target.id === admin.id) {
    throw new AdminError('You cannot remove your own admin access.', 'SELF_DEMOTE', 400);
  }

  const updated = await one(
    'update app_users set is_admin = $1 where id = $2 returning *',
    [isAdmin, target.id]
  );
  log.info('Admin flag changed', { target: String(targetTelegramId), isAdmin, by: admin.telegram_id });
  return { ...updated, telegram_id: String(updated.telegram_id) };
}

export async function setBlocked({ admin, targetTelegramId, isBlocked }) {
  const target = await one('select * from app_users where telegram_id = $1', [targetTelegramId]);
  if (!target) throw new AdminError('No such user.', 'USER_NOT_FOUND', 404);
  if (target.id === admin.id) throw new AdminError('You cannot block yourself.', 'SELF_BLOCK', 400);
  if (target.is_admin && isBlocked) {
    throw new AdminError('Remove their admin access before blocking them.', 'BLOCK_ADMIN', 400);
  }

  const updated = await one(
    'update app_users set is_blocked = $1 where id = $2 returning *',
    [isBlocked, target.id]
  );
  return { ...updated, telegram_id: String(updated.telegram_id) };
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/**
 * Pull edits made in the spreadsheet back into the database.
 *
 * The sheet is normally a mirror - syncCatalogToSheets() overwrites it - but
 * the committee edits it anyway, because correcting a price in a spreadsheet
 * on the shelf is faster than opening the admin panel. This is that edit
 * finding its way home.
 *
 * Matching is by SKU, which is the only column here that is a real identity.
 * A row whose SKU is unknown is reported, never inserted: creating an item
 * needs a category and a considered price, and guessing either from a
 * half-typed row is how a shop ends up selling something for nothing.
 * Likewise a deleted row archives nothing - order history points at items,
 * and rows go missing because somebody sorted the sheet, not because they
 * meant to withdraw a product.
 *
 * Stock does not take the direct route. It moves through set_stock so the
 * ledger records who changed it and to what, exactly as a stock-take does.
 */
export async function importCatalogFromSheets({ admin }) {
  if (!sheets.sheetsEnabled()) {
    throw new AdminError('Google Sheets is not configured.', 'SHEETS_DISABLED', 400);
  }

  let rows;
  try {
    rows = await sheets.readCatalogTab();
  } catch (err) {
    throw new AdminError(`Could not read the sheet: ${err.message}`, 'SHEET_READ_FAILED', 502);
  }
  if (!rows) throw new AdminError('Google Sheets is not configured.', 'SHEETS_DISABLED', 400);

  const current = await getCatalogForSheets();
  const bySku = new Map(current.map((i) => [i.sku, i]));

  const changed = [];
  const stocked = [];
  const skipped = [];
  let unchanged = 0;

  for (const row of rows) {
    if (row.problems.length) {
      skipped.push({ sku: row.sku, row: row.row, reason: row.problems.join('; ') });
      continue;
    }

    const item = bySku.get(row.sku);
    if (!item) {
      skipped.push({ sku: row.sku, row: row.row, reason: 'no item with that SKU' });
      continue;
    }

    // --- everything except stock ------------------------------------------
    const blank = (v) => (v === '' || v === undefined ? null : v);
    const same = (a, b) => blank(a) === blank(b);
    const patch = {};
    if (!same(row.name, item.name)) patch.name = row.name;
    if (!same(row.variant, item.variant)) patch.variant = row.variant;
    if (!same(row.description, item.description)) patch.description = row.description;
    if (row.priceCents !== item.price_cents) patch.price_cents = row.priceCents;
    if (row.lowStockAt !== null && row.lowStockAt !== item.low_stock_at) {
      patch.low_stock_at = row.lowStockAt;
    }
    if (row.isActive !== item.is_active) patch.is_active = row.isActive;
    if (row.isSpecial !== item.is_special) patch.is_special = row.isSpecial;

    const fields = Object.keys(patch);
    if (fields.length) {
      const values = Object.values(patch);
      const sets = fields.map((f, i) => `${f} = $${i + 1}`);
      values.push(item.id);
      try {
        await one(
          `update items set ${sets.join(', ')} where id = $${values.length} returning id`,
          values
        );
        changed.push({ sku: row.sku, fields });
      } catch (err) {
        skipped.push({ sku: row.sku, row: row.row, reason: err.message });
        continue;
      }
    }

    // --- stock, through the ledger ----------------------------------------
    if (row.stock !== null && row.stock !== item.stock) {
      try {
        await setStock({
          itemId: item.id,
          admin,
          count: row.stock,
          note: `Sheet edit (row ${row.row})`,
          collate: false,
        });
        stocked.push({ sku: row.sku, from: item.stock, to: row.stock });
      } catch (err) {
        skipped.push({ sku: row.sku, row: row.row, reason: err.message });
      }
    }

    if (!fields.length && (row.stock === null || row.stock === item.stock)) unchanged += 1;
  }

  // One push at the end, not one per row: it restates the derived columns
  // (Available, Low?, Updated At) that the edits have just invalidated, and
  // puts back anything the importer refused to read. Awaited, because the
  // admin who pressed the button is looking at the sheet.
  await syncCatalogToSheets();
  // The ledger rows and the low-stock check ride along, so a restock typed
  // into the spreadsheet is indistinguishable from one typed into the panel.
  queueStockFollowUp();

  log.info('Catalogue imported from sheet', {
    changed: changed.length, stocked: stocked.length, skipped: skipped.length,
    admin: admin?.telegram_id,
  });

  return {
    read: rows.length,
    updated: changed.length,
    stockChanged: stocked.length,
    unchanged,
    skipped,
    changes: changed,
    stockChanges: stocked,
  };
}

// Re-exported so the routes keep one import for "the admin can do this".
// The implementation lives with the rest of the collation, next to the order
// sync and the low-stock alert it has to stay consistent with.
export { syncCatalogToSheets };

export default {
  setStock, adjustStock, bulkSetStock, listStockMovements,
  createItem, updateItem, archiveItem, createCategory,
  listUsers, setAdmin, setBlocked, syncCatalogToSheets, importCatalogFromSheets, AdminError,
};
