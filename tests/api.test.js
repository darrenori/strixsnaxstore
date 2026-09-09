import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BOT_TOKEN = '8900764054:TEST-TOKEN-FOR-UNIT-TESTS-ONLY';
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/testdb';
process.env.DATABASE_SSL = 'false';
process.env.SHEETS_ENABLED = 'false';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { default: app } = await import('../src/index.js');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => server.close(resolve)));

function signInitData(fields) {
  const params = new URLSearchParams(fields);
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex'));
  return params.toString();
}

test('health check answers without any Telegram data', async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(body.service, 'strix-snax-store');
  // The check touches Postgres, so it means "can serve orders", not merely
  // "process is alive". No database is reachable in tests, so it must fail -
  // a 200 here would mean the check is not actually checking anything.
  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.db, false);
});

test('the Mini App shell is served at the root', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /STRIX Snax Store/);
  assert.match(html, /telegram-web-app\.js/, 'loads the Telegram SDK');
});

test('unknown non-API paths fall back to the shell for client routing', async () => {
  const res = await fetch(`${base}/orders`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<div id="app"/);
});

test('the API refuses a request with no Telegram signature', async () => {
  const res = await fetch(`${base}/api/catalog`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'MISSING_INIT_DATA');
});

test('the API refuses a forged signature', async () => {
  const res = await fetch(`${base}/api/catalog`, {
    headers: { 'X-Telegram-Init-Data': 'user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeef' },
  });
  assert.equal(res.status, 401);
});

test('the API refuses a valid signature that has expired', async () => {
  const stale = signInitData({
    user: JSON.stringify({ id: 1, first_name: 'Old' }),
    auth_date: String(Math.floor(Date.now() / 1000) - 60 * 60 * 72),
  });
  const res = await fetch(`${base}/api/catalog`, { headers: { 'X-Telegram-Init-Data': stale } });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'INIT_DATA_EXPIRED');
});

test('admin routes are unreachable without a signature', async () => {
  for (const path of ['/api/admin/summary', '/api/admin/orders', '/api/admin/catalog']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, `${path} must not be readable anonymously`);
  }
});

test('a signed request gets past auth and reaches the data layer', async () => {
  // Supabase is unreachable in tests, so a 5xx here proves the signature was
  // accepted and the request went on to query - which is what we want to know.
  const initData = signInitData({
    user: JSON.stringify({ id: 42, first_name: 'Test' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
  const res = await fetch(`${base}/api/catalog`, { headers: { 'X-Telegram-Init-Data': initData } });
  assert.notEqual(res.status, 401, 'the signature itself was accepted');
});

test('security headers are present on the shell', async () => {
  const res = await fetch(`${base}/`);
  assert.ok(res.headers.get('content-security-policy'), 'CSP is set');
  assert.equal(res.headers.get('x-powered-by'), null, 'framework fingerprint is hidden');
  assert.ok(res.headers.get('x-content-type-options'), 'nosniff is set');
});

test('the CSP allows Telegram to frame the app', async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors[^;]*telegram\.org/);
  assert.match(csp, /img-src[^;]*data:/, 'generated QR data URIs are allowed');
});
