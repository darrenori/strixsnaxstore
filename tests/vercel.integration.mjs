/**
 * Serverless-shape integration test.
 *
 * Drives api/index.js the way Vercel does — as a bare Node request handler,
 * with the JSON body already read and parsed before the handler runs. That
 * last detail is the one that silently breaks Express on serverless: its body
 * parsers wait on a stream that has already been consumed, and the request
 * hangs until the function times out. Needs a database; see e2e.integration.mjs.
 */
process.env.TELEGRAM_BOT_TOKEN = '8900764054:TEST';
process.env.DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres@localhost/strix?host=/var/tmp&port=5440';
process.env.DATABASE_SSL = 'false';
process.env.SHEETS_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

import http from 'node:http';
const handler = (await import('../api/index.js')).default;

// Vercel wraps the exported app in its own server, so this is the same shape.
const server = http.createServer((req, res) => {
  // Vercel's Node runtime parses JSON bodies before the handler sees them.
  if (req.method === 'POST' && req.headers['content-type']?.includes('json')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { req.body = JSON.parse(raw || '{}'); } catch { req.body = {}; }
      handler(req, res);
    });
  } else {
    handler(req, res);
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n} ${x}`)); };

const health = await fetch(`${base}/healthz`);
const hb = await health.json();
check('function serves /healthz against the real db', health.status === 200 && hb.db === true, JSON.stringify(hb));

const shell = await fetch(`${base}/`);
check('function serves the Mini App shell', shell.status === 200 && (await shell.text()).includes('STRIX Snax Store'));

const api401 = await fetch(`${base}/api/catalog`);
check('api still requires a Telegram signature', api401.status === 401);

// The key serverless risk: a body Vercel already consumed.
const preParsed = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': 'bogus' },
  body: JSON.stringify({ buyerName: 'x', cart: [] }),
});
check('a pre-parsed POST body does not hang the handler', preParsed.status === 401, String(preParsed.status));

console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
server.close();
const { close } = await import('../src/lib/db.js');
await close();
process.exit(fail ? 1 : 0);
