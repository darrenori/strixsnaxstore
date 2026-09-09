import { el, money, toast, statusPill, itemLabel, relTime } from '../ui.js';
import { navigate } from '../store.js';
import { haptic, confirm, tg } from '../tg.js';
import api from '../api.js';

/**
 * Pay + prove.
 *
 * This replaces the Google Form's "upload a screenshot of your payment
 * confirmation" question, except the amount and the order reference are
 * already baked into the QR, so there is far less for the buyer to get wrong.
 *
 * The screenshot itself is no longer taken here. Telegram's webview file
 * picker behaves differently on every phone and on several of them does not
 * open at all, and when it fails it fails silently, which reads to a buyer as
 * a shop that ate their money. Sending a photo to a chat is the one file
 * operation every Telegram user has already done, so the app asks the bot to
 * collect it and gets out of the way.
 */

let countdownTimer = null;

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function countdown(node, expiresAt) {
  const tick = () => {
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) {
      node.textContent = 'This order has expired and the items went back on the shelf.';
      stopCountdown();
      return;
    }
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    node.textContent = `⏳ Reserved for ${mins}:${String(secs).padStart(2, '0')}`;
  };
  tick();
  stopCountdown();
  countdownTimer = setInterval(tick, 1000);
}

function receipt(order) {
  const card = el('section', { class: 'card card--flat' },
    el('h2', { class: 'card__title' }, 'Order summary')
  );
  for (const line of order.items) {
    card.append(el('div', { class: 'cart-line' },
      el('div', { class: 'cart-line__name' }, `${line.quantity} × ${itemLabel(line)}`),
      el('div', { class: 'cart-line__total' }, `$${line.lineTotal}`),
      el('div', { class: 'cart-line__sub' }, `$${line.unitPrice} each`)
    ));
  }
  card.append(el('div', { class: 'totals' },
    el('div', { class: 'totals__row totals__row--grand' },
      el('span', {}, 'TOTAL'), el('span', {}, `$${order.total}`))
  ));
  if (order.collectionPoints?.length) {
    card.append(el('p', { class: 'muted mt mb0' }, `📍 Collect at ${order.collectionPoints.join(' + ')}`));
  }
  return card;
}

function qrCard(order, payment, { showTimer = true } = {}) {
  const card = el('section', { class: 'qr-card' },
    el('div', { class: 'qr-card__amount' }, `$${order.total}`),
    el('div', { class: 'qr-card__code' }, order.code)
  );

  if (payment?.imageUrl) {
    card.append(el('img', {
      class: 'qr-card__img',
      src: payment.imageUrl,
      alt: `PayNow QR code for order ${order.code}`,
      loading: 'eager',
    }));
  }

  card.append(el('p', { class: 'qr-card__note' },
    payment?.mode === 'dynamic'
      ? (payment.note ?? 'Scan with your banking app.')
      : `Scan with your banking app, enter ${money(order.totalCents)} and put ${order.code} as the reference.`
  ));

  // A rejected order is not holding anything, so a countdown on it would be a
  // lie: there is no reservation left to run out.
  if (showTimer) {
    const timer = el('p', { class: 'qr-card__timer' });
    card.append(timer);
    countdown(timer, order.expiresAt);
  }

  return card;
}

/**
 * Hand the buyer over to the chat to send their screenshot.
 *
 * Pressing this makes the bot message them, which puts the request in the one
 * place they will see it even if they close the store, and gives their photo
 * something to reply to so it lands against the right order.
 */
function handover(order, onSent) {
  const already = Boolean(order.proofRequestedAt);

  const send = el('button', { class: 'btn', type: 'button' },
    already ? 'SEND THE REQUEST AGAIN' : 'SEND MY SCREENSHOT IN TELEGRAM');

  // relTime says "now" for anything under a minute, which reads as a fragment
  // rather than as a sentence.
  const age = already ? Date.now() - new Date(order.proofRequestedAt).getTime() : 0;
  const status = el('p', { class: 'field__hint' },
    // eslint-disable-next-line no-nested-ternary
    !already ? ''
      : age < 60_000 ? 'Sent to your chat just now. Check Telegram.'
        : `Sent to your chat ${relTime(order.proofRequestedAt)}.`);

  send.addEventListener('click', async () => {
    const label = send.textContent;
    send.disabled = true;
    send.innerHTML = '<span class="spinner"></span> ASKING THE BOT…';
    try {
      const { order: updated } = await api.requestProof(order.id);
      haptic('success');
      toast('Check your chat with the bot 💬', 'ok');
      onSent(updated);
    } catch (err) {
      haptic('error');
      toast(err.message, 'error');
      send.disabled = false;
      send.textContent = label;
    }
  });

  const close = tg?.close
    ? el('button', {
        class: 'btn btn--ghost mt', type: 'button',
        onClick: () => tg.close(),
      }, 'CLOSE AND OPEN THE CHAT')
    : null;

  return el('section', { class: 'card' },
    el('h2', { class: 'card__title' }, 'Payment proof'),
    el('ol', { class: 'steps' },
      el('li', {}, 'Scan the QR above with your banking app.'),
      el('li', {}, `Pay exactly ${money(order.totalCents)}.`),
      el('li', {}, 'Screenshot the confirmation screen.'),
      el('li', {}, 'Send that screenshot to the bot in this Telegram chat.')
    ),
    el('p', { class: 'muted' },
      'The bot will message you with this order code. Reply to that message '
      + 'with your screenshot and your snacks are yours right away.'),
    send,
    status,
    close
  );
}

/** What the buyer sees once the screenshot is in the queue. */
function waitingCard(order, rerender) {
  const card = el('section', { class: 'card' },
    el('div', { class: 'order__head' },
      el('span', { class: 'order__code' }, order.code),
      statusPill(order.status)
    )
  );

  if (order.status === 'pending_review') {
    card.append(
      el('p', { class: 'collect-now' }, '🎉 Go grab your snacks!'),
      el('p', {}, `📍 Take them from ${(order.collectionPoints ?? []).join(' + ') || 'Blk B'} now. You do not have to wait for anyone.`),
      el('p', { class: 'muted' }, 'An admin checks the payment later. If anything looks off they will message you.')
    );
  } else if (order.status === 'paid') {
    card.append(
      el('p', {}, '✅ Payment verified, all settled. Thanks! 🐼'),
      el('p', { class: 'muted mb0' }, 'Nothing left to do.')
    );
  } else if (order.status === 'collected') {
    card.append(el('p', {}, '📦 Collected and verified. Enjoy! 🐼'));
  } else if (order.status === 'rejected') {
    card.append(
      el('p', {}, '⚠️ An admin could not verify that payment.'),
      order.reviewNote ? el('p', { class: 'order__note' }, order.reviewNote) : null,
      el('p', { class: 'muted' },
        order.collectNow
          ? 'You already have these items, so this is about settling up. Send a '
            + 'clearer screenshot to the bot, or message an admin if you think this '
            + 'is a mistake.'
          : 'Send another screenshot to the bot and it goes straight back to the '
            + 'queue, with no need to start a new order. Your items were released '
            + 'in the meantime, so if something has sold out since, we will tell you.')
    );
  } else if (order.status === 'cancelled') {
    card.append(el('p', {}, '✖️ This order was cancelled and the items are back on the shelf.'));
  }

  const refresh = el('button', { class: 'btn btn--ghost mt', type: 'button' }, 'REFRESH STATUS');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    refresh.innerHTML = '<span class="spinner"></span> CHECKING…';
    try {
      const fresh = await api.order(order.id);
      rerender(fresh.order, fresh.payment);
    } catch (err) {
      toast(err.message, 'error');
      refresh.disabled = false;
      refresh.textContent = 'REFRESH STATUS';
    }
  });
  card.append(refresh);

  return card;
}

export function renderPayment(params) {
  stopCountdown();
  const root = el('div', {});
  const { orderId, prefetched } = params;

  const paint = (order, payment) => {
    stopCountdown();
    root.replaceChildren();

    const isOpen = order.status === 'awaiting_payment';

    if (isOpen) {
      root.append(
        el('p', { class: 'center muted' }, 'Scan · Pay · Send'),
        qrCard(order, payment),
        receipt(order),
        handover(order, (updated) => paint(updated, payment))
      );

      const cancel = el('button', { class: 'btn btn--ghost mt', type: 'button' }, 'CANCEL THIS ORDER');
      cancel.addEventListener('click', async () => {
        if (!(await confirm('Cancel this order? Your items go back on the shelf.'))) return;
        cancel.disabled = true;
        try {
          const { order: updated } = await api.cancelOrder(order.id);
          haptic('warning');
          paint(updated, payment);
        } catch (err) {
          toast(err.message, 'error');
          cancel.disabled = false;
        }
      });
      root.append(cancel);
    } else if (order.status === 'rejected') {
      // Rejected orders can be re-proved without placing a whole new order.
      root.append(waitingCard(order, paint), receipt(order));

      // Most rejections are a bad screenshot, not a missing payment, so the QR
      // stays folded away: putting it on screen next to "send another" is how
      // somebody ends up paying twice. Anyone who genuinely has not paid can
      // still open it.
      root.append(el('details', { class: 'card card--flat' },
        el('summary', { class: 'card__title' }, 'I have not actually paid yet'),
        el('p', { class: 'muted' },
          'Only if the note above says the payment never arrived. If it was just '
          + 'a blurry screenshot, do not pay again, send a clearer one.'),
        qrCard(order, payment, { showTimer: false })
      ));

      root.append(handover(order, (updated) => paint(updated, payment)));
    } else {
      root.append(waitingCard(order, paint), receipt(order));
    }

    root.append(el('button', {
      class: 'btn btn--navy mt', type: 'button',
      onClick: () => navigate('orders'),
    }, 'ALL MY ORDERS'));
  };

  if (prefetched) {
    paint(prefetched.order, prefetched.payment);
  } else {
    root.append(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
    api.order(orderId)
      .then(({ order, payment }) => paint(order, payment))
      .catch((err) => {
        root.replaceChildren(el('div', { class: 'card' },
          el('p', {}, err.message),
          el('button', {
            class: 'btn btn--ghost', type: 'button',
            onClick: () => navigate('orders'),
          }, 'BACK TO ORDERS')
        ));
      });
  }

  return root;
}

export { stopCountdown };
export default renderPayment;
