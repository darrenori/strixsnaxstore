import { el, money, esc, toast, statusPill, itemLabel } from '../ui.js';
import { navigate } from '../store.js';
import { haptic, confirm } from '../tg.js';
import api from '../api.js';

/**
 * Pay + prove. This is the screen that replaces the Google Form's
 * "upload a screenshot of your payment confirmation" question — except the
 * amount and the order reference are already baked into the QR, so there is
 * far less for the buyer to get wrong.
 */

let countdownTimer = null;

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function countdown(node, expiresAt) {
  const tick = () => {
    const left = new Date(expiresAt).getTime() - Date.now();
    if (left <= 0) {
      node.textContent = 'This order has expired — the items went back on the shelf.';
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
      el('div', {},
        el('div', { class: 'cart-line__name' }, `${line.quantity} × ${itemLabel(line)}`),
        el('div', { class: 'cart-line__sub' }, `$${line.unitPrice} each`)
      ),
      el('div', { class: 'cart-line__total' }, `$${line.lineTotal}`)
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
  // lie — there is no reservation left to run out.
  if (showTimer) {
    const timer = el('p', { class: 'qr-card__timer' });
    card.append(timer);
    countdown(timer, order.expiresAt);
  }

  return card;
}

function uploader(order, onUploaded) {
  const fileInput = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp,image/heic', hidden: true,
  });

  const zone = el('div', { class: 'dropzone', role: 'button', tabindex: '0' },
    el('div', { class: 'dropzone__icon' }, '📤'),
    el('div', { class: 'dropzone__label' }, 'Add your payment screenshot'),
    el('div', { class: 'dropzone__hint' }, 'JPG, PNG or WEBP · max 10 MB')
  );

  const refInput = el('input', {
    class: 'input', type: 'text', maxlength: '64',
    placeholder: order.code, value: order.paymentRef ?? '',
  });

  const submit = el('button', { class: 'btn', type: 'button', disabled: true },
    'UPLOAD & COLLECT');

  let chosen = null;
  let previewUrl = null;

  function choose(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      haptic('error');
      return toast('That is not an image', 'error');
    }
    if (file.size > 10 * 1024 * 1024) {
      haptic('error');
      return toast('That screenshot is over 10 MB', 'error');
    }

    chosen = file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);

    zone.replaceChildren(
      el('img', { class: 'dropzone__preview', src: previewUrl, alt: 'Your payment screenshot' }),
      el('div', { class: 'dropzone__hint mt' }, `${esc(file.name)} · tap to change`)
    );
    submit.disabled = false;
    haptic('success');
    return undefined;
  }

  fileInput.addEventListener('change', () => choose(fileInput.files?.[0]));
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    choose(e.dataTransfer?.files?.[0]);
  });

  submit.addEventListener('click', async () => {
    if (!chosen) return;
    const form = new FormData();
    form.append('proof', chosen);
    if (refInput.value.trim()) form.append('paymentRef', refInput.value.trim());

    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span> UPLOADING…';

    try {
      const { order: updated } = await api.uploadProof(order.id, form);
      haptic('success');
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      onUploaded(updated);
    } catch (err) {
      haptic('error');
      toast(err.message, 'error');
      submit.disabled = false;
      submit.textContent = 'UPLOAD & COLLECT';
    }
  });

  return el('section', { class: 'card' },
    el('h2', { class: 'card__title' }, 'Payment proof'),
    el('ol', { class: 'steps' },
      el('li', {}, 'Scan the QR above with your banking app.'),
      el('li', {}, `Pay exactly ${money(order.totalCents)}.`),
      el('li', {}, 'Screenshot the confirmation screen.'),
      el('li', {}, 'Upload it here, then take your snacks straight away.')
    ),
    fileInput,
    zone,
    el('div', { class: 'field mt' },
      el('label', { class: 'field__label' }, 'Reference you used'),
      refInput,
      el('p', { class: 'field__hint' }, `Leave blank if you used ${order.code}.`)
    ),
    submit
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
      el('p', {}, `📍 Take them from ${(order.collectionPoints ?? []).join(' + ') || 'Blk B'} now — you do not have to wait for anyone.`),
      el('p', { class: 'muted' }, 'An admin checks the payment later. If anything looks off they will message you.')
    );
  } else if (order.status === 'paid') {
    card.append(
      el('p', {}, '✅ Payment verified — all settled. Thanks! 🐼'),
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
          ? 'You already have these items, so this is about settling up. Upload a '
            + 'clearer screenshot below, or message an admin if you think this is a mistake.'
          : 'Upload another screenshot below and it goes straight back to the queue — '
            + 'no need to start a new order. Your items were released in the meantime, '
            + 'so if something has sold out since, we will tell you.')
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
        el('p', { class: 'center muted' }, 'Scan · Pay · Upload'),
        qrCard(order, payment),
        receipt(order),
        uploader(order, (updated) => {
          toast('Go grab your snacks! 🎉', 'ok');
          paint(updated, payment);
        })
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
      // stays folded away: putting it on screen next to "upload again" is how
      // somebody ends up paying twice. Anyone who genuinely has not paid can
      // still open it.
      root.append(el('details', { class: 'card card--flat' },
        el('summary', { class: 'card__title' }, 'I have not actually paid yet'),
        el('p', { class: 'muted' },
          'Only if the note above says the payment never arrived. If it was just '
          + 'a blurry screenshot, do not pay again — send a clearer one.'),
        qrCard(order, payment, { showTimer: false })
      ));

      root.append(uploader(order, (updated) => {
        toast('Go grab your snacks! 🎉', 'ok');
        paint(updated, payment);
      }));
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
