import { query, one } from '../lib/db.js';

const ITEM_FIELDS = [
  'id', 'sku', 'name', 'variant', 'description', 'price_cents', 'emoji', 'image_url',
  'is_special', 'is_top_pick', 'is_active', 'stock', 'reserved', 'low_stock_at',
  'sort_order', 'updated_at', 'category_id',
];

const ITEM_COLUMNS = ITEM_FIELDS.join(', ');
/** The same list against an aliased `items` table, for the joined queries. */
const ITEM_COLUMNS_I = ITEM_FIELDS.map((f) => `i.${f}`).join(', ');

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
  const categories = await query('select * from categories order by sort_order, name');
  const items = await query(
    `select ${ITEM_COLUMNS} from items
     ${includeInactive ? '' : 'where is_active'}
     order by sort_order, name`
  );

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

/**
 * Everything an admin needs, including hidden items and raw stock numbers.
 *
 * Ordered by category first. The admin screens group consecutive runs of the
 * same category into one card, so ordering on the item's own sort_order alone
 * interleaves two categories that happen to number their items the same way,
 * and "Hello Panda" shows up three times with one row under each heading.
 */
export async function getAdminCatalog() {
  const categories = await query('select * from categories order by sort_order, name');
  const items = await query(`
    select ${ITEM_COLUMNS_I}
      from items i
      join categories c on c.id = i.category_id
     order by c.sort_order, c.name, i.sort_order, i.name
  `);
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

/** Rows for the Google Sheets catalogue mirror, optionally limited by SKU. */
export async function getCatalogForSheets({ skus = null } = {}) {
  const wanted = skus ? [...new Set(skus.filter(Boolean))] : null;
  if (wanted?.length === 0) return [];
  const rows = await query(`
    select i.*,
           json_build_object(
             'name', c.name, 'kind', c.kind, 'collection_point', c.collection_point
           ) as category
    from items i
    join categories c on c.id = i.category_id
    ${wanted ? 'where i.sku = any($1::text[])' : ''}
    order by c.sort_order, i.sort_order
  `, wanted ? [wanted] : []);
  return rows;
}

export async function getSettings() {
  const rows = await query('select key, value from settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(key, value) {
  return one(
    `insert into settings(key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()
     returning *`,
    [key, JSON.stringify(value)]
  );
}

/** Items at or below their low-stock threshold - drives the admin alert badge. */
export async function getLowStockItems() {
  return query(`
    select ${ITEM_COLUMNS}, greatest(stock - reserved, 0) as available
    from items
    where is_active and greatest(stock - reserved, 0) <= low_stock_at
    order by available asc, name asc
  `);
}

export default {
  getCatalog, getAdminCatalog, getCatalogForSheets,
  getSettings, setSetting, getLowStockItems,
};
