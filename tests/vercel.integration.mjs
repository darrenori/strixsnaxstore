/**
 * Serverless-shape integration test.
 *
 * Drives api/index.js the way Vercel does — as a bare Node request handler,
 * with the request body already read before the handler runs. That last detail
 * is the one that silently breaks Express on serverless: its body parsers wait
 * on a stream that has already been consumed, and the request hangs until the
 * function times out. Vercel does this to every body, not just JSON, which is
 * why the screenshot upload gets its own test here — a hang on that path would
 * mean nobody can ever pay. Needs a database; see e2e.integration.mjs.
 */
import crypto from 'node:crypto';
import http from 'node:http';

const BOT = '8900764054:VERCEL-TEST-TOKEN';
process.env.TELEGRAM_BOT_TOKEN = BOT;
process.env.DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres@localhost/strix?host=/var/tmp&port=5440';
process.env.DATABASE_SSL = 'false';
process.env.SHEETS_ENABLED = 'false';
process.env.PAYNOW_PROXY_TYPE = 'mobile';
process.env.PAYNOW_PROXY_VALUE = '+6591234567';
process.env.MIGRATE_SECRET = 'vercel-migrate-secret';
process.env.LOG_LEVEL = 'error';

const handler = (await import('../api/index.js')).default;

/**
 * Vercel's Node runtime reads the whole body before calling the handler: JSON
 * arrives parsed, anything else arrives as a Buffer. Reproduce both.
 */
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return handler(req, res);

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (req.headers['content-type']?.includes('json')) {
      try { req.body = JSON.parse(raw.toString() || '{}'); } catch { req.body = {}; }
    } else if (raw.length) {
      req.body = raw;
    }
    handler(req, res);
  });
  return undefined;
});
await new Promise((r) => server.listen(0, r));
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
const BUYER = sign({ id: 920111, first_name: 'Serverless' });

let pass = 0;
let fail = 0;
const check = (n, c, x = '') => {
  if (c) { pass += 1; console.log(`  OK   ${n}`); }
  else { fail += 1; console.log(`  FAIL ${n}${x ? `  — ${x}` : ''}`); }
};

/** Anything that hangs here would hang the real function too, so time it out. */
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms).unref();
  }),
]);

const health = await fetch(`${base}/healthz`);
const hb = await health.json();
check('the function serves /healthz against the real db', health.status === 200 && hb.db === true,
  JSON.stringify(hb));

const shell = await fetch(`${base}/`);
check('the function serves the Mini App shell',
  shell.status === 200 && (await shell.text()).includes('STRIX Snax Store'));

const api401 = await fetch(`${base}/api/catalog`);
check('the api still requires a Telegram signature', api401.status === 401);

// A body Vercel already parsed.
const preParsed = await withTimeout(fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': 'bogus' },
  body: JSON.stringify({ buyerName: 'x', cart: [] }),
}), 5000, 'a pre-parsed JSON POST');
check('a pre-parsed JSON body does not hang the handler', preParsed.status === 401,
  String(preParsed.status));

// The whole buyer path, on a runtime that consumed every byte before we ran.
const catalog = await (await fetch(`${base}/api/catalog`, {
  headers: { 'X-Telegram-Init-Data': BUYER },
})).json();
const item = catalog.categories.flatMap((c) => c.items).find((i) => i.inStock);
check('the catalogue loads for a signed shopper', Boolean(item), 'no purchasable item found');

const placed = await withTimeout(fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': BUYER },
  body: JSON.stringify({ buyerName: 'Serverless', cart: [{ itemId: item.id, quantity: 1 }] }),
}), 5000, 'placing an order');
const placedBody = await placed.json();
check('an order can be placed', placed.status === 201, JSON.stringify(placedBody).slice(0, 140));

// The one that matters: multipart, on a stream the runtime already drained.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c636000000200010005fe02fea7', 'hex');
const form = new FormData();
form.append('proof', new Blob([PNG], { type: 'image/png' }), 'proof.png');

const upload = await withTimeout(fetch(`${base}/api/orders/${placedBody.order.id}/proof`, {
  method: 'POST', headers: { 'X-Telegram-Init-Data': BUYER }, body: form,
}), 8000, 'the screenshot upload').catch((err) => ({ status: 0, error: err.message }));

if (upload.status === 0) {
  check('a screenshot upload survives a pre-read body', false, upload.error);
} else {
  const body = await upload.json();
  check('a screenshot upload survives a pre-read body', upload.status === 200,
    `${upload.status} ${JSON.stringify(body).slice(0, 120)}`);
  check('the order reached the review queue', body.order?.status === 'pending_review',
    body.order?.status);
}

// The deployment bootstrap endpoints have to be reachable on this shape too.
const migrateStatus = await fetch(`${base}/api/admin/migrate/status?key=vercel-migrate-secret`);
const migrateBody = await migrateStatus.json();
check('the migrate status endpoint answers', migrateStatus.status === 200 && migrateBody.migrated === true,
  JSON.stringify(migrateBody).slice(0, 120));

const setupUnauthorised = await fetch(`${base}/api/admin/telegram/setup?key=wrong`, { method: 'POST' });
check('telegram setup refuses a wrong secret', setupUnauthorised.status === 401,
  String(setupUnauthorised.status));

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed`);
server.close();
const { close } = await import('../src/lib/db.js');
await close();
process.exit(fail ? 1 : 0);
