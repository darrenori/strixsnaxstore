import api from './api.js';

/**
 * App state. Deliberately tiny: a plain object plus a subscriber list is far
 * easier to reason about than a framework for a shop with five screens.
 *
 * The cart holds item ids and quantities only. Prices shown here are for the
 * shopper's benefit; the server re-derives every cent at checkout.
 */
const CART_KEY = 'strix.cart.v1';
const NAME_KEY = 'strix.name.v1';
const CATALOG_KEY = 'strix.catalog.v1';

const listeners = new Set();

export const state = {
  me: null,
  catalog: null,
  store: null,
  cart: loadCart(),
  buyerName: localStorage.getItem(NAME_KEY) ?? '',
  // Kept here rather than in the DOM so that redrawing the cart cannot throw
  // away a note somebody was halfway through typing.
  orderNote: '',
  route: { name: 'shop', params: {} },
  kind: 'snack',
  adminTab: 'queue',
  pendingCount: 0,
  /** Cached admin dashboard, so switching tabs is not five fetches. */
  adminSummary: null,
  adminSummaryAt: 0,
};

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    // Drop anything malformed so a corrupted entry cannot wedge the cart.
    return Object.fromEntries(
      Object.entries(raw).filter(([, qty]) => Number.isInteger(qty) && qty > 0 && qty <= 99)
    );
  } catch {
    return {};
  }
}

function persistCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* private mode */ }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Tell the app something changed, and what.
 *
 * `detail.scope` is the whole point. A bare emit rebuilds the current screen
 * from scratch, and doing that on every tap of a quantity button is what made
 * the shop feel slow: adding one packet threw away and re-created two dozen
 * item rows, every stepper and every listener on them, then asked Telegram to
 * redraw its main button as well. A scoped emit lets the screen that is
 * already on display patch the one row that actually changed and leave the
 * rest of the DOM alone.
 */
export function emit(detail = { scope: 'all' }) {
  for (const fn of listeners) fn(detail, state);
}

// --- cart -------------------------------------------------------------------

export function cartQty(itemId) {
  return state.cart[itemId] ?? 0;
}

export function setQty(itemId, qty) {
  const next = Math.max(0, Math.min(99, Math.floor(qty)));
  const before = cartQty(itemId);
  if (next === before) return next;

  if (next === 0) delete state.cart[itemId];
  else state.cart[itemId] = next;
  persistCart();
  emit({ scope: 'cart', itemId, qty: next, before });
  return next;
}

export function addToCart(itemId, delta = 1) {
  return setQty(itemId, cartQty(itemId) + delta);
}

export function clearCart() {
  state.cart = {};
  state.orderNote = '';
  persistCart();
  emit({ scope: 'all' });
}

export function cartCount() {
  return Object.values(state.cart).reduce((sum, q) => sum + q, 0);
}

/** Join cart ids against the loaded catalog, dropping anything now unavailable. */
export function cartLines() {
  const byId = new Map(allItems().map((i) => [i.id, i]));
  return Object.entries(state.cart)
    .map(([itemId, quantity]) => {
      const item = byId.get(itemId);
      if (!item) return null;
      return { item, quantity, lineCents: item.priceCents * quantity };
    })
    .filter(Boolean);
}

export function cartTotalCents() {
  return cartLines().reduce((sum, l) => sum + l.lineCents, 0);
}

/**
 * Trim the cart to what is actually purchasable: an item may have sold out
 * or been archived while the cart sat in localStorage.
 */
export function reconcileCart() {
  const byId = new Map(allItems().map((i) => [i.id, i]));
  let changed = false;
  const removed = [];

  for (const [itemId, qty] of Object.entries(state.cart)) {
    const item = byId.get(itemId);
    if (!item || !item.inStock) {
      delete state.cart[itemId];
      changed = true;
      if (item) removed.push(item.name);
    } else if (qty > item.available) {
      state.cart[itemId] = item.available;
      changed = true;
      removed.push(`${item.name} (reduced to ${item.available})`);
    }
  }
  if (changed) { persistCart(); emit({ scope: 'all' }); }
  return removed;
}

export function allItems() {
  return (state.catalog?.categories ?? []).flatMap((c) => c.items);
}

export function setBuyerName(name) {
  state.buyerName = name;
  try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
}

export function navigate(name, params = {}) {
  state.route = { name, params };
  emit({ scope: 'route' });
}

/** Drop the cached admin dashboard so the next admin render refetches it. */
export function invalidateAdminSummary() {
  state.adminSummary = null;
  state.adminSummaryAt = 0;
}

// --- catalogue --------------------------------------------------------------

/**
 * The last catalogue this device saw.
 *
 * The shelf holds the same two dozen items from one visit to the next, so
 * making the shopper watch a splash screen while we confirm that over the
 * network buys nothing. Prices shown from cache are advisory in any case: the
 * server recomputes every cent at checkout, so a stale one cannot be paid.
 */
export function cachedCatalog() {
  try {
    const raw = JSON.parse(localStorage.getItem(CATALOG_KEY) ?? 'null');
    return raw && Array.isArray(raw.categories) ? raw : null;
  } catch {
    return null;
  }
}

export function cacheCatalog(catalog) {
  try { localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog)); } catch { /* private mode */ }
}

export function invalidateCatalogCache() {
  try { localStorage.removeItem(CATALOG_KEY); } catch { /* private mode */ }
}

/**
 * Pull the menu again and put it everywhere it is held.
 *
 * An admin who has just changed a price or counted the shelf is looking at a
 * shop tab built from the old numbers, and so is the cache behind it. Returns
 * false rather than throwing, because a failed refresh is never worth
 * interrupting whatever the caller was actually doing.
 */
export async function refreshCatalog() {
  try {
    const catalog = await api.catalog();
    state.catalog = catalog;
    state.store = catalog.store;
    cacheCatalog(catalog);
    return true;
  } catch {
    // Keep whatever is cached. A menu from ten minutes ago beats a blank
    // shop, and the server re-prices everything at checkout anyway.
    return false;
  }
}

export default state;
