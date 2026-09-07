import { supabase, unwrap, parseRpcError } from '../lib/supabase.js';
import { createPaymentQr } from '../lib/paynow.js';
import * as sheets from '../lib/sheets.js';
import config from '../config.js';
import log from '../lib/logger.js';

export class OrderError extends Error {
  constructor(message, code = 'ORDER_ERROR', status = 400) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.status = status;
  }
}

const ORDER_FIELDS = `
  id, code, user_id, telegram_id, buyer_name, status, subtotal_cents, total_cents,
  collection_points, note, payment_proof_path, payment_ref, reviewed_by, reviewed_at,
  review_note, sheet_synced_at, expires_at, created_at, updated_at
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
    hasProof: Boolean(order.payment_proof_path),
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

async function loadItems(orderId) {
  return unwrap(
    await supabase.from('order_items').select('*').eq('order_id', orderId).order('created_at'),
    'load order items'
  );
}

/**
 * Place an order. The client sends item ids and quantities only — never a
 * price and never a total. Everything monetary is recomputed inside the
 * create_order SQL function under a row lock, so a tampered request just
 * produces a correctly-priced order.
 */
export async function placeOrder({ user, buyerName, note, cart }) {
  const payload = cart.map((line) => ({ item_id: line.itemId, quantity: line.quantity }));

  const { data, error } = await supabase.rpc('create_order', {
    p_user_id: user.id,
    p_telegram_id: user.telegram_id,
    p_buyer_name: buyerName,
    p_note: note ?? null,
    p_items: payload,
  });

  if (error) {
    const friendly = parseRpcError(error);
    if (friendly) throw new OrderError(friendly.message, friendly.code, 409);
    log.error('create_order failed', { error: error.message, userId: user.id });
    throw new OrderError('Could not place that order. Please try again.', 'ORDER_FAILED', 500);
  }

  const order = Array.isArray(data) ? data[0] : data;

  // Remember the name so the next checkout is one tap shorter.
  if (buyerName && buyerName !== user.display_name) {
    await supabase.from('app_users').update({ display_name: buyerName }).eq('id', user.id);
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
  let query = supabase.from('orders').select(ORDER_FIELDS).eq('id', orderId);
  if (userId) query = query.eq('user_id', userId);
  const order = unwrap(await query.maybeSingle(), 'load order');
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
  const orders = unwrap(
    await supabase.from('orders').select(ORDER_FIELDS)
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit),
    'list orders'
  );
  if (orders.length === 0) return [];

  const items = unwrap(
    await supabase.from('order_items').select('*').in('order_id', orders.map((o) => o.id)),
    'list order items'
  );
  return orders.map((o) => toPublicOrder(o, items.filter((i) => i.order_id === o.id)));
}

/**
 * Attach the uploaded PayNow screenshot and move the order into the review
 * queue. Only the order's own owner may do this, and only while it is still
 * waiting — an approved order can never be re-opened by the buyer.
 */
export async function attachPaymentProof({ orderId, user, storagePath, paymentRef }) {
  const order = unwrap(
    await supabase.from('orders').select(ORDER_FIELDS).eq('id', orderId).eq('user_id', user.id).maybeSingle(),
    'load order for proof'
  );
  if (!order) throw new OrderError('Order not found.', 'ORDER_NOT_FOUND', 404);
  if (!['awaiting_payment', 'pending_review', 'rejected'].includes(order.status)) {
    throw new OrderError('That order is not waiting for payment.', 'ORDER_NOT_PAYABLE', 409);
  }

  const updated = unwrap(
    await supabase.from('orders').update({
      payment_proof_path: storagePath,
      payment_ref: paymentRef ?? order.code,
      status: 'pending_review',
      review_note: null,
    }).eq('id', order.id).select(ORDER_FIELDS).single(),
    'attach proof'
  );

  log.info('Payment proof attached', { code: updated.code });
  return toPublicOrder(updated, await loadItems(updated.id));
}

/** Buyer-initiated cancel, only while nothing has been reviewed yet. */
export async function cancelOrder({ orderId, user }) {
  const order = unwrap(
    await supabase.from('orders').select('id, status').eq('id', orderId).eq('user_id', user.id).maybeSingle(),
    'load order for cancel'
  );
  if (!order) throw new OrderError('Order not found.', 'ORDER_NOT_FOUND', 404);
  if (!['awaiting_payment', 'pending_review'].includes(order.status)) {
    throw new OrderError('That order can no longer be cancelled.', 'ORDER_NOT_CANCELLABLE', 409);
  }

  const { error } = await supabase.rpc('release_order', {
    p_order_id: orderId,
    p_admin_id: user.id,
    p_status: 'cancelled',
    p_note: 'Cancelled by buyer',
  });
  if (error) {
    const friendly = parseRpcError(error);
    throw new OrderError(friendly?.message ?? 'Could not cancel that order.', friendly?.code ?? 'CANCEL_FAILED', 409);
  }
  return getOrder(orderId, { userId: user.id });
}

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------

export async function listOrders({ status = null, limit = 60 } = {}) {
  let query = supabase.from('orders').select(ORDER_FIELDS)
    .order('created_at', { ascending: false }).limit(limit);
  if (status) query = query.eq('status', status);

  const orders = unwrap(await query, 'admin list orders');
  if (orders.length === 0) return [];

  const [items, users] = await Promise.all([
    supabase.from('order_items').select('*').in('order_id', orders.map((o) => o.id)),
    supabase.from('app_users').select('id, telegram_id, username, first_name, last_name')
      .in('id', [...new Set(orders.map((o) => o.user_id))]),
  ]);
  const itemRows = unwrap(items, 'admin order items');
  const userRows = unwrap(users, 'admin order users');
  const userById = new Map(userRows.map((u) => [u.id, u]));

  return orders.map((o) => ({
    ...toPublicOrder(o, itemRows.filter((i) => i.order_id === o.id)),
    telegramId: String(o.telegram_id),
    username: userById.get(o.user_id)?.username ?? null,
    proofPath: o.payment_proof_path ?? null,
  }));
}

/** Short-lived signed URL so an admin can see the screenshot without the bucket being public. */
export async function getProofUrl(orderId, { expiresIn = 300 } = {}) {
  const order = unwrap(
    await supabase.from('orders').select('payment_proof_path').eq('id', orderId).maybeSingle(),
    'load proof path'
  );
  if (!order?.payment_proof_path) return null;

  const { data, error } = await supabase.storage
    .from(config.supabase.proofBucket)
    .createSignedUrl(order.payment_proof_path, expiresIn);
  if (error) {
    log.error('Signed URL failed', { error: error.message });
    return null;
  }
  return data.signedUrl;
}

/** Push a paid order into the Google Sheet. Never blocks the approval itself. */
async function collateToSheets(order, admin) {
  const [items, categories, buyer] = await Promise.all([
    supabase.from('order_items').select('*').eq('order_id', order.id),
    supabase.from('categories').select('id, name'),
    supabase.from('app_users').select('username').eq('id', order.user_id).maybeSingle(),
  ]);
  const itemRows = unwrap(items, 'sheet order items');
  const catRows = unwrap(categories, 'sheet categories');

  // order_items keeps a snapshot, so look the category up via the live item.
  const itemIds = [...new Set(itemRows.map((i) => i.item_id))];
  const liveItems = itemIds.length
    ? unwrap(await supabase.from('items').select('id, category_id').in('id', itemIds), 'sheet items')
    : [];
  const catById = new Map(catRows.map((c) => [c.id, c.name]));
  const catByItem = new Map(liveItems.map((i) => [i.id, catById.get(i.category_id) ?? '']));

  const ok = await sheets.recordOrder({
    order: {
      ...order,
      reviewer_name: admin ? [admin.first_name, admin.last_name].filter(Boolean).join(' ') || admin.username : '',
    },
    items: itemRows.map((i) => ({ ...i, category_name: catByItem.get(i.item_id) ?? '' })),
    user: unwrap(buyer, 'sheet buyer'),
  });

  if (ok) {
    await supabase.from('orders')
      .update({ sheet_synced_at: new Date().toISOString() })
      .eq('id', order.id);
  }
  return ok;
}

export async function approveOrder({ orderId, admin, note }) {
  const { data, error } = await supabase.rpc('approve_order', {
    p_order_id: orderId,
    p_admin_id: admin.id,
    p_note: note ?? null,
  });
  if (error) {
    const friendly = parseRpcError(error);
    throw new OrderError(friendly?.message ?? 'Could not approve that order.', friendly?.code ?? 'APPROVE_FAILED', 409);
  }

  const order = Array.isArray(data) ? data[0] : data;
  log.info('Order approved', { code: order.code, admin: admin.telegram_id });

  await collateToSheets(order, admin);
  return toPublicOrder(order, await loadItems(order.id));
}

export async function rejectOrder({ orderId, admin, note, status = 'rejected' }) {
  const { data, error } = await supabase.rpc('release_order', {
    p_order_id: orderId,
    p_admin_id: admin.id,
    p_status: status,
    p_note: note ?? null,
  });
  if (error) {
    const friendly = parseRpcError(error);
    throw new OrderError(friendly?.message ?? 'Could not reject that order.', friendly?.code ?? 'REJECT_FAILED', 409);
  }
  const order = Array.isArray(data) ? data[0] : data;
  log.info('Order rejected', { code: order.code, admin: admin.telegram_id, status });
  return toPublicOrder(order, await loadItems(order.id));
}

/** Mark a paid order as handed over at the collection point. */
export async function markCollected({ orderId, admin }) {
  const order = unwrap(
    await supabase.from('orders').select(ORDER_FIELDS).eq('id', orderId).maybeSingle(),
    'load order'
  );
  if (!order) throw new OrderError('Order not found.', 'ORDER_NOT_FOUND', 404);
  if (order.status !== 'paid') {
    throw new OrderError('Only a paid order can be collected.', 'NOT_PAID', 409);
  }

  const updated = unwrap(
    await supabase.from('orders').update({
      status: 'collected', reviewed_by: admin.id, reviewed_at: new Date().toISOString(),
    }).eq('id', orderId).select(ORDER_FIELDS).single(),
    'mark collected'
  );

  await sheets.updateOrderStatus(updated);
  return toPublicOrder(updated, await loadItems(updated.id));
}

/** Counts for the admin dashboard. */
export async function getStats() {
  const [pending, paid, today, revenue] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending_review'),
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'paid'),
    supabase.from('orders').select('id', { count: 'exact', head: true })
      .gte('created_at', new Date(Date.now() - 86400000).toISOString()),
    supabase.from('orders').select('total_cents').in('status', ['paid', 'collected']),
  ]);

  const revenueCents = (unwrap(revenue, 'revenue') ?? []).reduce((s, r) => s + r.total_cents, 0);
  return {
    pendingReview: pending.count ?? 0,
    awaitingCollection: paid.count ?? 0,
    ordersLast24h: today.count ?? 0,
    revenue: (revenueCents / 100).toFixed(2),
  };
}

/** Release stock held by orders nobody ever paid for. */
export async function expireStaleOrders() {
  const { data, error } = await supabase.rpc('expire_stale_orders');
  if (error) {
    log.error('expire_stale_orders failed', { error: error.message });
    return 0;
  }
  if (data > 0) log.info('Expired stale orders', { count: data });
  return data ?? 0;
}

export default {
  placeOrder, getOrder, getOrderWithPayment, listUserOrders, attachPaymentProof, cancelOrder,
  listOrders, getProofUrl, approveOrder, rejectOrder, markCollected, getStats, expireStaleOrders,
  OrderError,
};
