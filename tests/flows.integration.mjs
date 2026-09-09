/**
 * Adversarial flow tests - the paths a shopper or an admin can actually reach
 * that the happy-path e2e never exercises.
 *
 * Everything here is about state transitions and money: stock that must come
 * back when an order dies, stock that must not be spent twice, and the guards
 * on every public URL. Needs a database, same as e2e.integration.mjs:
 *
 *   DATABASE_URL=postgres://... node tests/flows.integration.mjs
 *
 * Each scenario uses its own Telegram id so one shopper's open-order cap or
 * rate-limit budget cannot bleed into the next.
 */
import crypto from 'node:crypto';

const BOT = '8900764054:FLOW-TEST-TOKEN';
process.env.TELEGRAM_BOT_TOKEN = BOT;
process.env.DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres@localhost/strix?host=/var/tmp&port=5440';
process.env.DATABASE_SSL = 'false';
process.env.SHEETS_ENABLED = 'false';
process.env.PAYNOW_PROXY_TYPE = 'mobile';
process.env.PAYNOW_PROXY_VALUE = '+6591234567';
process.env.ADMIN_TELEGRAM_IDS = '910777';
process.env.CRON_SECRET = 'flow-cron-secret';
process.env.MIGRATE_SECRET = 'flow-migrate-secret';
process.env.TELEGRAM_WEBHOOK_SECRET = 'flow-webhook-secret';
process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/index.js');

const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

// The app's own pool, reused for the setup a public API deliberately does not
// offer (rewinding an expiry clock, forcing a stock level). Borrowing it rather
// than opening a second connection keeps the test honest about how many
// connections the app really needs.
const { query: dbQuery, close: dbClose } = await import('../src/lib/db.js');

function sign(user) {
  const p = new URLSearchParams({
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  const pairs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(pairs).digest('hex'));
  return p.toString();
}

const ADMIN = sign({ id: 910777, first_name: 'Admin' });
const buyer = (id, name) => sign({ id, first_name: name });

const call = async (path, { as = ADMIN, method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-Telegram-Init-Data': as, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c636000000200010005fe02fea7', 'hex');

async function uploadProof(orderId, as) {
  const form = new FormData();
  form.append('proof', new Blob([PNG], { type: 'image/png' }), 'proof.png');
  const res = await fetch(`${base}/api/orders/${orderId}/proof`, {
    method: 'POST', headers: { 'X-Telegram-Init-Data': as }, body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `  - ${extra}` : ''}`); }
};

/** Read stock/reserved straight from the table; the API rounds them away. */
const stockOf = async (sku) =>
  (await dbQuery('select stock, reserved from items where sku = $1', [sku]))[0];

const setStockRow = (sku, stock) =>
  dbQuery('update items set stock = $2, reserved = 0 where sku = $1', [sku, stock]);

const catalog = await call('/api/catalog', { as: ADMIN });
const items = catalog.body.categories.flatMap((c) => c.items);
const bySku = (sku) => {
  const found = items.find((i) => i.sku === sku);
  if (!found) throw new Error(`No seeded item with SKU ${sku} - db/seed.sql has moved`);
  return found;
};

// ---------------------------------------------------------------------------
console.log('\n- the shelf is debited once, when the buyer collects -');
// The buyer takes their snacks the moment the screenshot is up, so the shelf
// is debited there and nowhere else. Rejection cannot credit it back - the
// packets are in someone's bag - and neither a re-submission nor a later
// approval may debit it a second time.
{
  const B = buyer(910101, 'Rejected');
  const item = bySku('DR-COKE');
  await setStockRow('DR-COKE', 5);

  const placed = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Rejected', cart: [{ itemId: item.id, quantity: 3 }] },
  });
  check('order placed', placed.status === 201, JSON.stringify(placed.body).slice(0, 120));
  const id = placed.body.order.id;
  check('3 units held while they pay', (await stockOf('DR-COKE')).reserved === 3);
  check('but not yet taken off the shelf', (await stockOf('DR-COKE')).stock === 5);

  const up = await uploadProof(id, B);
  check('the screenshot is accepted', up.status === 200, JSON.stringify(up.body).slice(0, 120));
  check('the buyer is told to collect', up.body.order?.collectNow === true);
  const afterUpload = await stockOf('DR-COKE');
  check('the shelf is debited immediately', afterUpload.stock === 2 && afterUpload.reserved === 0,
    JSON.stringify(afterUpload));

  const rej = await call(`/api/admin/orders/${id}/reject`, { method: 'POST', body: { note: 'blurry' } });
  check('an admin can still reject it later', rej.status === 200 && rej.body.order.status === 'rejected');
  check('rejection invents no stock back', (await stockOf('DR-COKE')).stock === 2,
    'the snacks are gone; crediting the shelf would make the count a lie');

  const second = await uploadProof(id, B);
  check('a clearer screenshot is accepted', second.status === 200, `got ${second.status}`);
  check('and moves no stock', (await stockOf('DR-COKE')).stock === 2);

  const appr = await call(`/api/admin/orders/${id}/approve`, { method: 'POST', body: {} });
  check('approving settles it', appr.status === 200 && appr.body.order.status === 'paid');
  const finalStock = await stockOf('DR-COKE');
  check('with the shelf still debited exactly once',
    finalStock.stock === 2 && finalStock.reserved === 0, JSON.stringify(finalStock));
}

// ---------------------------------------------------------------------------
console.log('\n- nobody can collect and then cancel -');
// Cancelling used to be allowed right up until an admin reviewed the order.
// Now that collecting happens first, that same window would let someone walk
// off with the snacks and then erase what they owe.
{
  const B = buyer(910115, 'Slippery');
  const item = bySku('RC-CHEESE');
  await setStockRow('RC-CHEESE', 6);

  const placed = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Slippery', cart: [{ itemId: item.id, quantity: 2 }] },
  });
  const id = placed.body.order.id;

  const early = await call(`/api/orders/${id}/cancel`, { as: B, method: 'POST' });
  check('cancelling before collecting is fine', early.status === 200, `got ${early.status}`);
  check('and the hold comes back', (await stockOf('RC-CHEESE')).reserved === 0);

  const second = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Slippery', cart: [{ itemId: item.id, quantity: 2 }] },
  });
  const collectedId = second.body.order.id;
  await uploadProof(collectedId, B);
  check('the shelf is debited on collection', (await stockOf('RC-CHEESE')).stock === 4);

  const late = await call(`/api/orders/${collectedId}/cancel`, { as: B, method: 'POST' });
  check('cancelling after collecting is refused', late.status === 409, `got ${late.status}`);
  check('the buyer is told why', /collected/i.test(late.body?.error ?? ''), late.body?.error);
  check('and the debt stands', (await stockOf('RC-CHEESE')).stock === 4);

  const after = await call(`/api/orders/${collectedId}`, { as: B });
  check('the order is still awaiting verification',
    after.body.order.status === 'pending_review', after.body.order?.status);
}


// ---------------------------------------------------------------------------
console.log('\n- approving twice must not deduct twice -');
{
  const B = buyer(910102, 'Doubler');
  const item = bySku('HP-MILK');
  await setStockRow('HP-MILK', 10);

  const placed = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Doubler', cart: [{ itemId: item.id, quantity: 2 }] },
  });
  const id = placed.body.order.id;
  await uploadProof(id, B);

  await call(`/api/admin/orders/${id}/approve`, { method: 'POST', body: {} });
  const afterOne = await stockOf('HP-MILK');
  await call(`/api/admin/orders/${id}/approve`, { method: 'POST', body: {} });
  const afterTwo = await stockOf('HP-MILK');

  check('the first approval spends the stock', afterOne.stock === 8 && afterOne.reserved === 0,
    JSON.stringify(afterOne));
  check('the second approval changes nothing', afterTwo.stock === 8 && afterTwo.reserved === 0,
    JSON.stringify(afterTwo));
}

// ---------------------------------------------------------------------------
console.log('\n- a cancelled order puts its stock back -');
{
  const B = buyer(910103, 'Canceller');
  const item = bySku('RC-BBQ');
  await setStockRow('RC-BBQ', 6);

  const placed = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Canceller', cart: [{ itemId: item.id, quantity: 4 }] },
  });
  const id = placed.body.order.id;
  check('4 held', (await stockOf('RC-BBQ')).reserved === 4);

  const cancelled = await call(`/api/orders/${id}/cancel`, { as: B, method: 'POST' });
  check('the buyer cancelled', cancelled.status === 200 && cancelled.body.order.status === 'cancelled');
  check('stock is back on the shelf', (await stockOf('RC-BBQ')).reserved === 0);

  const again = await call(`/api/orders/${id}/cancel`, { as: B, method: 'POST' });
  check('cancelling twice is refused, not double-released', again.status === 409, `got ${again.status}`);
  check('reserved did not go negative', (await stockOf('RC-BBQ')).reserved === 0);

  const approve = await call(`/api/admin/orders/${id}/approve`, { method: 'POST', body: {} });
  check('a cancelled order cannot be approved', approve.status === 409, `got ${approve.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n- an abandoned checkout releases its hold -');
{
  const B = buyer(910104, 'Ghost');
  const item = bySku('ND-NISSIN-TOMYAM');
  await setStockRow('ND-NISSIN-TOMYAM', 8);

  const placed = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Ghost', cart: [{ itemId: item.id, quantity: 5 }] },
  });
  const id = placed.body.order.id;
  check('5 held while they pay', (await stockOf('ND-NISSIN-TOMYAM')).reserved === 5);

  // Wind the clock back rather than waiting 45 minutes.
  await dbQuery("update orders set expires_at = now() - interval '1 minute' where id = $1", [id]);

  const cron = await fetch(`${base}/api/cron/janitor`, {
    headers: { Authorization: 'Bearer flow-cron-secret' },
  });
  const cronBody = await cron.json();
  check('the janitor ran', cron.status === 200 && cronBody.expired >= 1, JSON.stringify(cronBody));
  check('the hold was released', (await stockOf('ND-NISSIN-TOMYAM')).reserved === 0);

  const after = await call(`/api/orders/${id}`, { as: B });
  check('the order reads as cancelled', after.body.order.status === 'cancelled', after.body.order?.status);
}

// ---------------------------------------------------------------------------
console.log('\n- nobody can pin the shelf with unpaid orders -');
{
  const B = buyer(910105, 'Hoarder');
  const item = bySku('LP-ALMOND');
  await setStockRow('LP-ALMOND', 40);

  const results = [];
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await call('/api/orders', {
      as: B,
      method: 'POST',
      body: { buyerName: 'Hoarder', cart: [{ itemId: item.id, quantity: 1 }] },
    }));
  }
  check('the first three are allowed', results.slice(0, 3).every((r) => r.status === 201),
    results.map((r) => r.status).join(','));
  check('the fourth is refused', results[3].status === 409, `got ${results[3].status}`);
  check('only three units are held', (await stockOf('LP-ALMOND')).reserved === 3);
}

// ---------------------------------------------------------------------------
console.log('\n- the last packet cannot be sold to two people -');
{
  const A = buyer(910106, 'RaceA');
  const C = buyer(910107, 'RaceC');
  const item = bySku('DR-MILO-PACKET');
  await setStockRow('DR-MILO-PACKET', 1);

  const [first, second] = await Promise.all([
    call('/api/orders', {
      as: A,
      method: 'POST',
      body: { buyerName: 'RaceA', cart: [{ itemId: item.id, quantity: 1 }] },
    }),
    call('/api/orders', {
      as: C,
      method: 'POST',
      body: { buyerName: 'RaceC', cart: [{ itemId: item.id, quantity: 1 }] },
    }),
  ]);
  const created = [first, second].filter((r) => r.status === 201).length;
  check('exactly one shopper got it', created === 1, `${first.status} / ${second.status}`);
  check('never more than one unit held', (await stockOf('DR-MILO-PACKET')).reserved === 1);
}

// ---------------------------------------------------------------------------
console.log('\n- a closed store takes no orders -');
{
  const B = buyer(910108, 'Latecomer');
  const item = bySku('DR-100PLUS');
  await setStockRow('DR-100PLUS', 10);

  await call('/api/admin/settings', { method: 'POST', body: { storeOpen: false } });
  const refused = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Latecomer', cart: [{ itemId: item.id, quantity: 1 }] },
  });
  check('ordering is refused while closed', refused.status === 409, `got ${refused.status}`);
  check('the shopper is told why', /closed/i.test(refused.body?.error ?? ''), refused.body?.error);

  await call('/api/admin/settings', { method: 'POST', body: { storeOpen: true } });
  const allowed = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'Latecomer', cart: [{ itemId: item.id, quantity: 1 }] },
  });
  check('reopening lets orders through again', allowed.status === 201, `got ${allowed.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n- one shopper cannot touch another shopper’s order -');
{
  const OWNER = buyer(910109, 'Owner');
  const OTHER = buyer(910110, 'Other');
  const item = bySku('FC-HONEY-BBQ');
  await setStockRow('FC-HONEY-BBQ', 10);

  const placed = await call('/api/orders', {
    as: OWNER,
    method: 'POST',
    body: { buyerName: 'Owner', cart: [{ itemId: item.id, quantity: 1 }] },
  });
  const id = placed.body.order.id;

  check('a stranger cannot read it', (await call(`/api/orders/${id}`, { as: OTHER })).status === 404);
  check('a stranger cannot cancel it',
    (await call(`/api/orders/${id}/cancel`, { as: OTHER, method: 'POST' })).status === 404);
  const proof = await uploadProof(id, OTHER);
  check('a stranger cannot attach a screenshot to it', proof.status === 404, `got ${proof.status}`);
  const owned = await call(`/api/orders/${id}`, { as: OWNER });
  check('the order is untouched', owned.body.order.status === 'awaiting_payment', owned.body.order?.status);
}

// ---------------------------------------------------------------------------
console.log('\n- a blocked shopper is shut out -');
{
  const B = buyer(910111, 'Blocked');
  await call('/api/me', { as: B });                       // exist first
  await call('/api/admin/users/block', { method: 'POST', body: { telegramId: 910111, isBlocked: true } });
  const after = await call('/api/catalog', { as: B });
  check('a blocked shopper cannot even read the menu', after.status === 403, `got ${after.status}`);
  await call('/api/admin/users/block', { method: 'POST', body: { telegramId: 910111, isBlocked: false } });
  check('unblocking restores access', (await call('/api/catalog', { as: B })).status === 200);
}

// ---------------------------------------------------------------------------
console.log('\n- the public URLs that do real work are all guarded -');
{
  const noKey = await fetch(`${base}/api/cron/janitor`);
  check('the janitor refuses an unsigned call', noKey.status === 401, `got ${noKey.status}`);

  const badKey = await fetch(`${base}/api/cron/janitor?key=wrong`);
  check('the janitor refuses a wrong key', badKey.status === 401, `got ${badKey.status}`);

  const badMigrate = await fetch(`${base}/api/admin/migrate?key=wrong`, { method: 'POST' });
  check('migrate refuses a wrong secret', badMigrate.status === 401, `got ${badMigrate.status}`);

  const badHook = await fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'nope' },
    body: JSON.stringify({ update_id: 1 }),
  });
  check('the webhook refuses a wrong secret token', badHook.status === 401, `got ${badHook.status}`);

  const noHookSecret = await fetch(`${base}/telegram/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 1 }),
  });
  check('the webhook refuses a missing secret token', noHookSecret.status === 401, `got ${noHookSecret.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n- a shopper cannot act as an admin -');
{
  const B = buyer(910113, 'Wannabe');
  const coke = bySku('DR-COKE');
  check('cannot set stock', (await call(`/api/admin/items/${coke.id}/stock`,
    { as: B, method: 'POST', body: { count: 999 } })).status === 403);
  check('cannot list users', (await call('/api/admin/users', { as: B })).status === 403);
  check('cannot promote themselves', (await call('/api/admin/users/role',
    { as: B, method: 'POST', body: { telegramId: 910113, isAdmin: true } })).status === 403);
  check('stock is untouched', (await stockOf('DR-COKE')).stock !== 999);
}

// ---------------------------------------------------------------------------
console.log('\n- an admin cannot lock everyone out -');
{
  const self = await call('/api/admin/users/role', { method: 'POST', body: { telegramId: 910777, isAdmin: false } });
  check('an admin cannot demote themselves', self.status === 400, `got ${self.status}`);
  check('they are still an admin', (await call('/api/me')).body.isAdmin === true);
}

// ---------------------------------------------------------------------------
console.log('\n- malformed carts are refused before they reach the database -');
{
  const B = buyer(910114, 'Fuzzer');
  const item = bySku('DR-COKE');
  await setStockRow('DR-COKE', 12);
  const cases = [
    ['a quantity of zero', { buyerName: 'F', cart: [{ itemId: item.id, quantity: 0 }] }],
    ['a negative quantity', { buyerName: 'F', cart: [{ itemId: item.id, quantity: -5 }] }],
    ['a fractional quantity', { buyerName: 'F', cart: [{ itemId: item.id, quantity: 1.5 }] }],
    ['a quantity past 99', { buyerName: 'F', cart: [{ itemId: item.id, quantity: 100 }] }],
    ['an empty cart', { buyerName: 'F', cart: [] }],
    ['no name', { buyerName: '', cart: [{ itemId: item.id, quantity: 1 }] }],
    ['an item id that is not a uuid', { buyerName: 'F', cart: [{ itemId: 'not-a-uuid', quantity: 1 }] }],
  ];
  for (const [label, body] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('/api/orders', { as: B, method: 'POST', body });
    check(`${label} is refused`, res.status === 400, `got ${res.status}`);
  }
  const ghost = await call('/api/orders', {
    as: B,
    method: 'POST',
    body: { buyerName: 'F', cart: [{ itemId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] },
  });
  check('an item id that does not exist is refused', ghost.status === 409, `got ${ghost.status}`);
  check('nothing was reserved by any of that', (await stockOf('DR-COKE')).reserved === 0);
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
server.close();
await dbClose();
process.exit(fail ? 1 : 0);
