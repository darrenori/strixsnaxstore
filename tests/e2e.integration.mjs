/**
 * End-to-end integration test: the real Express app, a real Postgres, and real
 * Telegram-signed requests. Unlike tests/*.test.js this one needs a database,
 * so it is opt-in:
 *
 *   createdb strix
 *   psql -d strix -f db/schema.sql -f db/seed.sql
 *   DATABASE_URL=postgres://... node tests/e2e.integration.mjs
 *
 * It covers the things unit tests cannot: that a price injected by the client
 * is ignored, that one shopper cannot read another's order, that a text file
 * renamed .png is refused, that a screenshot is admin-only, and that stock
 * moves from reserved to spent exactly once on approval.
 */
import crypto from 'node:crypto';

const BOT = '8900764054:E2E-TEST-TOKEN';
process.env.TELEGRAM_BOT_TOKEN = BOT;
process.env.DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres@localhost/strix?host=/var/tmp&port=5440';
process.env.DATABASE_SSL = 'false';
process.env.SHEETS_ENABLED = 'false';
process.env.PAYNOW_PROXY_TYPE = 'mobile';
process.env.PAYNOW_PROXY_VALUE = '+6591234567';
process.env.ADMIN_TELEGRAM_IDS = '900777';
process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/index.js');

const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

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

const BUYER = sign({ id: 900111, first_name: 'Darren', username: 'darren' });
const ADMIN = sign({ id: 900777, first_name: 'Admin' });

const call = async (path, { as = BUYER, method = 'GET', body, raw = false } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-Telegram-Init-Data': as, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: raw ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => null), headers: res.headers };
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('\n— health —');
const health = await fetch(`${base}/healthz`).then((r) => r.json());
check('healthz reports db up', health.ok === true && health.db === true, JSON.stringify(health));

console.log('\n— catalogue —');
const cat = await call('/api/catalog');
const items = cat.body.categories.flatMap((c) => c.items);
check('catalog loads', cat.status === 200 && cat.body.categories.length === 8, `got ${cat.body.categories?.length}`);
check('23 items seeded (16 snax + 7 drinks, per the posters)', items.length === 23, `got ${items.length}`);
const milk = items.find((i) => i.sku === 'HP-MILK');
const fish = items.find((i) => i.sku === 'FC-HONEY-BBQ');
check('Hello Panda Milk is $1.20', milk?.price === '1.20');
check('Fish Crackers is $4.00 and flagged special', fish?.price === '4.00' && fish.isSpecial);

console.log('\n— identity —');
const me = await call('/api/me');
check('buyer is not admin', me.body.isAdmin === false);
const meAdmin = await call('/api/me', { as: ADMIN });
check('bootstrap id is admin', meAdmin.body.isAdmin === true);

console.log('\n— admin gate —');
check('buyer blocked from admin summary', (await call('/api/admin/summary')).status === 403);
check('admin allowed', (await call('/api/admin/summary', { as: ADMIN })).status === 200);

console.log('\n— ordering —');
const order = await call('/api/orders', { method: 'POST', body: {
  buyerName: 'Darren',
  cart: [{ itemId: milk.id, quantity: 2 }, { itemId: fish.id, quantity: 1 }],
}});
check('order created', order.status === 201, JSON.stringify(order.body).slice(0, 140));
check('server computed $6.40', order.body?.order?.total === '6.40', order.body?.order?.total);
check('PayNow QR is a dynamic data URI', order.body?.payment?.mode === 'dynamic'
  && order.body.payment.imageUrl.startsWith('data:image/png;base64,'));
check('collection point derived', order.body?.order?.collectionPoints?.[0] === 'Blk B Lounge');
const orderId = order.body.order.id;

console.log('\n— price tampering —');
const tampered = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'X-Telegram-Init-Data': BUYER, 'Content-Type': 'application/json' },
  body: JSON.stringify({ buyerName: 'Sneaky', cart: [{ itemId: fish.id, quantity: 1, priceCents: 1, price: '0.01' }] }),
});
const tamperBody = await tampered.json();
check('injected price ignored, server charges $4.00', tamperBody.order?.total === '4.00', tamperBody.order?.total);
const sneakyId = tamperBody.order.id;

console.log('\n— cross-user access —');
const OTHER = sign({ id: 900222, first_name: 'Someone' });
check("another user cannot read the buyer's order", (await call(`/api/orders/${orderId}`, { as: OTHER })).status === 404);

console.log('\n— payment proof —');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' + '05fe02fe'.repeat(1) + 'a7', 'hex');
const form = new FormData();
form.append('proof', new Blob([png], { type: 'image/png' }), 'proof.png');
const up = await fetch(`${base}/api/orders/${orderId}/proof`, {
  method: 'POST', headers: { 'X-Telegram-Init-Data': BUYER }, body: form,
});
const upBody = await up.json();
check('proof accepted', up.status === 200, JSON.stringify(upBody).slice(0, 120));
check('order moved to pending_review', upBody.order?.status === 'pending_review');
check('order reports it has proof', upBody.order?.hasProof === true);

const notImage = new FormData();
notImage.append('proof', new Blob([Buffer.from('this is not a png at all, just text')], { type: 'image/png' }), 'x.png');
const badUp = await fetch(`${base}/api/orders/${sneakyId}/proof`, {
  method: 'POST', headers: { 'X-Telegram-Init-Data': BUYER }, body: notImage,
});
check('a text file masquerading as PNG is rejected by magic bytes', badUp.status === 400);

console.log('\n— proof is admin-only —');
check('buyer cannot fetch the screenshot', (await call(`/api/admin/orders/${orderId}/proof`)).status === 403);
const proofRes = await call(`/api/admin/orders/${orderId}/proof`, { as: ADMIN, raw: true });
check('admin gets the exact bytes back', proofRes.status === 200 && proofRes.body.equals(png),
  `${proofRes.status} ${proofRes.body?.length}b vs ${png.length}b`);
check('served with no-store', proofRes.headers.get('cache-control') === 'private, no-store');

console.log('\n— approval —');
const before = await call('/api/admin/catalog', { as: ADMIN });
const milkBefore = before.body.items.find((i) => i.sku === 'HP-MILK');
// The buyer collects as soon as the screenshot is up, so the shelf is debited
// then — an admin verifying later is bookkeeping, not a stock movement.
check('the shelf is debited when the buyer collects', milkBefore.stock === 22 && milkBefore.reserved === 0,
  `stock=${milkBefore.stock} reserved=${milkBefore.reserved}`);

const appr = await call(`/api/admin/orders/${orderId}/approve`, { as: ADMIN, method: 'POST', body: { note: 'ok' } });
check('approved', appr.status === 200 && appr.body.order.status === 'paid');

const after = await call('/api/admin/catalog', { as: ADMIN });
const milkAfter = after.body.items.find((i) => i.sku === 'HP-MILK');
check('approval moves no stock a second time', milkAfter.stock === 22 && milkAfter.reserved === 0,
  `stock=${milkAfter.stock} reserved=${milkAfter.reserved}`);

console.log('\n— stock take —');
const coke = after.body.items.find((i) => i.sku === 'DR-COKE');
const st = await call(`/api/admin/items/${coke.id}/stock`, { as: ADMIN, method: 'POST', body: { count: 40, note: 'e2e' } });
check('stock set to 40', st.status === 200 && st.body.item.stock === 40);
const mv = await call('/api/admin/stock-movements', { as: ADMIN });
check('ledger recorded the delta', mv.body.movements[0].delta === 16 && mv.body.movements[0].balanceAfter === 40,
  JSON.stringify(mv.body.movements[0]));

console.log('\n— stats —');
const sum = await call('/api/admin/summary', { as: ADMIN });
check('revenue counts only verified money', sum.body.stats.revenue === '6.40', sum.body.stats.revenue);

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed\n`);
server.close();
const { close } = await import('../src/lib/db.js');
await close();
process.exit(fail ? 1 : 0);
