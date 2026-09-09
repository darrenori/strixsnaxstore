import { el, money, itemLabel, empty, toast } from '../ui.js';
import {
  state, cartLines, cartTotalCents, cartQty, setQty, clearCart,
  navigate, setBuyerName, reconcileCart, emit,
} from '../store.js';
import { onCartChange } from '../patch.js';
import { haptic, alert, confirm } from '../tg.js';
import api from '../api.js';

/**
 * Cart + checkout in one screen. The Google Form asked for a name, then item,
 * then quantity, then "buying any more items?", and this replaces the whole
 * loop with a running basket the shopper can see.
 */
export function renderCart() {
  const root = el('div', {});
  const lines = cartLines();

  if (lines.length === 0) {
    root.append(empty({
      icon: '🛒',
      title: 'Your cart is empty',
      text: 'Add something tasty from the Shop tab.',
    }));
    root.append(el('button', {
      class: 'btn btn--ghost', type: 'button',
      onClick: () => navigate('shop'),
    }, 'BACK TO SHOP'));
    return root;
  }

  // --- basket ---------------------------------------------------------------
  const basket = el('section', { class: 'card' },
    el('h2', { class: 'card__title' }, 'Your order')
  );

  /** Row nodes we have to keep updating as quantities change. */
  const rows = new Map();

  for (const { item } of lines) basket.append(lineRow(item, rows));

  const countLabel = el('span', {});
  const subtotalLabel = el('span', {});
  const grandLabel = el('span', {});

  basket.append(el('div', { class: 'totals' },
    el('div', { class: 'totals__row' }, countLabel, subtotalLabel),
    el('div', { class: 'totals__row totals__row--grand' },
      el('span', {}, 'TOTAL'),
      grandLabel
    )
  ));
  root.append(basket);

  // --- collection ----------------------------------------------------------
  const collectCard = el('section', { class: 'card card--flat' },
    el('h2', { class: 'card__title' }, 'Collect from')
  );
  root.append(collectCard);

  // --- details -------------------------------------------------------------
  const nameInput = el('input', {
    class: 'input', type: 'text', id: 'buyerName', maxlength: '80',
    placeholder: 'e.g. Darren', value: state.buyerName,
    autocomplete: 'name', enterkeyhint: 'done',
  });
  nameInput.addEventListener('input', () => setBuyerName(nameInput.value));

  const noteInput = el('textarea', {
    class: 'textarea', id: 'orderNote', maxlength: '280',
    placeholder: 'Anything we should know? (optional)',
  });
  noteInput.value = state.orderNote;
  // Held in state, not just in the DOM, so nothing the shopper has typed is
  // lost if the screen has to be rebuilt.
  noteInput.addEventListener('input', () => { state.orderNote = noteInput.value; });

  root.append(el('section', { class: 'card' },
    el('h2', { class: 'card__title' }, 'Your details'),
    el('div', { class: 'field' },
      el('label', { class: 'field__label', for: 'buyerName' },
        "What's your name? ", el('span', { class: 'req' }, '*')),
      nameInput
    ),
    el('div', { class: 'field' },
      el('label', { class: 'field__label', for: 'orderNote' }, 'Note'),
      noteInput
    )
  ));

  // --- submit --------------------------------------------------------------
  const submit = el('button', { class: 'btn', type: 'button' });

  /**
   * Restate everything that depends on quantities.
   *
   * Called on render and again after each tap, in place. The alternative was
   * rebuilding the screen, which reset the note field and lost the focus ring
   * on whichever button had just been pressed.
   */
  function repaintTotals() {
    const current = cartLines();
    const units = current.reduce((s, l) => s + l.quantity, 0);
    const total = cartTotalCents();

    countLabel.textContent = `${units} ${units === 1 ? 'item' : 'items'}`;
    subtotalLabel.textContent = money(total);
    grandLabel.textContent = money(total);
    submit.textContent = `PLACE ORDER · ${money(total)}`;

    // replaceChildren is native DOM, not el(): a null slipped in here renders
    // as the literal text "null" under the address.
    const points = [...new Set(current.map((l) => l.item.collectionPoint).filter(Boolean))];
    collectCard.replaceChildren(...[
      el('h2', { class: 'card__title' }, 'Collect from'),
      ...points.map((p) => el('p', { class: 'mb0' }, `📍 ${p}`)),
      points.length > 1
        ? el('p', { class: 'field__hint' }, 'Your order spans both points, so pick up from each.')
        : null,
    ].filter(Boolean));
  }
  repaintTotals();

  submit.addEventListener('click', async () => {
    const buyerName = nameInput.value.trim();
    if (!buyerName) {
      haptic('error');
      nameInput.focus();
      return toast('Tell us your name first', 'error');
    }

    // Reconcile against a catalogue we have just fetched, not the copy that
    // may have been on screen since the app opened: someone else can have
    // taken the last packet since then. A failed refresh is not worth losing
    // a sale over, because create_order re-checks stock under a row lock
    // regardless.
    submit.disabled = true;
    try {
      const fresh = await api.catalog();
      state.catalog = fresh;
      state.store = fresh.store;
    } catch { /* offline or slow, fall through to the cached check */ }
    submit.disabled = false;

    const dropped = reconcileCart();
    if (dropped.length) {
      haptic('warning');
      await alert(`Some items changed while you were shopping:\n\n${dropped.join('\n')}`);
      return emit();
    }

    const payload = {
      buyerName,
      note: noteInput.value.trim() || undefined,
      cart: cartLines().map((l) => ({ itemId: l.item.id, quantity: l.quantity })),
    };
    if (payload.cart.length === 0) return emit();

    const label = submit.textContent;
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span> PLACING…';

    try {
      const result = await api.placeOrder(payload);
      haptic('success');
      // The order now owns those items, so the basket that produced it is
      // emptied here. Anything still in it after this point is a new order.
      clearCart();
      navigate('payment', { orderId: result.order.id, prefetched: result });
    } catch (err) {
      haptic('error');
      toast(err.message, 'error');
      submit.disabled = false;
      submit.textContent = label;
      // Stock errors mean our catalogue is stale, so refresh it.
      if (err.code === 'OUT_OF_STOCK' || err.code === 'ITEM_INACTIVE') {
        try {
          const fresh = await api.catalog();
          state.catalog = fresh;
          state.store = fresh.store;
          reconcileCart();
          emit();
        } catch { /* leave the cart as-is */ }
      }
    }
    return undefined;
  });

  root.append(el('div', { class: 'sticky-bar' }, submit));

  root.append(el('button', {
    class: 'btn btn--ghost mt', type: 'button',
    onClick: async () => {
      if (await confirm('Empty your cart?')) { clearCart(); haptic('warning'); }
    },
  }, 'CLEAR CART'));

  onCartChange(({ itemId, qty }) => {
    const row = rows.get(itemId);
    if (!row) return false;

    // The last line going means an empty cart, which is a different screen.
    if (qty === 0 && rows.size === 1) return false;

    if (qty === 0) {
      row.node.remove();
      rows.delete(itemId);
    } else {
      row.repaint();
    }
    repaintTotals();
    return true;
  });

  return root;
}

/** One basket line, with a stepper that updates itself. */
function lineRow(item, rows) {
  const total = el('div', { class: 'cart-line__total' });
  const value = el('span', { class: 'qty__val' }, String(cartQty(item.id)));
  const minus = el('button', {
    class: 'qty__btn', 'aria-label': `Remove one ${itemLabel(item)}`,
    onClick: () => { haptic('light'); setQty(item.id, cartQty(item.id) - 1); },
  }, '−');
  const plus = el('button', {
    class: 'qty__btn', 'aria-label': `Add one ${itemLabel(item)}`,
    onClick: () => {
      if (cartQty(item.id) >= item.available) return;
      haptic('light');
      setQty(item.id, cartQty(item.id) + 1);
    },
  }, '+');

  const node = el('div', { class: 'cart-line' },
    el('div', { class: 'cart-line__name' }, itemLabel(item)),
    total,
    el('div', { class: 'cart-line__sub' }, `$${item.price} each · ${item.collectionPoint}`),
    el('div', { class: 'cart-line__ctrl' }, el('div', { class: 'qty' }, minus, value, plus))
  );

  const repaint = () => {
    const qty = cartQty(item.id);
    value.textContent = String(qty);
    total.textContent = money(item.priceCents * qty);
    plus.disabled = qty >= item.available;
  };
  repaint();

  rows.set(item.id, { node, repaint });
  return node;
}

export default renderCart;
