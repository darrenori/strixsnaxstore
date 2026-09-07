/**
 * App state. Deliberately tiny: a plain object plus a subscriber list is far
 * easier to reason about than a framework for a shop with five screens.
 *
 * The cart holds item ids and quantities only. Prices shown here are for the
 * shopper's benefit; the server re-derives every cent at checkout.
 */
const CART_KEY = 'strix.cart.v1';
const NAME_KEY = 'strix.name.v1';

const listeners = new Set();

export const state = {
  me: null,
  catalog: null,
  store: null,
  cart: loadCart(),
  buyerName: localStorage.getItem(NAME_KEY) ?? '',
  route: { name: 'shop', params: {} },
  kind: 'snack',
  adminTab: 'queue',
  pendingCount: 0,
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

export function emit() {
  for (const fn of listeners) fn(state);
}

// --- cart -------------------------------------------------------------------

export function cartQty(itemId) {
  return state.cart[itemId] ?? 0;
}

export function setQty(itemId, qty) {
  const next = Math.max(0, Math.min(99, Math.floor(qty)));
  if (next === 0) delete state.cart[itemId];
  else state.cart[itemId] = next;
  persistCart();
  emit();
}

export function addToCart(itemId, delta = 1) {
  setQty(itemId, cartQty(itemId) + delta);
}

export function clearCart() {
  state.cart = {};
  persistCart();
  emit();
}

export function cartCount() {
  return Object.values(state.cart).reduce((sum, q) => sum + q, 0);
}

/** Join cart ids against the loaded catalog, dropping anything now unavailable. */
export function cartLines() {
  const items = allItems();
  const byId = new Map(items.map((i) => [i.id, i]));
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
 * Trim the cart to what is actually purchasable — an item may have sold out
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
  if (changed) { persistCart(); emit(); }
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
  emit();
}

export default state;
