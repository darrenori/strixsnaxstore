import { query, one, rpc, transaction, parseDbError } from '../lib/db.js';
import { createPaymentQr } from '../lib/paynow.js';
import * as sheets from '../lib/sheets.js';
import log from '../lib/logger.js';

export class OrderError extends Error {
  constructor(message, code = 'ORDER_ERROR', status = 400) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.status = status;
  }
}

const ORDER_COLUMNS = `
  id, code, user_id, telegram_id, buyer_name, status, subtotal_cents, total_cents,
  collection_points, note, payment_proof_id, payment_ref, reviewed_by, reviewed_at,
  review_note, sheet_synced_at, expires_at, stock_spent_at, created_at, updated_at
`;

function toPublicOrder(order, items = []) {
  return {
    id: order.id,
    code: order.code,
    status: order.status,
    buyerName: order.buyer_name,
    subtotal: (order.subtotal_cents / 100).toFixed(2),
    total: (order.total_cents / 100).toFixed(2),
    totalCents: order.total_cents,
    collectionPoints: order.collection_points ?? [],
    note: order.note ?? null,
    paymentRef: order.payment_ref ?? null,
    hasProof: Boolean(order.payment_proof_id),
    // The snacks are the buyer's as soon as this is set — verification happens
    // afterwards and does not gate collection.
    collectNow: Boolean(order.stock_spent_at),
    verified: order.status === 'paid' || order.status === 'collected',
    reviewNote: order.review_note ?? null,
    reviewedAt: order.reviewed_at ?? null,
    expiresAt: order.expires_at,
    createdAt: order.created_at,
    items: items.map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      variant: i.variant ?? null,
      quantity: i.quantity,
      unitPrice: (i.unit_price_cents / 100).toFixed(2),
      lineTotal: (i.line_total_cents / 100).toFixed(2),
    })),
  };
}

const loadItems = (orderId) =>
  query('select * from order_items where order_id = $1 order by created_at', [orderId]);

/**
 * Place an order. The client sends item ids and quantities only — never a
 * price and never a total. Everything monetary is recomputed inside the
 * create_order SQL function under a row lock, so a tampered request just
 * produces a correctly-priced order.
 */
export async function placeOrder({ user, buyerName, note, cart }) {
  const payload = cart.map((line) => ({ item_id: line.itemId, quantity: line.quantity }));

  let order;
  try {
    order = await rpc('create_order', [
      user.id, user.telegram_id, buyerName, note ?? null, JSON.stringify(payload),
    ]);
  } catch (err) {
    const friendly = parseDbError(err);
    if (friendly) throw new OrderError(friendly.message, friendly.code, 409);
    log.error('create_order failed', { error: err.message, userId: user.id });
    throw new OrderError('Could not place that order. Please try again.', 'ORDER_FAILED', 500);
  }

  // Remember the name so the next checkout is one tap shorter.
  if (buyerName && buyerName !== user.display_name) {
    await query('update app_users set display_name = $1 where id = $2', [buyerName, user.id]);
  }

  const items = await loadItems(order.id);
  const qr = await createPaymentQr({
    amountCents: order.total_cents,
    reference: order.code,
    expiresAt: new Date(order.expires_at),
  });

  log.info('Order placed', { code: order.code, total: order.total_cents, user: user.telegram_id });
  return { order: toPublicOrder(order, items), payment: qr };
}

export async function getOrder(orderId, { userId = null } = {}) {
  const order = userId
    ? await one(`select ${ORDER_COLUMNS} from orders where id = $1 and user_id = $2`, [orderId, userId])
    : await one(`select ${ORDER_COLUMNS} from orders where id = $1`, [orderId]);
  if (!order) throw new OrderError('Order not found.', 'ORDER_NOT_FOUND', 404);
  return toPublicOrder(order, await loadItems(order.id));
}

/** The order plus a fresh payment QR — used by the "pay now" screen. */
export async function getOrderWithPayment(orderId, { userId = null } = {}) {
  const order = await getOrder(orderId, { userId });
  const payment = await createPaymentQr({
    amountCents: order.totalCents,
    reference: order.code,
    expiresAt: new Date(order.expiresAt),
  });
  return { order, payment };
}

export async function listUserOrders(userId, { limit = 25 } = {}) {
  const orders = await query(
    `select ${ORDER_COLUMNS} from orders where user_id = $1
     order by created_at desc limit $2`,
    [userId, limit]
  );
  if (orders.length === 0) return [];

  const items = await query(
    'select * from order_items where order_id = any($1::uuid[])',
    [orders.map((o) => o.id)]
  );
  return orders.map((o) => toPublicOrder(o, items.filter((i) => i.order_id === o.id)));
}

/**
 * Store the uploaded PayNow screenshot and move the order into the review
 * queue. Only the order's own owner may do this, and only while it is still
 * waiting — an approved order can never be re-opened by the buyer.
 *
 * The insert and the status change go in one transaction so an order can
 * never end up flagged as having a proof that was not actually stored.
 */
export async function attachPaymentProof({ orderId, user, bytes, mimeType, paymentRef }) {
  const order = await one(
    `select ${ORDER_COLUMNS} from orders where id = $1 and user_id = $2`,
    [orderId, user.id]
  );
  if (!order) throw new OrderError('Order not found.', 'ORDER_NOT_FOUND', 404);
  if (!['awaiting_payment', 'pending_review', 'rejected'].includes(order.status)) {
    throw new OrderError('That order is not waiting for payment.', 'ORDER_NOT_PAYABLE', 409);
  }

  let updated;
  try {
    updated = await transaction(async (client) => {
      // Rejecting an order put its stock back on the shelf, so a second
      // screenshot has to take it off again. Without this the order rejoins
      // the review queue holding nothing, and approving it would sell packets
      // that somebody else has bought in the meantime.
      await client.query('select rehold_order_stock($1)', [order.id]);

      const { rows: [proof] } = await client.query(
        `insert into payment_proofs(order_id, mime_type, byte_size, bytes, uploaded_by)
         values ($1, $2, $3, $4, $5) returning id`,
        [order.id, mimeType, bytes.length, bytes, user.id]
      );

      // Replacing a rejected order's proof: drop the previous image.
      if (order.payment_proof_id) {
        await client.query('delete from payment_proofs where id = $1', [order.payment_proof_id]);
      }

      // The buyer collects now rather than waiting for an admin, so this is
      // the moment the packets leave the shelf. Debiting here — not at
      // approval — keeps the stock count matching what is physically there,
      // which is what everyone else's availability is computed from.
      await client.query('select settle_order_stock($1, $2)', [order.id, user.id]);

      const { rows: [row] } = await client.query(
        `update orders
            set payment_proof_id = $1, payment_ref = $2,
                status = 'pending_review', review_note = null
          where id = $3
          returning ${ORDER_COLUMNS}`,
        [proof.id, paymentRef ?? order.code, order.id]
      );
      return row;
    });
  } catch (err) {
    const friendly = parseDbError(err);
    if (friendly) throw new OrderError(friendly.message, friendly.code, 409);
    throw err;
  }

  log.info('Payment proof attached', { code: updated.code, bytes: bytes.length });
  return toPublicOrder(updated, await loadItems(updated.id));
}

/** Stream one screenshot back to an admin. Returns null when there is none. */
export async function getProof(orderId) {
  return one(
    `select p.bytes, p.mime_type, p.byte_size
       from payment_proofs p
       join orders o on o.payment_proof_id = p.id
      where o.id = $1`,
    [orderId]
  );
}

/** Buyer-initiated cancel, only while nothing has been reviewed yet. */
export async function cancelOrder({ orderId, user }) {
  const order = await one(
    'select id, status, stock_spent_at from orders where id = $1 and user_id = $2',
    [orderId, user.id]
  );
  if (!order) throw new OrderError('Order not found.', 'ORDER_NOT_FOUND', 404);

  // Only before the snacks have been taken. Once a screenshot is up the buyer
  // has collected, so cancelling would hand back stock that is already gone
  // and quietly erase what they owe.
  if (order.status !== 'awaiting_payment' || order.stock_spent_at) {
    throw new OrderError(
      'That order can no longer be cancelled — the items have been collected.',
      'ORDER_NOT_CANCELLABLE', 409
    );
  }

  try {
    await rpc('release_order', [orderId, user.id, 'cancelled', 'Cancelled by buyer']);
  } catch (err) {
    const friendly = parseDbError(err);
    throw new OrderError(
      friendly?.message ?? 'Could not cancel that order.',
      friendly?.code ?? 'CANCEL_FAILED', 409
    );
  }
  return getOrder(orderId, { userId: user.id });
}

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------

export async function listOrders({ status = null, limit = 60 } = {}) {
  const orders = status
    ? await query(
        `select ${ORDER_COLUMNS} from orders where status = $1
         order by created_at desc limit $2`, [status, limit])
    : await query(
        `select ${ORDER_COLUMNS} from orders order by created_at desc limit $1`, [limit]);

  if (orders.length === 0) return [];

  const ids = orders.map((o) => o.id);
  const [items, users] = await Promise.all([
    query('select * from order_items where order_id = any($1::uuid[])', [ids]),
    query(
      `select id, telegram_id, username, first_name, last_name
         from app_users where id = any($1::uuid[])`,
      [[...new Set(orders.map((o) => o.user_id))]]
    ),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));

  return orders.map((o) => ({
    ...toPublicOrder(o, items.filter((i) => i.order_id === o.id)),
    telegramId: String(o.telegram_id),
    username: userById.get(o.user_id)?.username ?? null,
  }));
}

/** Push a paid order into the Google Sheet. Never blocks the approval itself. */
async function collateToSheets(order, admin) {
  const [items, buyer] = await Promise.all([
    query(
      `select oi.*, c.name as category_name
         from order_items oi
         left join items i on i.id = oi.item_id
         left join categories c on c.id = i.category_id
        where oi.order_id = $1`,
      [order.id]
    ),
    one('select username from app_users where id = $1', [order.user_id]),
  ]);

  const ok = await sheets.recordOrder({
    order: {
      ...order,
      reviewer_name: admin
        ? [admin.first_name, admin.last_name].filter(Boolean).join(' ') || admin.username
        : '',
    },
    items,
    user: buyer,
  });

  if (ok) {
    await query('update orders set sheet_synced_at = now() where id = $1', [order.id]);
  }
  return ok;
}

export async function approveOrder({ orderId, admin, note }) {
  let order;
  try {
    order = await rpc('approve_order', [orderId, admin.id, note ?? null]);
  } catch (err) {
    const friendly = parseDbError(err);
    throw new OrderError(
      friendly?.message ?? 'Could not approve that order.',
      friendly?.code ?? 'APPROVE_FAILED', 409
    );
  }

  log.info('Order approved', { code: order.code, admin: admin.telegram_id });
  await collateToSheets(order, admin);
  return toPublicOrder(order, await loadItems(order.id));
}

export async function rejectOrder({ orderId, admin, note, status = 'rejected' }) {
  let order;
  try {
    order = await rpc('release_order', [orderId, admin.id, status, note ?? null]);
  } catch (err) {
    const friendly = parseDbError(err);
    throw new OrderError(
      friendly?.message ?? 'Could not reject that order.',
      friendly?.code ?? 'REJECT_FAILED', 409
    );
  }
  log.info('Order rejected', { code: order.code, admin: admin.telegram_id, status });
  return toPublicOrder(order, await loadItems(order.id));
}

/** Mark a paid order as handed over at the collection point. */
export async function markCollected({ orderId, admin }) {
  const order = await one('select id, status from orders where id = $1', [orderId]);
  if (!order) throw new OrderError('Order not found.', 'ORDER_NOT_FOUND', 404);
  if (order.status !== 'paid') {
    throw new OrderError('Only a paid order can be collected.', 'NOT_PAID', 409);
  }

  const updated = await one(
    `update orders set status = 'collected', reviewed_by = $1, reviewed_at = now()
      where id = $2 returning ${ORDER_COLUMNS}`,
    [admin.id, orderId]
  );

  await sheets.updateOrderStatus(updated);
  return toPublicOrder(updated, await loadItems(updated.id));
}

/** Counts for the admin dashboard, in one round trip. */
export async function getStats() {
  const row = await one(`
    select
      count(*) filter (where status = 'pending_review')                as pending_review,
      count(*) filter (where status = 'paid')                          as awaiting_collection,
      count(*) filter (where created_at > now() - interval '24 hours') as orders_last_24h,
      coalesce(sum(total_cents) filter (where status in ('paid','collected')), 0) as revenue_cents
    from orders
  `);

  return {
    pendingReview: Number(row?.pending_review ?? 0),
    awaitingCollection: Number(row?.awaiting_collection ?? 0),
    ordersLast24h: Number(row?.orders_last_24h ?? 0),
    revenue: (Number(row?.revenue_cents ?? 0) / 100).toFixed(2),
  };
}

/** Release stock held by orders nobody ever paid for. */
export async function expireStaleOrders() {
  try {
    const row = await one('select expire_stale_orders() as n');
    const n = Number(row?.n ?? 0);
    if (n > 0) log.info('Expired stale orders', { count: n });
    return n;
  } catch (err) {
    log.error('expire_stale_orders failed', { error: err.message });
    return 0;
  }
}

/** Drop screenshots for long-settled orders so the disk does not fill. */
export async function pruneOldProofs(days = 60) {
  try {
    const row = await one('select prune_old_proofs($1) as n', [days]);
    const n = Number(row?.n ?? 0);
    if (n > 0) log.info('Pruned old payment proofs', { count: n });
    return n;
  } catch (err) {
    log.error('prune_old_proofs failed', { error: err.message });
    return 0;
  }
}

export default {
  placeOrder, getOrder, getOrderWithPayment, listUserOrders, attachPaymentProof,
  getProof, cancelOrder, listOrders, approveOrder, rejectOrder, markCollected,
  getStats, expireStaleOrders, pruneOldProofs, OrderError,
};
