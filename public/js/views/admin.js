import {
  el, empty, skeletons, statusPill, relTime, itemLabel, toast, withBusy, askText,
} from '../ui.js';
import { state, emit } from '../store.js';
import { haptic, confirm } from '../tg.js';
import api from '../api.js';

/**
 * The admin surface. Everything the committee used to do by hand — reading
 * form responses, eyeballing screenshots, counting boxes on a shelf and
 * retyping it all into a spreadsheet — lives here, and every action writes
 * through to both Supabase and the Google Sheet.
 */

const TABS = [
  { id: 'queue',    label: '🔍 Verify' },
  { id: 'stock',    label: '📦 Stock' },
  { id: 'items',    label: '✨ Items' },
  { id: 'people',   label: '👥 People' },
  { id: 'settings', label: '⚙️ Store' },
];

function tabBar(onChange) {
  return el('nav', { class: 'admin-nav' },
    ...TABS.map((t) => el('button', {
      class: `admin-nav__btn ${state.adminTab === t.id ? 'is-active' : ''}`.trim(),
      type: 'button',
      onClick: () => { if (state.adminTab !== t.id) { haptic('select'); onChange(t.id); } },
    }, t.label))
  );
}

// ===========================================================================
// Verify queue
// ===========================================================================

function orderReviewCard(order, refresh) {
  const card = el('article', { class: 'order order--action' },
    el('div', { class: 'order__head' },
      el('div', {},
        el('div', { class: 'order__code' }, order.code),
        el('div', { class: 'order__when' },
          `${order.buyerName}${order.username ? ` · @${order.username}` : ''} · ${relTime(order.createdAt)}`),
        // A display name is whatever the buyer typed and a @username can be
        // changed or absent; the numeric id is the only thing that reliably
        // says who actually paid.
        el('div', { class: 'order__tgid' }, `ID ${order.telegramId}`)
      ),
      statusPill(order.status)
    ),
    el('div', { class: 'order__items' },
      ...order.items.map((i) => el('div', {}, `${i.quantity} × ${itemLabel(i)} — $${i.lineTotal}`))
    ),
    el('div', { class: 'order__foot' },
      el('span', { class: 'order__total' }, `$${order.total}`),
      el('span', { class: 'muted' }, (order.collectionPoints ?? []).join(' + '))
    )
  );

  if (order.note) card.append(el('div', { class: 'order__note' }, `📝 ${order.note}`));
  if (order.paymentRef && order.paymentRef !== order.code) {
    card.append(el('div', { class: 'order__note' }, `Reference used: ${order.paymentRef}`));
  }

  // The screenshot is behind a short-lived signed URL, fetched only on demand.
  const proofSlot = el('div', { class: 'mt' });
  if (order.hasProof) {
    const view = el('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, '🖼 VIEW SCREENSHOT');
    view.addEventListener('click', () => withBusy(view, 'LOADING', async () => {
      try {
        const url = await api.adminProof(order.id);
        const img = el('img', {
          class: 'proof-img', src: url, alt: `Payment proof for ${order.code}`,
        });
        // Release the blob once the browser has decoded it.
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        proofSlot.replaceChildren(img);
      } catch (err) {
        toast(err.message, 'error');
      }
    }));
    proofSlot.append(view);
  } else {
    proofSlot.append(el('p', { class: 'muted mb0' }, 'No screenshot uploaded yet.'));
  }
  card.append(proofSlot);

  // --- decisions -----------------------------------------------------------
  const actions = el('div', { class: 'order__actions' });

  if (order.status === 'pending_review' || order.status === 'awaiting_payment') {
    const approve = el('button', { class: 'btn btn--sm btn--ok', type: 'button' }, '✅ APPROVE');
    approve.addEventListener('click', async () => {
      const label = `${order.code} — $${order.total}`;
      if (!(await confirm(`Confirm payment received for ${label}?`))) return;
      await withBusy(approve, '', async () => {
        try {
          await api.approve(order.id);
          haptic('success');
          toast(`${order.code} approved`, 'ok');
          refresh();
        } catch (err) { haptic('error'); toast(err.message, 'error'); }
      });
    });

    const reject = el('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, '⚠️ REJECT');
    reject.addEventListener('click', async () => {
      const reason = await askText({
        title: `Reject ${order.code}?`,
        label: 'Reason (the buyer sees this)',
        value: 'Payment not received',
        confirmLabel: 'REJECT',
        multiline: true,
      });
      if (reason === null) return;
      await withBusy(reject, '', async () => {
        try {
          await api.reject(order.id, reason.trim() || 'Payment could not be verified');
          haptic('warning');
          toast(`${order.code} rejected`);
          refresh();
        } catch (err) { haptic('error'); toast(err.message, 'error'); }
      });
    });

    actions.append(approve, reject);
  }

  if (actions.children.length) card.append(actions);
  return card;
}

function renderQueue(root) {
  const filters = ['pending_review', 'paid', 'awaiting_payment', 'rejected', ''];
  const labels = {
    pending_review: 'To verify', paid: 'Verified',
    awaiting_payment: 'Unpaid', rejected: 'Rejected', '': 'All',
  };
  let active = 'pending_review';

  const bar = el('div', { class: 'admin-nav' });
  const list = el('div', {}, skeletons(3));

  const load = async () => {
    list.replaceChildren(skeletons(2));
    try {
      const { orders } = await api.adminOrders(active || undefined);
      list.replaceChildren();
      if (orders.length === 0) {
        list.append(empty({
          icon: '✨', title: 'Nothing here',
          text: active === 'pending_review'
            ? 'No payments waiting for verification. Nice.'
            : 'No orders in this state.',
        }));
        return;
      }
      for (const order of orders) list.append(orderReviewCard(order, load));
    } catch (err) {
      list.replaceChildren(empty({ icon: '⚠️', title: 'Could not load', text: err.message }));
    }
  };

  const paintBar = () => {
    bar.replaceChildren(...filters.map((f) => el('button', {
      class: `admin-nav__btn ${active === f ? 'is-active' : ''}`.trim(),
      type: 'button',
      onClick: () => { active = f; paintBar(); load(); },
    }, labels[f])));
  };
  paintBar();

  root.append(bar, list);
  load();
}

// ===========================================================================
// Stock take
// ===========================================================================

function renderStock(root) {
  const list = el('div', {}, skeletons(6));
  const dirty = new Map();   // itemId -> new count

  const saveBar = el('div', { class: 'sticky-bar' });
  const save = el('button', { class: 'btn', type: 'button', disabled: true }, 'SAVE STOCK TAKE');

  const refreshSaveState = () => {
    save.disabled = dirty.size === 0;
    save.textContent = dirty.size === 0
      ? 'SAVE STOCK TAKE'
      : `SAVE STOCK TAKE · ${dirty.size} CHANGE${dirty.size > 1 ? 'S' : ''}`;
  };

  save.addEventListener('click', async () => {
    if (dirty.size === 0) return;
    const entries = [...dirty.entries()].map(([itemId, count]) => ({ itemId, count }));
    await withBusy(save, 'SAVING', async () => {
      try {
        const res = await api.stockTake(entries, 'Stock take from Mini App');
        haptic('success');
        toast(`${res.updated} item(s) updated · sheet synced`, 'ok');
        dirty.clear();
        load();
      } catch (err) { haptic('error'); toast(err.message, 'error'); }
    });
    refreshSaveState();
  });
  saveBar.append(save);

  const row = (item) => {
    const input = el('input', {
      class: 'stock-input', type: 'number', min: '0', max: '100000',
      value: String(item.stock), inputmode: 'numeric',
      'aria-label': `Stock count for ${itemLabel(item)}`,
    });

    input.addEventListener('input', () => {
      const value = Number.parseInt(input.value, 10);
      if (!Number.isFinite(value) || value < 0) { input.classList.remove('is-dirty'); dirty.delete(item.id); }
      else if (value !== item.stock) { input.classList.add('is-dirty'); dirty.set(item.id, value); }
      else { input.classList.remove('is-dirty'); dirty.delete(item.id); }
      refreshSaveState();
    });

    const bump = (delta) => el('button', {
      class: 'qty__btn', type: 'button',
      'aria-label': `${delta > 0 ? 'Increase' : 'Decrease'} ${itemLabel(item)}`,
      onClick: () => {
        const current = Number.parseInt(input.value, 10) || 0;
        input.value = String(Math.max(0, current + delta));
        input.dispatchEvent(new Event('input'));
        haptic('light');
      },
    }, delta > 0 ? '+' : '−');

    return el('div', { class: `stock-row ${item.isLow ? 'is-low' : ''}`.trim() },
      el('div', {},
        el('div', { class: 'stock-row__name' }, itemLabel(item)),
        el('div', { class: 'stock-row__sub' },
          `${item.categoryName} · $${item.price}` +
          (item.reserved > 0 ? ` · ${item.reserved} reserved` : '') +
          (item.isActive ? '' : ' · HIDDEN'))
      ),
      el('div', { class: 'stock-row__ctrl' },
        el('div', { class: 'qty' }, bump(-1), input, bump(1))
      )
    );
  };

  const load = async () => {
    list.replaceChildren(skeletons(6));
    dirty.clear();
    refreshSaveState();
    try {
      const { items } = await api.adminCatalog();
      list.replaceChildren();

      const groups = new Map();
      for (const item of items) {
        if (!groups.has(item.categoryName)) groups.set(item.categoryName, []);
        groups.get(item.categoryName).push(item);
      }

      for (const [name, group] of groups) {
        const card = el('section', { class: 'card card--flat' },
          el('h2', { class: 'card__title' }, name)
        );
        for (const item of group) card.append(row(item));
        list.append(card);
      }
    } catch (err) {
      list.replaceChildren(empty({ icon: '⚠️', title: 'Could not load stock', text: err.message }));
    }
  };

  root.append(
    el('p', { class: 'muted' },
      'Count what is on the shelf and type the real number. Every change is written to the stock ledger and the Google Sheet.'),
    list,
    saveBar
  );
  load();
}

// ===========================================================================
// Items — create and edit the menu
// ===========================================================================

function itemForm(categories, onCreated) {
  const name = el('input', { class: 'input', maxlength: '80', placeholder: 'e.g. Hello Panda' });
  const variant = el('input', { class: 'input', maxlength: '60', placeholder: 'e.g. Strawberry' });
  const price = el('input', { class: 'input', type: 'number', min: '0', step: '0.05', placeholder: '1.20', inputmode: 'decimal' });
  const stock = el('input', { class: 'input', type: 'number', min: '0', value: '0', inputmode: 'numeric' });
  const lowAt = el('input', { class: 'input', type: 'number', min: '0', value: '5', inputmode: 'numeric' });
  const emoji = el('input', { class: 'input', maxlength: '4', placeholder: '🍫' });
  const desc = el('textarea', { class: 'textarea', maxlength: '280', placeholder: 'A short, tasty description' });

  const category = el('select', { class: 'select' },
    ...categories.map((c) => el('option', { value: c.id }, `${c.kind === 'drink' ? '🥤' : '🐼'} ${c.name}`))
  );

  const special = el('input', { type: 'checkbox' });
  const topPick = el('input', { type: 'checkbox' });

  const submit = el('button', { class: 'btn', type: 'button' }, 'ADD ITEM TO MENU');

  submit.addEventListener('click', async () => {
    const priceValue = Number.parseFloat(price.value);
    if (!name.value.trim()) { toast('Give the item a name', 'error'); return name.focus(); }
    if (!Number.isFinite(priceValue) || priceValue < 0) { toast('Enter a price', 'error'); return price.focus(); }

    await withBusy(submit, 'ADDING', async () => {
      try {
        const { item } = await api.createItem({
          categoryId: category.value,
          name: name.value.trim(),
          variant: variant.value.trim() || undefined,
          description: desc.value.trim() || undefined,
          priceCents: Math.round(priceValue * 100),
          emoji: emoji.value.trim() || undefined,
          stock: Number.parseInt(stock.value, 10) || 0,
          lowStockAt: Number.parseInt(lowAt.value, 10) || 5,
          isSpecial: special.checked,
          isTopPick: topPick.checked,
        });
        haptic('success');
        toast(`${item.sku} added`, 'ok');
        name.value = ''; variant.value = ''; price.value = ''; desc.value = '';
        stock.value = '0'; emoji.value = '';
        special.checked = false; topPick.checked = false;
        onCreated();
      } catch (err) { haptic('error'); toast(err.message, 'error'); }
    });
    return undefined;
  });

  const check = (label, input) => el('label', {
    class: 'field', style: 'display:flex;align-items:center;gap:8px;',
  }, input, el('span', { class: 'field__label', style: 'margin:0;' }, label));

  return el('section', { class: 'card' },
    el('h2', { class: 'card__title' }, '✨ New item'),
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Category'), category),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Name *'), name),
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Variant'), variant)
    ),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Price (SGD) *'), price),
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Emoji'), emoji)
    ),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Opening stock'), stock),
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Low stock at'), lowAt)
    ),
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Description'), desc),
    el('div', { class: 'row' }, check('Special', special), check('Top pick', topPick)),
    submit
  );
}

function categoryForm(onCreated) {
  const name = el('input', { class: 'input', maxlength: '60', placeholder: 'e.g. Ice Cream' });
  const kind = el('select', { class: 'select' },
    el('option', { value: 'snack' }, '🐼 Snax — Blk B Lounge'),
    el('option', { value: 'drink' }, '🥤 Drinks — Blk B Pantry')
  );
  const accent = el('select', { class: 'select' },
    ...['blue', 'red', 'navy', 'gold', 'sky'].map((a) => el('option', { value: a }, a))
  );
  const submit = el('button', { class: 'btn btn--navy', type: 'button' }, 'ADD CATEGORY');

  submit.addEventListener('click', async () => {
    if (!name.value.trim()) { toast('Name the category', 'error'); return name.focus(); }
    await withBusy(submit, 'ADDING', async () => {
      try {
        await api.createCategory({ name: name.value.trim(), kind: kind.value, accent: accent.value });
        haptic('success');
        toast('Category added', 'ok');
        name.value = '';
        onCreated();
      } catch (err) { haptic('error'); toast(err.message, 'error'); }
    });
    return undefined;
  });

  return el('details', { class: 'card card--flat' },
    el('summary', { class: 'card__title', style: 'cursor:pointer;' }, '📁 New category'),
    el('div', { class: 'field mt' }, el('label', { class: 'field__label' }, 'Name'), name),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Type'), kind),
      el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'Accent'), accent)
    ),
    submit
  );
}

function existingItemRow(item, refresh) {
  const toggle = el('button', {
    class: 'btn btn--sm btn--ghost', type: 'button',
  }, item.isActive ? 'HIDE' : 'SHOW');

  toggle.addEventListener('click', () => withBusy(toggle, '', async () => {
    try {
      await api.updateItem(item.id, { isActive: !item.isActive });
      haptic('light');
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  }));

  const editPrice = el('button', { class: 'btn btn--sm btn--ghost', type: 'button' }, '$');
  editPrice.addEventListener('click', async () => {
    const next = await askText({
      title: `Price for ${itemLabel(item)}`,
      label: 'New price in SGD',
      value: item.price,
      placeholder: '1.20',
      confirmLabel: 'SAVE',
    });
    if (next === null) return;
    const value = Number.parseFloat(next);
    if (!Number.isFinite(value) || value < 0) return toast('That is not a price', 'error');
    try {
      await api.updateItem(item.id, { priceCents: Math.round(value * 100) });
      haptic('success');
      toast('Price updated', 'ok');
      refresh();
    } catch (err) { toast(err.message, 'error'); }
    return undefined;
  });

  return el('div', { class: 'stock-row' },
    el('div', {},
      el('div', { class: 'stock-row__name' }, itemLabel(item)),
      el('div', { class: 'stock-row__sub' },
        `${item.sku} · $${item.price} · ${item.stock} in stock${item.isActive ? '' : ' · HIDDEN'}`)
    ),
    el('div', { class: 'stock-row__ctrl' }, editPrice, toggle)
  );
}

function renderItems(root) {
  const formSlot = el('div', {});
  const list = el('div', {}, skeletons(4));

  const load = async () => {
    try {
      const { items, categories } = await api.adminCatalog();
      formSlot.replaceChildren(categoryForm(load), itemForm(categories, load));

      list.replaceChildren(el('h2', { class: 'card__title mt' }, 'Current menu'));
      const groups = new Map();
      for (const item of items) {
        if (!groups.has(item.categoryName)) groups.set(item.categoryName, []);
        groups.get(item.categoryName).push(item);
      }
      for (const [name, group] of groups) {
        const card = el('section', { class: 'card card--flat' },
          el('h3', { class: 'card__title' }, name));
        for (const item of group) card.append(existingItemRow(item, load));
        list.append(card);
      }
    } catch (err) {
      list.replaceChildren(empty({ icon: '⚠️', title: 'Could not load menu', text: err.message }));
    }
  };

  root.append(formSlot, list);
  load();
}

// ===========================================================================
// People
// ===========================================================================

function renderPeople(root) {
  const list = el('div', {}, skeletons(4));

  const promote = el('input', { class: 'input', placeholder: 'Telegram id, e.g. 123456789', inputmode: 'numeric' });
  const promoteBtn = el('button', { class: 'btn btn--navy', type: 'button' }, 'MAKE ADMIN');

  const load = async () => {
    list.replaceChildren(skeletons(3));
    try {
      const { users } = await api.users();
      list.replaceChildren(el('h2', { class: 'card__title mt' }, 'Everyone who opened the store'));

      const card = el('section', { class: 'card card--flat' });
      for (const user of users) {
        const isSelf = user.telegram_id === String(state.me?.telegramId);

        const roleBtn = el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button', disabled: isSelf,
        }, user.is_admin ? 'REMOVE ADMIN' : 'MAKE ADMIN');

        roleBtn.addEventListener('click', async () => {
          const verb = user.is_admin ? 'Remove admin access from' : 'Give admin access to';
          if (!(await confirm(`${verb} ${user.name}?`))) return;
          await withBusy(roleBtn, '', async () => {
            try {
              await api.setRole(user.telegram_id, !user.is_admin);
              haptic('success');
              toast('Updated', 'ok');
              load();
            } catch (err) { toast(err.message, 'error'); }
          });
        });

        card.append(el('div', { class: 'stock-row' },
          el('div', {},
            el('div', { class: 'stock-row__name' },
              `${user.name}${user.is_admin ? ' 🛠' : ''}${isSelf ? ' (you)' : ''}`),
            el('div', { class: 'stock-row__sub' },
              `${user.username ? `@${user.username} · ` : ''}id ${user.telegram_id} · ` +
              `${user.orders_count} order(s) · seen ${relTime(user.last_seen_at)}`)
          ),
          el('div', { class: 'stock-row__ctrl' }, roleBtn)
        ));
      }
      list.append(card);
    } catch (err) {
      list.replaceChildren(empty({ icon: '⚠️', title: 'Could not load people', text: err.message }));
    }
  };

  promoteBtn.addEventListener('click', async () => {
    const id = promote.value.trim();
    if (!id) return promote.focus();
    await withBusy(promoteBtn, 'SAVING', async () => {
      try {
        await api.setRole(id, true);
        haptic('success');
        toast('Admin added', 'ok');
        promote.value = '';
        load();
      } catch (err) { haptic('error'); toast(err.message, 'error'); }
    });
    return undefined;
  });

  root.append(
    el('section', { class: 'card' },
      el('h2', { class: 'card__title' }, '🛠 Add an admin'),
      el('p', { class: 'field__hint', style: 'margin-bottom:10px;' },
        'They must press Start on the bot first. Ask them to send /id to get their number.'),
      el('div', { class: 'field' }, promote),
      promoteBtn
    ),
    list
  );
  load();
}

// ===========================================================================
// Store settings
// ===========================================================================

function renderSettings(root, summary) {
  const openToggle = el('input', { type: 'checkbox' });
  openToggle.checked = summary.settings.storeOpen;

  const announcement = el('input', {
    class: 'input', maxlength: '200', value: summary.settings.announcement ?? '',
    placeholder: 'Shown on the shop header',
  });

  const save = el('button', { class: 'btn', type: 'button' }, 'SAVE SETTINGS');
  save.addEventListener('click', () => withBusy(save, 'SAVING', async () => {
    try {
      await api.settings({ storeOpen: openToggle.checked, announcement: announcement.value.trim() });
      haptic('success');
      toast('Settings saved', 'ok');
    } catch (err) { haptic('error'); toast(err.message, 'error'); }
  }));

  const syncBtn = el('button', { class: 'btn btn--navy', type: 'button' }, '🔄 SYNC MENU TO SHEET');
  syncBtn.addEventListener('click', () => withBusy(syncBtn, 'SYNCING', async () => {
    try {
      await api.syncSheets();
      haptic('success');
      toast('Google Sheet updated', 'ok');
    } catch (err) { haptic('error'); toast(err.message, 'error'); }
  }));

  root.append(
    el('section', { class: 'card' },
      el('h2', { class: 'card__title' }, '⚙️ Store'),
      el('label', { class: 'field', style: 'display:flex;align-items:center;gap:10px;' },
        openToggle,
        el('span', { class: 'field__label', style: 'margin:0;' }, 'Store is open for orders')
      ),
      el('div', { class: 'field' },
        el('label', { class: 'field__label' }, 'Announcement'),
        announcement,
        el('p', { class: 'field__hint' }, 'Leave blank to hide it.')
      ),
      save
    ),
    el('section', { class: 'card card--flat' },
      el('h2', { class: 'card__title' }, '📊 Google Sheets'),
      el('p', { class: 'muted' },
        summary.integrations.sheets
          ? 'Connected. Approved orders are appended automatically.'
          : 'Not configured — set the Google service-account variables on the server.'),
      summary.integrations.sheetUrl
        ? el('p', {}, el('a', { href: summary.integrations.sheetUrl, target: '_blank', rel: 'noopener' },
            'Open the spreadsheet ↗'))
        : null,
      summary.integrations.sheets ? syncBtn : null
    ),
    el('section', { class: 'card card--flat' },
      el('h2', { class: 'card__title' }, '💳 PayNow'),
      el('p', { class: 'muted mb0' },
        summary.integrations.paynowDynamic
          ? 'Dynamic QR is on — each order gets its own amount-locked code.'
          : 'Using the static poster QR. Set PAYNOW_PROXY_VALUE on the server to lock amounts per order.')
    )
  );
}

// ===========================================================================
// Shell
// ===========================================================================

export function renderAdmin() {
  const root = el('div', {});
  const body = el('div', {}, skeletons(3));

  root.append(tabBar((tab) => { state.adminTab = tab; emit(); }), body);

  api.adminSummary()
    .then((summary) => {
      state.pendingCount = summary.stats.pendingReview;
      body.replaceChildren();

      if (state.adminTab === 'queue') {
        body.append(el('div', { class: 'stats' },
          el('div', { class: 'stat' },
            el('div', { class: 'stat__val' }, String(summary.stats.pendingReview)),
            el('div', { class: 'stat__label' }, 'To verify')),
          el('div', { class: 'stat' },
            el('div', { class: 'stat__val' }, String(summary.stats.ordersLast24h)),
            el('div', { class: 'stat__label' }, 'Last 24h')),
          el('div', { class: 'stat' },
            el('div', { class: 'stat__val' }, `$${summary.stats.revenue}`),
            el('div', { class: 'stat__label' }, 'Verified revenue'))
        ));

        if (summary.lowStock.length) {
          body.append(el('section', { class: 'card card--flat' },
            el('h2', { class: 'card__title' }, `📉 Low stock (${summary.lowStock.length})`),
            ...summary.lowStock.slice(0, 8).map((i) => el('div', { class: 'stock-row' },
              el('div', { class: 'stock-row__name' }, itemLabel(i)),
              el('div', { class: 'stock-row__ctrl' },
                el('strong', { style: 'color:var(--warn);' }, `${i.available} left`))
            ))
          ));
        }

        renderQueue(body);
      } else if (state.adminTab === 'stock') {
        renderStock(body);
      } else if (state.adminTab === 'items') {
        renderItems(body);
      } else if (state.adminTab === 'people') {
        renderPeople(body);
      } else {
        renderSettings(body, summary);
      }

      // Refresh the tab-bar badge now that we know the queue depth.
      emitBadge(summary.stats.pendingReview);
    })
    .catch((err) => {
      body.replaceChildren(empty({ icon: '⚠️', title: 'Admin unavailable', text: err.message }));
    });

  return root;
}

function emitBadge(count) {
  const badge = document.getElementById('adminBadge');
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

export default renderAdmin;
