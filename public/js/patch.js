/**
 * How a screen absorbs a change instead of being rebuilt.
 *
 * The shop and the cart both show quantities, and both are told about every
 * quantity change. Rebuilding either from scratch for one tap of "+" is what
 * made the app feel slow: two dozen item rows and all their listeners thrown
 * away and re-created, plus a round trip over Telegram's bridge to redraw the
 * main button, for a number that went from 1 to 2.
 *
 * So a view registers a patcher while it renders. If the patcher says it
 * handled the change, the app leaves the DOM alone; if not, the ordinary full
 * redraw happens and nothing is lost.
 *
 * It lives in its own module because both the app shell and the views need it,
 * and importing the shell from a view it renders would be a cycle.
 */

let handler = null;

/** Called by a view as it renders. Passing null means "redraw me instead". */
export function onCartChange(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

/** Called by the shell. True when the view dealt with it. */
export function applyCartChange(detail) {
  if (!handler) return false;
  try {
    return handler(detail) === true;
  } catch {
    // A patcher that throws must not take the screen with it: fall back to
    // the full redraw, which is always correct.
    handler = null;
    return false;
  }
}

/** Called by the shell before it builds a new view. */
export function resetPatchers() {
  handler = null;
}

export default { onCartChange, applyCartChange, resetPatchers };
