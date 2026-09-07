import { el, money, itemLabel, empty, toast } from '../ui.js';
import {
  state, cartLines, cartTotalCents, setQty, clearCart,
  navigate, setBuyerName, reconcileCart, emit,
} from '../store.js';
import { haptic, alert, confirm } from '../tg.js';
import api from '../api.js';

/**
 * Cart + checkout in one screen. The Google Form asked for a name, then item,
 * then quantity, then "buying any more items?" — this replaces the whole loop
 * with a running basket the shopper can see.
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

  for (const { item, quantity, lineCents } of lines) {
    basket.append(el('div', { class: 'cart-line' },
      el('div', {},
        el('div', { class: 'cart-line__name' }, itemLabel(item)),
        el('div', { class: 'cart-line__sub' }, `$${item.price} each · ${item.collectionPoint}`)
      ),
      el('div', { class: 'cart-line__total' }, money(lineCents)),
      el('div', { class: 'cart-line__ctrl' },
        el('div', { class: 'qty' },
          el('button', {
            class: 'qty__btn', 'aria-label': `Remove one ${itemLabel(item)}`,
            onClick: () => { haptic('light'); setQty(item.id, quantity - 1); },
          }, '−'),
          el('span', { class: 'qty__val' }, String(quantity)),
          el('button', {
            class: 'qty__btn', 'aria-label': `Add one ${itemLabel(item)}`,
            disabled: quantity >= item.available,
            onClick: () => { haptic('light'); setQty(item.id, quantity + 1); },
          }, '+')
        )
      )
    ));
  }

  const total = cartTotalCents();
  const points = [...new Set(lines.map((l) => l.item.collectionPoint).filter(Boolean))];

  basket.append(el('div', { class: 'totals' },
    el('div', { class: 'totals__row' },
      el('span', {}, `${lines.reduce((s, l) => s + l.quantity, 0)} item(s)`),
      el('span', {}, money(total))
    ),
    el('div', { class: 'totals__row totals__row--grand' },
      el('span', {}, 'TOTAL'),
      el('span', {}, money(total))
    )
  ));
  root.append(basket);

  // --- collection ----------------------------------------------------------
  root.append(el('section', { class: 'card card--flat' },
    el('h2', { class: 'card__title' }, 'Collect from'),
    ...points.map((p) => el('p', { class: 'mb0' }, `📍 ${p}`)),
    points.length > 1
      ? el('p', { class: 'field__hint' }, 'Your order spans both points — pick up from each.')
      : null
  ));

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
  const submit = el('button', { class: 'btn', type: 'button' },
    `PLACE ORDER · ${money(total)}`);

  submit.addEventListener('click', async () => {
    const buyerName = nameInput.value.trim();
    if (!buyerName) {
      haptic('error');
      nameInput.focus();
      return toast('Tell us your name first', 'error');
    }

    // Re-check against the freshest catalogue before spending the user's time.
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

    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span> PLACING…';

    try {
      const result = await api.placeOrder(payload);
      haptic('success');
      clearCart();
      navigate('payment', { orderId: result.order.id, prefetched: result });
    } catch (err) {
      haptic('error');
      toast(err.message, 'error');
      submit.disabled = false;
      submit.textContent = `PLACE ORDER · ${money(total)}`;
      // Stock errors mean our catalogue is stale — refresh it.
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

  return root;
}

export default renderCart;
