import { el, itemLabel, empty, skeletons } from '../ui.js';
import { state, cartQty, setQty, addToCart, emit } from '../store.js';
import { onCartChange } from '../patch.js';
import { haptic } from '../tg.js';

/**
 * Every quantity control on screen, by item id.
 *
 * Adding a packet used to redraw the entire menu. Keeping a handle on the one
 * control that changed means a tap updates a number and a disabled attribute,
 * which is what it looked like it was doing all along.
 */
const controls = new Map();

/** The +/- stepper, or a plain ADD button when the item is not in the cart yet. */
function quantityControl(item) {
  const slot = el('div', { class: 'item__action' });
  paintControl(slot, item);
  controls.set(item.id, { slot, item });
  return slot;
}

function paintControl(slot, item) {
  const qty = cartQty(item.id);

  if (!item.inStock) {
    slot.replaceChildren(el('button', { class: 'add-btn', disabled: true }, 'SOLD OUT'));
    return;
  }

  if (qty === 0) {
    slot.replaceChildren(el('button', {
      class: 'add-btn',
      'aria-label': `Add ${itemLabel(item)} to cart`,
      onClick: () => { haptic('light'); addToCart(item.id, 1); },
    }, 'ADD'));
    return;
  }

  slot.replaceChildren(el('div', { class: 'qty' },
    el('button', {
      class: 'qty__btn',
      'aria-label': `Remove one ${itemLabel(item)}`,
      onClick: () => { haptic('light'); setQty(item.id, cartQty(item.id) - 1); },
    }, '−'),
    el('span', { class: 'qty__val', 'aria-live': 'polite' }, String(qty)),
    el('button', {
      class: 'qty__btn',
      'aria-label': `Add one ${itemLabel(item)}`,
      disabled: qty >= item.available,
      onClick: () => {
        if (cartQty(item.id) >= item.available) return;
        haptic('light');
        setQty(item.id, cartQty(item.id) + 1);
      },
    }, '+')
  ));
}

function stockMeta(item) {
  if (!item.inStock) return el('span', { class: 'item__meta is-out' }, 'Out of stock');
  if (item.isLow) return el('span', { class: 'item__meta is-low' }, `Only ${item.available} left`);
  return null;
}

/**
 * One purchasable line.
 *
 * `label` is passed in because how an item names itself depends on where it
 * sits: the poster writes "MILK" under a Hello Panda heading, not
 * "HELLO PANDA - MILK". Prices are dropped on rows that sit under a group
 * header carrying the shared price, again mirroring the poster.
 */
function itemRow(item, { label, showPrice = true, showDesc = true, sub = false } = {}) {
  const name = el('h3', { class: 'item__name' }, label ?? item.name);
  if (item.isTopPick) name.append(el('span', { class: 'tag tag--top' }, 'Top pick'));
  if (item.isSpecial && !sub) name.append(el('span', { class: 'tag tag--special' }, 'Special'));

  const meta = stockMeta(item);
  const desc = showDesc && item.description
    ? el('p', { class: 'item__desc' }, item.description)
    : null;

  // Rows with nothing under the name collapse to a single line, so a menu of
  // two dozen items is a menu and not a scroll.
  const classes = ['item'];
  if (sub) classes.push('item--sub');
  if (!item.inStock) classes.push('is-out');
  if (!desc && !meta) classes.push('item--tight');

  return el('article', { class: classes.join(' ') },
    name,
    showPrice ? el('span', { class: 'item__price' }, `$${item.price}`) : null,
    desc,
    meta,
    quantityControl(item)
  );
}

/**
 * Split a category into the runs the poster draws: consecutive items sharing a
 * product name are one block ("NISSIN CUP NOODLES" and its four flavours),
 * everything else stands alone.
 */
function groupItems(items) {
  const groups = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.name === item.name) last.items.push(item);
    else groups.push({ name: item.name, items: [item] });
  }
  return groups;
}

/** True when every item carries exactly the same description text. */
function sharedDescription(items) {
  const first = items[0]?.description ?? null;
  if (!first) return null;
  return items.every((i) => i.description === first) ? first : null;
}

function renderGroup(group, category) {
  const { items } = group;
  // The section heading already says "Hello Panda"; repeating it on every row
  // is exactly what the poster avoids.
  const redundant = group.name.toLowerCase() === category.name.toLowerCase();
  const shared = sharedDescription(items);
  const samePrice = items.every((i) => i.price === items[0].price);

  // The tagline under the heading already said this. Printing the shared
  // description as well gives the buyer the same sentence twice.
  const echoesTagline = shared && category.tagline
    && shared.toLowerCase().includes(category.tagline.toLowerCase());
  const groupDesc = shared && !echoesTagline ? shared : null;

  // Single item, or a name that just echoes the section: plain rows.
  if (items.length === 1) {
    const item = items[0];
    const label = redundant && item.variant ? item.variant : itemLabel(item);
    return [itemRow(item, { label })];
  }

  if (redundant) {
    // Hello Panda / Roller Coasters / Fish Crackers / Lotte Pepero: the poster
    // lists each flavour with its own price and no repeated product name.
    const rows = items.map((item) =>
      itemRow(item, { label: item.variant ?? item.name, showDesc: !shared }));
    return groupDesc ? [el('p', { class: 'group__desc' }, groupDesc), ...rows] : rows;
  }

  if (samePrice) {
    // "NISSIN CUP NOODLES  $1.90" then the flavours beneath it.
    const head = el('div', { class: 'group__head' },
      el('h3', { class: 'group__name' }, group.name),
      el('span', { class: 'group__price' }, `$${items[0].price}`)
    );
    const rows = items.map((item) =>
      itemRow(item, { label: item.variant ?? item.name, showPrice: false, showDesc: !shared, sub: true }));
    return [head, groupDesc ? el('p', { class: 'group__desc' }, groupDesc) : null, ...rows]
      .filter(Boolean);
  }

  return items.map((item) => itemRow(item, { label: itemLabel(item) }));
}

function categoryBlock(category) {
  // Hello Panda and the Under $1 deals sit on a solid colour in the posters.
  const panel = category.slug === 'hello-panda' || category.slug === 'under-1-deals';
  const groups = groupItems(category.items);

  return el('section', {
    class: `section section--${category.accent} ${panel ? 'section--panel' : ''}`.trim(),
  },
    el('div', { class: 'section__head' },
      el('h2', { class: 'section__name' }, category.name),
      el('span', { class: 'section__where' }, category.collectionPoint)
    ),
    category.tagline && !panel ? el('p', { class: 'section__tagline' }, category.tagline) : null,
    el('div', { class: 'section__body' }, ...groups.flatMap((g) => renderGroup(g, category)))
  );
}

/** The navy SPECIAL block, mirroring the poster's callout. */
function specialBlock(specials) {
  if (specials.length === 0) return null;
  const hero = specials[0];
  const shared = specials.every((s) => s.name === hero.name && s.price === hero.price);

  return el('section', { class: 'special' },
    el('span', { class: 'special__ribbon' }, 'SPECIAL'),
    el('h2', { class: 'special__name' }, (shared ? hero.name : 'Our picks').toUpperCase()),
    el('p', { class: 'special__price' }, shared ? `$${hero.price}` : ''),
    hero.description ? el('p', { class: 'special__desc' }, hero.description) : null,
    !shared ? el('p', { class: 'special__desc' },
      specials.map((s) => `${itemLabel(s)} $${s.price}`).join(' · ')) : null
  );
}

function hero(store) {
  const announcement = store?.announcement?.trim();
  // The masthead already says the shop is open around the clock, so an
  // announcement that only repeats that is noise on the one screen that has
  // to sell something.
  const worthShowing = announcement
    && !/^we are open 24\/7\b/i.test(announcement.replace(/\s+/g, ' '));

  return el('header', { class: `hero ${store?.open === false ? 'is-closed' : ''}`.trim() },
    el('div', { class: 'badge' },
      el('span', { class: 'badge__ay' }, store?.academicYear ?? 'AY2026/2027'),
      el('span', { class: 'badge__word' }, 'STRIX'),
      el('span', { class: 'badge__script' }, 'Snax Store')
    ),
    el('p', { class: 'hero__open' }, 'WE ARE OPEN 24/7'),
    el('div', { class: 'hero__points' },
      el('span', { class: 'hero__point' }, '🐼 Blk B Lounge'),
      el('span', { class: 'hero__point' }, '🥤 Blk B Pantry')
    ),
    worthShowing ? el('p', { class: 'hero__note' }, announcement) : null
  );
}

function kindSwitch(onChange) {
  const make = (kind, label) => el('button', {
    class: `switch__btn ${state.kind === kind ? 'is-active' : ''}`.trim(),
    type: 'button',
    role: 'tab',
    'aria-selected': state.kind === kind ? 'true' : 'false',
    onClick: () => { if (state.kind !== kind) { haptic('select'); onChange(kind); } },
  }, label);

  // The pill is sticky, so it needs a bar of its own to sit on. Without one
  // the menu scrolls through the gap around it and reads as a rendering fault.
  return el('div', { class: 'switchbar' },
    el('div', { class: 'switch', role: 'tablist' },
      make('snack', '🐼 SNAX'),
      make('drink', '🥤 DRINKS')
    )
  );
}

export function renderShop() {
  controls.clear();
  const root = el('div', {});

  if (!state.catalog) {
    root.append(hero(state.store), skeletons(5));
    return root;
  }

  root.append(hero(state.store));

  if (state.store?.open === false) {
    root.append(el('div', { class: 'closed-banner' },
      '😴 The store is closed right now. Browse the menu and come back soon!'));
  }

  root.append(kindSwitch((kind) => { state.kind = kind; emit(); }));

  const categories = state.catalog.categories.filter((c) => c.kind === state.kind);

  if (categories.length === 0) {
    root.append(empty({
      icon: state.kind === 'drink' ? '🥤' : '🐼',
      title: 'Nothing on the shelf',
      text: 'This section is empty right now, check back later.',
    }));
    return root;
  }

  const specials = (state.catalog.specials ?? []).filter((s) => s.kind === state.kind);
  const special = specialBlock(specials);
  if (special) root.append(special);

  for (const category of categories) root.append(categoryBlock(category));

  root.append(el('p', { class: 'muted center mt' },
    'Snax are collected at Blk B Lounge · Drinks at Blk B Pantry'));

  // One row changed; redraw one row.
  onCartChange(({ itemId }) => {
    const entry = controls.get(itemId);
    if (!entry) return false;
    paintControl(entry.slot, entry.item);
    return true;
  });

  return root;
}

export default renderShop;
