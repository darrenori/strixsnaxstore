import { query, one, rpc, parseDbError } from '../lib/db.js';
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

function toAdminError(err, fallback) {
  const friendly = parseDbError(err);
  return new AdminError(friendly?.message ?? fallback, friendly?.code ?? 'DB_ERROR', 400);
}

// ---------------------------------------------------------------------------
// Stock taking
// ---------------------------------------------------------------------------

/** Set an absolute count — what a physical stock-take actually produces. */
export async function setStock({ itemId, admin, count, note }) {
  let item;
  try {
    item = await rpc('set_stock', [itemId, admin.id, count, note ?? 'Stock take']);
  } catch (err) {
    throw toAdminError(err, 'Could not update stock.');
  }

  await sheets.recordStockMovement({
    sku: item.sku,
    item_name: [item.name, item.variant].filter(Boolean).join(' — '),
    delta: 0, balance_after: item.stock, reason: 'correction',
    actor_name: adminName(admin), note: note ?? 'Stock take',
  });

  log.info('Stock set', { sku: item.sku, count, admin: admin.telegram_id });
  return item;
}

/** Relative change — restocking a box of 24, or writing off a spoiled one. */
export async function adjustStock({ itemId, admin, delta, reason = 'manual_adjust', note }) {
  let item;
  try {
    item = await rpc('adjust_stock', [itemId, admin.id, delta, reason, note ?? null]);
  } catch (err) {
    throw toAdminError(err, 'Could not adjust stock.');
  }

  await sheets.recordStockMovement({
    sku: item.sku,
    item_name: [item.name, item.variant].filter(Boolean).join(' — '),
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
    itemName: r.name ? [r.name, r.variant].filter(Boolean).join(' — ') : 'Deleted item',
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
  await syncCatalogToSheets();
  return item;
}

/**
 * Items are archived, never deleted — order history references them, and a
 * hard delete would blow a hole in past receipts.
 */
export async function archiveItem({ admin, itemId }) {
  const item = await one('update items set is_active = false where id = $1 returning *', [itemId]);
  if (!item) throw new AdminError('No such item.', 'ITEM_NOT_FOUND', 404);
  log.info('Item archived', { sku: item.sku, admin: admin.telegram_id });
  await syncCatalogToSheets();
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
      'That person has not opened the store yet — ask them to press Start on the bot first.',
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
