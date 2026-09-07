import { supabase, unwrap } from '../lib/supabase.js';

const ITEM_FIELDS = `
  id, sku, name, variant, description, price_cents, emoji, image_url,
  is_special, is_top_pick, is_active, stock, reserved, low_stock_at, sort_order,
  updated_at, category_id
`;

/** Shape a DB row for the Mini App. Stock is exposed as a coarse signal only. */
function toPublicItem(row, category) {
  const available = Math.max((row.stock ?? 0) - (row.reserved ?? 0), 0);
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    variant: row.variant || null,
    description: row.description || null,
    priceCents: row.price_cents,
    price: (row.price_cents / 100).toFixed(2),
    emoji: row.emoji || null,
    imageUrl: row.image_url || null,
    isSpecial: row.is_special,
    isTopPick: row.is_top_pick,
    available,
    inStock: available > 0,
    isLow: available > 0 && available <= (row.low_stock_at ?? 0),
    categoryId: row.category_id,
    categorySlug: category?.slug ?? null,
    categoryName: category?.name ?? null,
    kind: category?.kind ?? 'snack',
    collectionPoint: category?.collection_point ?? null,
  };
}

/** Full catalogue grouped by category, ready to render. */
export async function getCatalog({ includeInactive = false } = {}) {
  const categories = unwrap(
    await supabase.from('categories').select('*').order('sort_order'),
    'load categories'
  );

  let query = supabase.from('items').select(ITEM_FIELDS).order('sort_order');
  if (!includeInactive) query = query.eq('is_active', true);
  const items = unwrap(await query, 'load items');

  const byId = new Map(categories.map((c) => [c.id, c]));

  const grouped = categories.map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    kind: category.kind,
    tagline: category.tagline,
    accent: category.accent,
    collectionPoint: category.collection_point,
    items: items
      .filter((i) => i.category_id === category.id)
      .map((i) => toPublicItem(i, category)),
  }));

  return {
    categories: grouped.filter((c) => c.items.length > 0),
    specials: items.filter((i) => i.is_special).map((i) => toPublicItem(i, byId.get(i.category_id))),
  };
}

/** Everything an admin needs, including hidden items and raw stock numbers. */
export async function getAdminCatalog() {
  const categories = unwrap(
    await supabase.from('categories').select('*').order('sort_order'),
    'load categories'
  );
  const items = unwrap(
    await supabase.from('items').select(ITEM_FIELDS).order('sort_order'),
    'load items'
  );
  const byId = new Map(categories.map((c) => [c.id, c]));

  return {
    categories: categories.map((c) => ({
      id: c.id, slug: c.slug, name: c.name, kind: c.kind,
      collectionPoint: c.collection_point, accent: c.accent, sortOrder: c.sort_order,
    })),
    items: items.map((row) => {
      const category = byId.get(row.category_id);
      return {
        ...toPublicItem(row, category),
        stock: row.stock,
        reserved: row.reserved,
        lowStockAt: row.low_stock_at,
        isActive: row.is_active,
        sortOrder: row.sort_order,
        updatedAt: row.updated_at,
      };
    }),
  };
}

/** Rows for the Google Sheets catalogue mirror. */
export async function getCatalogForSheets() {
  const categories = unwrap(await supabase.from('categories').select('*'), 'load categories');
  const items = unwrap(await supabase.from('items').select('*').order('sort_order'), 'load items');
  const byId = new Map(categories.map((c) => [c.id, c]));
  return items.map((i) => ({ ...i, category: byId.get(i.category_id) ?? null }));
}

export async function getSettings() {
  const rows = unwrap(await supabase.from('settings').select('*'), 'load settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(key, value) {
  return unwrap(
    await supabase.from('settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      .select('*').single(),
    'save setting'
  );
}

/** Items at or below their low-stock threshold — drives the admin alert badge. */
export async function getLowStockItems() {
  const items = unwrap(
    await supabase.from('items').select(ITEM_FIELDS).eq('is_active', true),
    'load items'
  );
  return items
    .map((i) => ({ ...i, available: Math.max((i.stock ?? 0) - (i.reserved ?? 0), 0) }))
    .filter((i) => i.available <= (i.low_stock_at ?? 0))
    .sort((a, b) => a.available - b.available);
}

export default { getCatalog, getAdminCatalog, getCatalogForSheets, getSettings, setSetting, getLowStockItems };
