import { el, empty, skeletons, statusPill, relTime, sgTime, itemLabel, toast } from '../ui.js';
import { navigate } from '../store.js';
import api from '../api.js';

/** The buyer's own order history — the part a Google Form never gave them. */
function orderCard(order) {
  const needsAction = order.status === 'awaiting_payment' || order.status === 'rejected';

  const card = el('article', { class: `order ${needsAction ? 'order--action' : ''}`.trim() },
    el('div', { class: 'order__head' },
      el('div', {},
        el('div', { class: 'order__code' }, order.code),
        el('div', { class: 'order__when' }, `${sgTime(order.createdAt)} · ${relTime(order.createdAt)}`)
      ),
      statusPill(order.status)
    ),
    el('div', { class: 'order__items' },
      ...order.items.map((i) => el('div', {}, `${i.quantity} × ${itemLabel(i)}`))
    )
  );

  if (order.reviewNote) {
    card.append(el('div', { class: 'order__note' }, `Admin note: ${order.reviewNote}`));
  }

  card.append(el('div', { class: 'order__foot' },
    el('span', { class: 'order__total' }, `$${order.total}`),
    el('span', { class: 'muted' }, (order.collectionPoints ?? []).join(' + '))
  ));

  const actions = el('div', { class: 'order__actions' });

  if (order.status === 'awaiting_payment') {
    actions.append(el('button', {
      class: 'btn btn--sm', type: 'button',
      onClick: () => navigate('payment', { orderId: order.id }),
    }, 'PAY NOW'));
  } else if (order.status === 'rejected') {
    actions.append(el('button', {
      class: 'btn btn--sm', type: 'button',
      onClick: () => navigate('payment', { orderId: order.id }),
    }, 'RE-UPLOAD PROOF'));
  } else {
    actions.append(el('button', {
      class: 'btn btn--sm btn--ghost', type: 'button',
      onClick: () => navigate('payment', { orderId: order.id }),
    }, 'VIEW'));
  }

  card.append(actions);
  return card;
}

export function renderOrders() {
  const root = el('div', {},
    el('h1', { class: 'card__title mt' }, '🧾 My orders'),
    skeletons(3)
  );

  api.myOrders()
    .then(({ orders }) => {
      root.replaceChildren(el('h1', { class: 'card__title mt' }, '🧾 My orders'));

      if (orders.length === 0) {
        root.append(empty({
          icon: '🧾',
          title: 'No orders yet',
          text: 'Everything you buy shows up here with its collection status.',
        }));
        root.append(el('button', {
          class: 'btn btn--ghost', type: 'button',
          onClick: () => navigate('shop'),
        }, 'START SHOPPING'));
        return;
      }

      // Anything the buyer still has to act on floats to the top.
      const weight = { awaiting_payment: 0, rejected: 1, pending_review: 2, paid: 3, collected: 4, cancelled: 5 };
      const sorted = [...orders].sort((a, b) =>
        (weight[a.status] ?? 9) - (weight[b.status] ?? 9) ||
        new Date(b.createdAt) - new Date(a.createdAt));

      for (const order of sorted) root.append(orderCard(order));
    })
    .catch((err) => {
      root.replaceChildren(empty({ icon: '⚠️', title: 'Could not load orders', text: err.message }));
      toast(err.message, 'error');
    });

  return root;
}

export default renderOrders;
