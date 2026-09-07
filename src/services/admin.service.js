import { supabase, unwrap, parseRpcError } from '../lib/supabase.js';
import * as sheets from '../lib/sheets.js';
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

// ---------------------------------------------------------------------------
// Stock taking
// ---------------------------------------------------------------------------

/** Set an absolute count — what a physical stock-take actually produces. */
export async function setStock({ itemId, admin, count, note }) {
  const { data, error } = await supabase.rpc('set_stock', {
    p_item_id: itemId,
    p_admin_id: admin.id,
    p_count: count,
    p_note: note ?? 'Stock take',
  });
  if (error) {
    const friendly = parseRpcError(error);
    throw new AdminError(friendly?.message ?? 'Could not update stock.', friendly?.code ?? 'STOCK_FAILED', 400);
  }
  const item = Array.isArray(data) ? data[0] : data;

  await sheets.recordStockMovement({
    sku: item.sku, item_name: [item.name, item.variant].filter(Boolean).join(' — '),
    delta: 0, balance_after: item.stock, reason: 'correction',
    actor_name: adminName(admin), note: note ?? 'Stock take',
  });

  log.info('Stock set', { sku: item.sku, count, admin: admin.telegram_id });
  return item;
}

/** Relative change — restocking a box of 24, or writing off a spoiled one. */
export async function adjustStock({ itemId, admin, delta, reason = 'manual_adjust', note }) {
  const { data, error } = await supabase.rpc('adjust_stock', {
    p_item_id: itemId,
    p_admin_id: admin.id,
    p_delta: delta,
    p_reason: reason,
    p_note: note ?? null,
  });
  if (error) {
    const friendly = parseRpcError(error);
    throw new AdminError(friendly?.message ?? 'Could not adjust stock.', friendly?.code ?? 'STOCK_FAILED', 400);
  }
  const item = Array.isArray(data) ? data[0] : data;

  await sheets.recordStockMovement({
    sku: item.sku, item_name: [item.name, item.variant].filter(Boolean).join(' — '),
    delta, balance_after: item.stock, reason,
    actor_name: adminName(admin), note: note ?? '',
  });

  log.info('Stock adjusted', { sku: item.sku, delta, admin: admin.telegram_id });
  return item;
}

/** Apply a whole stock-take sheet in one go. */
export async function bulkSetStock({ admin, entries }) {
  const results = [];
  for (const entry of entries) {
    try {
      results.push({ itemId: entry.itemId, ok: true, item: await setStock({ ...entry, admin }) });
    } catch (err) {
      results.push({ itemId: entry.itemId, ok: false, error: err.message });
    }
  }
  return results;
}

export async function listStockMovements({ itemId = null, limit = 50 } = {}) {
  let query = supabase
    .from('stock_movements')
    .select('id, delta, balance_after, reason, note, created_at, item_id, order_id, actor_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (itemId) query = query.eq('item_id', itemId);

  const rows = unwrap(await query, 'list stock movements');
  if (rows.length === 0) return [];

  const [items, actors, orders] = await Promise.all([
    supabase.from('items').select('id, sku, name, variant').in('id', [...new Set(rows.map((r) => r.item_id))]),
    supabase.from('app_users').select('id, username, first_name, last_name')
      .in('id', [...new Set(rows.map((r) => r.actor_id).filter(Boolean))].length
        ? [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] : ['00000000-0000-0000-0000-000000000000']),
    supabase.from('orders').select('id, code')
      .in('id', [...new Set(rows.map((r) => r.order_id).filter(Boolean))].length
        ? [...new Set(rows.map((r) => r.order_id).filter(Boolean))] : ['00000000-0000-0000-0000-000000000000']),
  ]);

  const itemById  = new Map(unwrap(items, 'movement items').map((i) => [i.id, i]));
  const actorById = new Map(unwrap(actors, 'movement actors').map((a) => [a.id, a]));
  const orderById = new Map(unwrap(orders, 'movement orders').map((o) => [o.id, o]));

  return rows.map((r) => {
    const item = itemById.get(r.item_id);
    return {
      id: r.id,
      delta: r.delta,
      balanceAfter: r.balance_after,
      reason: r.reason,
      note: r.note,
      createdAt: r.created_at,
      sku: item?.sku ?? '',
      itemName: item ? [item.name, item.variant].filter(Boolean).join(' — ') : 'Deleted item',
      orderCode: orderById.get(r.order_id)?.code ?? null,
      actor: actorById.get(r.actor_id) ? adminName(actorById.get(r.actor_id)) : 'system',
    };
  });
}

// ---------------------------------------------------------------------------
// Item + category management
// ---------------------------------------------------------------------------

/** Derive a stable SKU from a name/variant, e.g. "Hello Panda"/"Milk" -> HP-MILK. */
function suggestSku(name, variant) {
  const initials = String(name).trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  const tail = String(variant || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14);
  return `${initials || 'ITEM'}-${tail || 'X'}`;
}

export async function createItem({ admin, payload }) {
  const category = unwrap(
    await supabase.from('categories').select('id').eq('id', payload.categoryId).maybeSingle(),
    'check category'
  );
  if (!category) throw new AdminError('Pick a valid category.', 'BAD_CATEGORY', 400);

  let sku = (payload.sku || suggestSku(payload.name, payload.variant)).toUpperCase();
  const clash = unwrap(await supabase.from('items').select('id').eq('sku', sku).maybeSingle(), 'sku check');
  if (clash) sku = `${sku}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

  const item = unwrap(
    await supabase.from('items').insert({
      category_id: payload.categoryId,
      sku,
      name: payload.name,
      variant: payload.variant || null,
      description: payload.description || null,
      price_cents: payload.priceCents,
      emoji: payload.emoji || null,
      image_url: payload.imageUrl || null,
      is_special: Boolean(payload.isSpecial),
      is_top_pick: Boolean(payload.isTopPick),
      is_active: payload.isActive !== false,
      stock: payload.stock ?? 0,
      low_stock_at: payload.lowStockAt ?? 5,
      sort_order: payload.sortOrder ?? 999,
    }).select('*').single(),
    'create item'
  );

  if ((payload.stock ?? 0) > 0) {
    await supabase.from('stock_movements').insert({
      item_id: item.id, delta: payload.stock, balance_after: item.stock,
      reason: 'restock', actor_id: admin.id, note: 'Opening stock',
    });
  }

  log.info('Item created', { sku: item.sku, admin: admin.telegram_id });
  await syncCatalogToSheets();
  return item;
}

const EDITABLE = {
  name: 'name', variant: 'variant', description: 'description', emoji: 'emoji',
  imageUrl: 'image_url', isSpecial: 'is_special', isTopPick: 'is_top_pick',
  isActive: 'is_active', lowStockAt: 'low_stock_at', sortOrder: 'sort_order',
  priceCents: 'price_cents', categoryId: 'category_id',
};

/**
 * Update an item. Note `stock` is deliberately not editable here — it can only
 * move through setStock/adjustStock so that every change lands in the ledger.
 */
export async function updateItem({ admin, itemId, patch }) {
  const update = {};
  for (const [key, column] of Object.entries(EDITABLE)) {
    if (patch[key] !== undefined) update[column] = patch[key];
  }
  if (Object.keys(update).length === 0) {
    throw new AdminError('Nothing to update.', 'EMPTY_PATCH', 400);
  }

  const item = unwrap(
    await supabase.from('items').update(update).eq('id', itemId).select('*').single(),
    'update item'
  );
  log.info('Item updated', { sku: item.sku, fields: Object.keys(update), admin: admin.telegram_id });
  await syncCatalogToSheets();
  return item;
}

/**
 * Items are archived, never deleted — order history references them, and a
 * hard delete would blow a hole in past receipts.
 */
export async function archiveItem({ admin, itemId }) {
  const item = unwrap(
    await supabase.from('items').update({ is_active: false }).eq('id', itemId).select('*').single(),
    'archive item'
  );
  log.info('Item archived', { sku: item.sku, admin: admin.telegram_id });
  await syncCatalogToSheets();
  return item;
}

export async function createCategory({ admin, payload }) {
  const slug = (payload.slug || payload.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const category = unwrap(
    await supabase.from('categories').insert({
      slug,
      name: payload.name,
      kind: payload.kind,
      collection_point: payload.collectionPoint
        || (payload.kind === 'drink' ? 'Blk B Pantry' : 'Blk B Lounge'),
      tagline: payload.tagline || null,
      accent: payload.accent || 'blue',
      sort_order: payload.sortOrder ?? 999,
    }).select('*').single(),
    'create category'
  );
  log.info('Category created', { slug, admin: admin.telegram_id });
  return category;
}

// ---------------------------------------------------------------------------
// Admin roster
// ---------------------------------------------------------------------------

export async function listUsers({ adminsOnly = false, limit = 100 } = {}) {
  let query = supabase
    .from('app_users')
    .select('id, telegram_id, username, first_name, last_name, display_name, is_admin, is_blocked, orders_count, created_at, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  if (adminsOnly) query = query.eq('is_admin', true);

  return unwrap(await query, 'list users').map((u) => ({
    ...u,
    telegram_id: String(u.telegram_id),
    name: adminName(u),
  }));
}

export async function setAdmin({ admin, targetTelegramId, isAdmin }) {
  const target = unwrap(
    await supabase.from('app_users').select('*').eq('telegram_id', targetTelegramId).maybeSingle(),
    'find user'
  );
  if (!target) {
    throw new AdminError(
      'That person has not opened the store yet — ask them to press Start on the bot first.',
      'USER_NOT_FOUND', 404
    );
  }
  if (!isAdmin && target.id === admin.id) {
    throw new AdminError('You cannot remove your own admin access.', 'SELF_DEMOTE', 400);
  }

  const updated = unwrap(
    await supabase.from('app_users').update({ is_admin: isAdmin }).eq('id', target.id).select('*').single(),
    'set admin'
  );
  log.info('Admin flag changed', { target: String(targetTelegramId), isAdmin, by: admin.telegram_id });
  return { ...updated, telegram_id: String(updated.telegram_id) };
}

export async function setBlocked({ admin, targetTelegramId, isBlocked }) {
  const target = unwrap(
    await supabase.from('app_users').select('*').eq('telegram_id', targetTelegramId).maybeSingle(),
    'find user'
  );
  if (!target) throw new AdminError('No such user.', 'USER_NOT_FOUND', 404);
  if (target.id === admin.id) throw new AdminError('You cannot block yourself.', 'SELF_BLOCK', 400);
  if (target.is_admin && isBlocked) {
    throw new AdminError('Remove their admin access before blocking them.', 'BLOCK_ADMIN', 400);
  }

  const updated = unwrap(
    await supabase.from('app_users').update({ is_blocked: isBlocked }).eq('id', target.id).select('*').single(),
    'set blocked'
  );
  return { ...updated, telegram_id: String(updated.telegram_id) };
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export async function syncCatalogToSheets() {
  if (!sheets.sheetsEnabled()) return false;
  try {
    return await sheets.syncCatalog(await getCatalogForSheets());
  } catch (err) {
    log.error('Catalog sheet sync failed', { error: err.message });
    return false;
  }
}

export default {
  setStock, adjustStock, bulkSetStock, listStockMovements,
  createItem, updateItem, archiveItem, createCategory,
  listUsers, setAdmin, setBlocked, syncCatalogToSheets, AdminError,
};
