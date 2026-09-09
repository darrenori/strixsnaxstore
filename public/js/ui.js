/** Small DOM helpers. No framework - the app is five screens and a form. */

/** Escape text destined for innerHTML. Everything user-supplied goes through here. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const money = (cents) => `$${(Number(cents ?? 0) / 100).toFixed(2)}`;

/** Build an element from a tag, props and children. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer = null;

export function toast(message, kind = '') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast is-open ${kind ? `is-${kind}` : ''}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = 'toast'; }, kind === 'error' ? 4200 : 2600);
}

/** The count on the Admin tab. Written from two places, so it lives here. */
export function setAdminBadge(count) {
  const badge = document.getElementById('adminBadge');
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

export function empty({ icon = '🐼', title = 'Nothing here', text = '' } = {}) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty__icon' }, icon),
    el('p', { class: 'empty__title' }, title),
    text ? el('p', { class: 'empty__text' }, text) : null
  );
}

export function skeletons(count = 4) {
  return el('div', {}, ...Array.from({ length: count }, () => el('div', { class: 'skeleton' })));
}

/** "3 minutes ago" / "in 12 min" - friendlier than a raw timestamp on a phone. */
export function relTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const units = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [604800, 'day', 86400],
  ];
  for (const [limit, unit, div] of units) {
    if (abs < limit) {
      const value = Math.round(diff / div);
      return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(value, unit);
    }
  }
  return new Date(then).toLocaleDateString('en-SG', { day: 'numeric', month: 'short' });
}

export function sgTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// The buyer collects the moment their screenshot is up, so `pending_review`
// is about the payment being checked, never about the snacks being held back.
export const STATUS_LABEL = {
  awaiting_payment: 'Awaiting payment',
  pending_review:   'Collect now',
  paid:             'Verified',
  rejected:         'Payment not verified',
  cancelled:        'Cancelled',
  collected:        'Collected',
};

export function statusPill(status) {
  return el('span', { class: `pill pill--${status}` }, STATUS_LABEL[status] ?? status);
}

/** Swap a button into a spinner while an async action runs. */
export async function withBusy(button, label, fn) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${label ? ` ${esc(label)}` : ''}`;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/**
 * "Hello Panda" plus "Milk" reads as one product name everywhere the two have
 * to appear together. A plain hyphen, because the store's own sublines already
 * use a middot to separate facts and two different separators in one line is
 * one more than anybody can follow.
 */
export function itemLabel(item) {
  return [item.name, item.variant].filter(Boolean).join(' - ');
}

/**
 * An in-page text prompt.
 *
 * `window.prompt` is unreliable inside Telegram's in-app webview - on several
 * platforms it is a no-op that returns null - and the Mini App SDK has no
 * text-input popup of its own. So the admin screens ask for a rejection reason
 * or a new price through this instead.
 *
 * Resolves with the trimmed string, or null if dismissed.
 */
export function askText({
  title,
  label = '',
  value = '',
  placeholder = '',
  confirmLabel = 'OK',
  multiline = false,
} = {}) {
  return new Promise((resolve) => {
    const input = el(multiline ? 'textarea' : 'input', {
      class: multiline ? 'textarea' : 'input',
      value,
      placeholder,
      maxlength: multiline ? '280' : '80',
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      overlay.classList.remove('is-open');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); finish(input.value.trim()); }
    };

    const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
      el('h2', { class: 'card__title' }, title),
      label ? el('label', { class: 'field__label' }, label) : null,
      input,
      el('div', { class: 'sheet__actions' },
        el('button', {
          class: 'btn btn--ghost btn--auto', type: 'button',
          onClick: () => finish(null),
        }, 'CANCEL'),
        el('button', {
          class: 'btn btn--auto', type: 'button',
          onClick: () => finish(input.value.trim()),
        }, confirmLabel)
      )
    );

    const overlay = el('div', {
      class: 'overlay',
      onClick: (e) => { if (e.target === overlay) finish(null); },
    }, sheet);

    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      input.focus();
      if (!multiline) input.select();
    });
  });
}
