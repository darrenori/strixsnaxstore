/**
 * Thin wrapper over the Telegram Mini App SDK.
 *
 * Everything here degrades to something sensible in a plain browser, so the
 * app can be developed and tested outside Telegram — the API will simply
 * reject the calls, which is exactly the behaviour we want.
 */
export const tg = window.Telegram?.WebApp ?? null;

export const inTelegram = Boolean(tg?.initData);

/** The poster's cream. Everything else is drawn on top of it. */
const GROUND = '#fbf4d4';

export function ready() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  // Stop a downward swipe from dismissing the app mid-checkout.
  tg.disableVerticalSwipes?.();
  tg.setHeaderColor?.(GROUND);
  tg.setBackgroundColor?.(GROUND);
  // 7.10+ draws a separate strip behind the nav bar; unset it stays theme-dark.
  tg.setBottomBarColor?.(GROUND);
}

export function initData() {
  return tg?.initData ?? '';
}

export function user() {
  return tg?.initDataUnsafe?.user ?? null;
}

/**
 * The store is a printed poster — cream ground, red badge, gold lettering —
 * and that identity does not survive being recoloured. Rendered dark it reads
 * as some other shop, so the app stays light whatever the client is set to,
 * and asks Telegram to bring its own chrome to match rather than the reverse.
 */
export function applyTheme() {
  document.documentElement.dataset.theme = 'light';
  tg?.setHeaderColor?.(GROUND);
  tg?.setBackgroundColor?.(GROUND);
  tg?.setBottomBarColor?.(GROUND);
}

export function haptic(type = 'light') {
  const h = tg?.HapticFeedback;
  if (!h) return;
  if (['error', 'success', 'warning'].includes(type)) h.notificationOccurred(type);
  else if (type === 'select') h.selectionChanged();
  else h.impactOccurred(type);
}

/** Telegram's native alert, falling back to the browser's. */
export function alert(message) {
  return new Promise((resolve) => {
    if (tg?.showAlert) tg.showAlert(message, resolve);
    else { window.alert(message); resolve(); }
  });
}

export function confirm(message) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(message, (ok) => resolve(Boolean(ok)));
    else resolve(window.confirm(message));
  });
}

// --- Main button ------------------------------------------------------------
let mainHandler = null;

export function showMainButton(text, handler, { color = '#e03c31', textColor = '#fbf4d4' } = {}) {
  if (!tg?.MainButton) return;
  if (mainHandler) tg.MainButton.offClick(mainHandler);
  mainHandler = handler;
  tg.MainButton.setParams({ text, color, text_color: textColor, is_active: true, is_visible: true });
  tg.MainButton.onClick(mainHandler);
}

export function hideMainButton() {
  if (!tg?.MainButton) return;
  if (mainHandler) tg.MainButton.offClick(mainHandler);
  mainHandler = null;
  tg.MainButton.hide();
}

export function mainButtonBusy(busy) {
  if (!tg?.MainButton) return;
  if (busy) { tg.MainButton.showProgress(true); tg.MainButton.disable(); }
  else { tg.MainButton.hideProgress(); tg.MainButton.enable(); }
}

// --- Back button ------------------------------------------------------------
let backHandler = null;

export function showBackButton(handler) {
  if (!tg?.BackButton) return false;
  if (backHandler) tg.BackButton.offClick(backHandler);
  backHandler = handler;
  tg.BackButton.onClick(backHandler);
  tg.BackButton.show();
  return true;
}

export function hideBackButton() {
  if (!tg?.BackButton) return;
  if (backHandler) tg.BackButton.offClick(backHandler);
  backHandler = null;
  tg.BackButton.hide();
}

export default { tg, inTelegram, ready, initData, user, applyTheme, haptic, alert, confirm };
