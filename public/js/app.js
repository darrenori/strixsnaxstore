import * as tg from './tg.js';
import api from './api.js';
import { state, subscribe, emit, navigate, cartCount, reconcileCart } from './store.js';
import { toast, el } from './ui.js';
import renderShop from './views/shop.js';
import renderCart from './views/cart.js';
import renderPayment, { stopCountdown } from './views/payment.js';
import renderOrders from './views/orders.js';
import renderAdmin from './views/admin.js';

const viewRoot = document.getElementById('view');
const splash = document.getElementById('splash');

/**
 * Where "back" goes from each screen. Telegram shows its own back button, so
 * the app needs to agree with it rather than fight it.
 */
const BACK_TO = {
  cart: 'shop',
  payment: 'orders',
  orders: 'shop',
  admin: 'shop',
};

function currentView() {
  switch (state.route.name) {
    case 'cart':    return renderCart();
    case 'payment': return renderPayment(state.route.params);
    case 'orders':  return renderOrders();
    case 'admin':   return renderAdmin();
    case 'shop':
    default:        return renderShop();
  }
}

let lastRouteKey = '';

function render() {
  const routeKey = `${state.route.name}:${JSON.stringify(state.route.params ?? {})}`;
  const routeChanged = routeKey !== lastRouteKey;

  // The payment screen owns a live countdown; tear it down before we replace it.
  if (routeChanged) stopCountdown();

  viewRoot.replaceChildren(currentView());
  if (routeChanged) {
    viewRoot.scrollTop = 0;
    window.scrollTo({ top: 0 });
    lastRouteKey = routeKey;
  }

  paintChrome();
}

function paintChrome() {
  // --- cart badge ----------------------------------------------------------
  const count = cartCount();
  const badge = document.getElementById('cartCount');
  badge.textContent = String(count);
  badge.hidden = count === 0;

  // --- bottom tabs ---------------------------------------------------------
  const activeTab = ['shop', 'cart', 'payment'].includes(state.route.name)
    ? 'shop'
    : state.route.name;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === activeTab);
  }

  const adminTab = document.querySelector('.tab[data-tab="admin"]');
  if (adminTab) adminTab.hidden = !state.me?.isAdmin;

  // --- back button ---------------------------------------------------------
  const target = BACK_TO[state.route.name];
  const fallbackBack = document.getElementById('backBtn');

  if (target) {
    const goBack = () => navigate(target);
    // Prefer Telegram's native back button; fall back to our own chevron.
    if (tg.showBackButton(goBack)) fallbackBack.hidden = true;
    else { fallbackBack.hidden = false; fallbackBack.onclick = goBack; }
  } else {
    tg.hideBackButton();
    fallbackBack.hidden = true;
  }

  // --- Telegram main button ------------------------------------------------
  // The cart screen has its own in-page submit, so the main button is only
  // used as a shortcut into the cart from the shop.
  if (state.route.name === 'shop' && count > 0) {
    tg.showMainButton(`VIEW CART · ${count} ITEM${count > 1 ? 'S' : ''}`, () => navigate('cart'));
  } else {
    tg.hideMainButton();
  }
}

// ---------------------------------------------------------------------------
// Chrome event wiring
// ---------------------------------------------------------------------------
document.getElementById('cartBtn').addEventListener('click', () => {
  tg.haptic('light');
  navigate('cart');
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    tg.haptic('select');
    navigate(tab.dataset.tab);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  tg.ready();
  tg.applyTheme();
  tg.tg?.onEvent?.('themeChanged', tg.applyTheme);

  subscribe(render);

  try {
    const [me, catalog] = await Promise.all([api.me(), api.catalog()]);
    state.me = me;
    state.catalog = catalog;
    state.store = catalog.store;
    if (!state.buyerName) state.buyerName = me.displayName ?? me.firstName ?? '';

    const dropped = reconcileCart();
    if (dropped.length) {
      toast(`Some items changed: ${dropped.join(', ')}`, 'error');
    }

    document.getElementById('app').hidden = false;
    splash.classList.add('is-gone');
    setTimeout(() => splash.remove(), 320);

    // Deep link: /start with a payload, e.g. an order code from a bot message.
    const startParam = tg.tg?.initDataUnsafe?.start_param;
    if (startParam === 'orders') navigate('orders');
    else if (startParam === 'admin' && me.isAdmin) navigate('admin');
    else emit();

    if (me.isAdmin) refreshAdminBadge();
  } catch (err) {
    showBootError(err);
  }
}

/** Keep the ☰ badge honest without polling hard. */
async function refreshAdminBadge() {
  try {
    const summary = await api.adminSummary();
    const badge = document.getElementById('adminBadge');
    if (badge) {
      badge.textContent = String(summary.stats.pendingReview);
      badge.hidden = summary.stats.pendingReview === 0;
    }
  } catch { /* the admin tab will surface any real problem */ }
}

function showBootError(err) {
  const outsideTelegram = !tg.inTelegram;
  splash.replaceChildren(
    el('div', { class: 'badge badge--lg' },
      el('span', { class: 'badge__ay' }, 'AY2026/2027'),
      el('span', { class: 'badge__word' }, 'STRIX'),
      el('span', { class: 'badge__script' }, 'Snax Store')
    ),
    el('div', { class: 'card', style: 'max-width:340px;margin-top:22px;' },
      el('h2', { class: 'card__title' }, outsideTelegram ? 'Open me in Telegram' : 'Could not start'),
      el('p', { class: 'muted' },
        outsideTelegram
          ? 'This store runs inside Telegram so it can verify who you are. Search for the STRIX Snax Store bot and press Start.'
          : err.message),
      !outsideTelegram
        ? el('button', {
            class: 'btn mt', type: 'button',
            onClick: () => window.location.reload(),
          }, 'TRY AGAIN')
        : null
    )
  );
}

// Refresh the catalogue when the app comes back to the foreground, so a
// shopper who left the tab open does not add something that sold out.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.catalog) return;
  try {
    const catalog = await api.catalog();
    state.catalog = catalog;
    state.store = catalog.store;
    reconcileCart();
    emit();
    if (state.me?.isAdmin) refreshAdminBadge();
  } catch { /* offline; keep what we have */ }
});

boot();
