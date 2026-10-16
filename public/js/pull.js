/**
 * Pull down from the top of any screen to reload it.
 *
 * Telegram's webview has no pull-to-refresh of its own, and its swipe-down
 * gesture is switched off (see tg.ready) so a shopper cannot dismiss the store
 * mid-checkout. Without this, the only way to see a new order status or a
 * restocked item was to close the store and open it again.
 *
 * Only a pull that starts with the page already at the top counts, so normal
 * scrolling never triggers it, and nothing happens while a dialog is open or
 * while a refresh is still running.
 */

const THRESHOLD = 70;      // px of finger travel, after resistance, to trigger
const MAX_PULL = 110;      // how far the indicator follows the finger
const RESISTANCE = 0.5;    // the finger moves twice as far as the indicator

export function enablePullToRefresh(onRefresh, { haptic = () => {} } = {}) {
  const indicator = document.createElement('div');
  indicator.className = 'ptr';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<span class="ptr__icon">↓</span><span class="ptr__label">Pull to refresh</span>';
  document.body.append(indicator);
  const icon = indicator.querySelector('.ptr__icon');
  const label = indicator.querySelector('.ptr__label');

  let startX = 0;
  let startY = 0;
  let distance = 0;
  let tracking = false;     // finger down at the top, direction not yet known
  let pulling = false;      // committed to a vertical pull
  let armed = false;        // past the threshold, will refresh on release
  let refreshing = false;

  const place = (px, animate) => {
    indicator.classList.toggle('is-animating', animate);
    indicator.style.transform = `translate(-50%, ${px - 56}px)`;
    indicator.style.opacity = String(Math.min(px / THRESHOLD, 1));
  };

  const reset = () => {
    pulling = false;
    armed = false;
    distance = 0;
    place(0, true);
    indicator.classList.remove('is-armed', 'is-refreshing');
    icon.textContent = '↓';
    label.textContent = 'Pull to refresh';
  };

  const blocked = (target) =>
    refreshing
    || window.scrollY > 0
    || document.querySelector('[role="dialog"]')
    || target.closest?.('input, textarea, select, [data-no-pull]');

  window.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || blocked(e.target)) { tracking = false; return; }
    tracking = true;
    pulling = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (!pulling) {
      // Wait for a clear direction, so a sideways swipe along the category
      // pills or an upward scroll is left alone.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || window.scrollY > 0) {
        tracking = false;
        return;
      }
      pulling = true;
    }

    distance = Math.min(Math.max(dy, 0) * RESISTANCE, MAX_PULL);
    place(distance, false);
    const nowArmed = distance >= THRESHOLD;
    if (nowArmed !== armed) {
      armed = nowArmed;
      indicator.classList.toggle('is-armed', armed);
      label.textContent = armed ? 'Release to refresh' : 'Pull to refresh';
      if (armed) haptic('light');
    }
  }, { passive: true });

  const release = async () => {
    if (!tracking) return;
    tracking = false;
    if (!pulling) return;
    if (!armed) { reset(); return; }

    refreshing = true;
    indicator.classList.add('is-refreshing');
    icon.textContent = '↻';
    label.textContent = 'Refreshing…';
    place(THRESHOLD, true);
    try {
      await onRefresh();
    } finally {
      refreshing = false;
      reset();
    }
  };
  window.addEventListener('touchend', release, { passive: true });
  window.addEventListener('touchcancel', () => { tracking = false; if (!refreshing) reset(); },
    { passive: true });

  reset();
}

export default enablePullToRefresh;
