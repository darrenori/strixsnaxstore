/**
 * Bot integration test — the real Telegraf handlers, driven through the real
 * webhook route, against a stub Bot API.
 *
 * Nothing here talks to Telegram: TELEGRAM_API_ROOT points at a local server
 * that records what the bot tried to send and answers the way Telegram would.
 * That makes it possible to assert what a shopper actually sees when they press
 * Start — the thing a signature check and a database test cannot tell you.
 *
 *   DATABASE_URL=postgres://... node tests/bot.integration.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';

// --- the stub Bot API, up before the app reads its config -------------------
const sent = [];

/** Methods the stub should reject, so failure paths can be exercised. */
const failing = new Set();

const telegram = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let payload = {};
    try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* form post */ }
    sent.push({ method, payload });

    if (failing.has(method)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 448',
        parameters: { retry_after: 448 },
      }));
      return;
    }

    // Enough of a reply for Telegraf to consider each call a success.
    const result = {
      getMe: { id: 8900764054, is_bot: true, username: 'snaxstore_bot', first_name: 'Strix Snax Store' },
      getWebhookInfo: { url: '', pending_update_count: 0 },
      sendMessage: { message_id: sent.length, date: Math.floor(Date.now() / 1000), text: payload.text },
    }[method] ?? true;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise((r) => telegram.listen(0, '127.0.0.1', r));

const BOT = '8900764054:BOT-TEST-TOKEN';
process.env.TELEGRAM_BOT_TOKEN = BOT;
process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${telegram.address().port}`;
process.env.TELEGRAM_WEBHOOK_SECRET = 'bot-webhook-secret';
process.env.MIGRATE_SECRET = 'bot-migrate-secret';
process.env.PUBLIC_URL = 'https://snax.example.com';
process.env.DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres@localhost/strix?host=/var/tmp&port=5440';
process.env.DATABASE_SSL = 'false';
process.env.SHEETS_ENABLED = 'false';
process.env.PAYNOW_PROXY_TYPE = 'mobile';
process.env.PAYNOW_PROXY_VALUE = '+6591234567';
process.env.ADMIN_TELEGRAM_IDS = '930777';
process.env.LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/index.js');
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`); }
};

let updateId = 1000;

/** Post an update the way Telegram's webhook does, and return what the bot sent. */
async function deliver(text, from) {
  const before = sent.length;
  const res = await fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'bot-webhook-secret',
    },
    body: JSON.stringify({
      update_id: (updateId += 1),
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private', first_name: from.first_name },
        from: { is_bot: false, ...from },
        text,
        entities: text.startsWith('/')
          ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }]
          : [],
      },
    }),
  });
  return { status: res.status, replies: sent.slice(before).filter((c) => c.method === 'sendMessage') };
}

const SHOPPER = { id: 930111, first_name: 'Darren', username: 'darren' };
const ADMIN = { id: 930777, first_name: 'Boss' };

// ---------------------------------------------------------------------------
console.log('\n— the webhook answers Telegram, and only Telegram —');
{
  const start = await deliver('/start', SHOPPER);
  check('a signed update is accepted', start.status === 200, `got ${start.status}`);
  check('/start gets exactly one reply', start.replies.length === 1, `${start.replies.length} replies`);

  const reply = start.replies[0]?.payload ?? {};
  check('the reply is addressed to the shopper', reply.chat_id === SHOPPER.id, String(reply.chat_id));
  check('it greets them by name', (reply.text ?? '').includes('Darren'), reply.text?.slice(0, 60));
  check('it names the store', (reply.text ?? '').includes('STRIX Snax Store'));
  check('it carries the Mini App button',
    reply.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url === 'https://snax.example.com',
    JSON.stringify(reply.reply_markup));
  check('it is sent as HTML, so the bold tags render', reply.parse_mode === 'HTML', reply.parse_mode);
}

// The reply must be on the wire BEFORE the webhook responds: a serverless
// invocation can be frozen the moment its response is sent.
console.log('\n— the reply is sent before the webhook answers —');
{
  const before = sent.length;
  const res = await fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'bot-webhook-secret',
    },
    body: JSON.stringify({
      update_id: (updateId += 1),
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: SHOPPER.id, type: 'private' },
        from: { is_bot: false, ...SHOPPER },
        text: '/id',
        entities: [{ type: 'bot_command', offset: 0, length: 3 }],
      },
    }),
  });
  // No awaiting anything else: by the time the response resolves, the outgoing
  // call must already have happened.
  check('the bot had already replied when the 200 came back', sent.length > before,
    `${sent.length - before} calls made`);
  check('the webhook still answers 200', res.status === 200, String(res.status));
}

// ---------------------------------------------------------------------------
console.log('\n— the commands a shopper will actually type —');
{
  const menu = await deliver('/menu', SHOPPER);
  const text = menu.replies[0]?.payload?.text ?? '';
  check('/menu lists the categories', text.includes('HELLO PANDA'), text.slice(0, 80));
  check('/menu shows a price', /\$\d+\.\d\d/.test(text));
  check('/menu names the collection point', text.includes('Blk B'), text.slice(0, 120));

  const id = await deliver('/id', SHOPPER);
  check('/id reports the shopper’s own id',
    (id.replies[0]?.payload?.text ?? '').includes(String(SHOPPER.id)));

  const orders = await deliver('/orders', SHOPPER);
  check('/orders answers even with no history', orders.replies.length === 1,
    orders.replies[0]?.payload?.text?.slice(0, 60));

  const help = await deliver('/help', SHOPPER);
  check('/help lists every command',
    ['/start', '/menu', '/orders', '/id', '/admin']
      .every((c) => (help.replies[0]?.payload?.text ?? '').includes(c)));
}

// ---------------------------------------------------------------------------
console.log('\n— /admin is for admins —');
{
  const asShopper = await deliver('/admin', SHOPPER);
  check('a shopper is turned away',
    /admins only/i.test(asShopper.replies[0]?.payload?.text ?? ''),
    asShopper.replies[0]?.payload?.text?.slice(0, 60));

  const asAdmin = await deliver('/admin', ADMIN);
  const text = asAdmin.replies[0]?.payload?.text ?? '';
  check('a bootstrap admin gets the summary', text.includes('Awaiting verification'), text.slice(0, 80));
}

// ---------------------------------------------------------------------------
console.log('\n— pressing Start makes you a known user —');
{
  const { query } = await import('../src/lib/db.js');
  const rows = await query('select telegram_id, username, is_admin from app_users where telegram_id = $1',
    [SHOPPER.id]);
  check('the shopper was recorded', rows.length === 1, JSON.stringify(rows));
  check('their username was captured', rows[0]?.username === 'darren', rows[0]?.username);
  check('they are not an admin', rows[0]?.is_admin === false);

  const admins = await query('select is_admin from app_users where telegram_id = $1', [ADMIN.id]);
  check('the bootstrap id was promoted on sight', admins[0]?.is_admin === true);
}

// ---------------------------------------------------------------------------
console.log('\n— a poison update cannot wedge the queue —');
{
  const res = await fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'bot-webhook-secret',
    },
    body: JSON.stringify({ update_id: (updateId += 1), nonsense: true }),
  });
  check('an update the bot cannot parse is still acknowledged', res.status === 200,
    `got ${res.status} — anything else makes Telegram redeliver it forever`);
}

// ---------------------------------------------------------------------------
console.log('\n— the deployment can point Telegram at itself —');
{
  const res = await fetch(
    `${base}/api/admin/telegram/setup?key=bot-migrate-secret&url=https://snax.example.com`,
    { method: 'POST' }
  );
  const body = await res.json();
  check('setup succeeds with the right secret', res.status === 200, JSON.stringify(body).slice(0, 140));
  check('it registered the webhook', body.configured?.webhook === true);
  check('it registered the command list', body.configured?.commands === true);
  check('it registered the menu button', body.configured?.menuButton === true);

  const call = sent.find((c) => c.method === 'setWebhook');
  check('the webhook URL is this deployment',
    call?.payload?.url === 'https://snax.example.com/telegram/webhook', call?.payload?.url);
  check('the webhook is registered with a secret token',
    call?.payload?.secret_token === 'bot-webhook-secret', call?.payload?.secret_token);

  const commands = sent.find((c) => c.method === 'setMyCommands');
  check('all five commands are registered', commands?.payload?.commands?.length === 5,
    String(commands?.payload?.commands?.length));

  const status = await fetch(`${base}/api/admin/telegram/status?key=bot-migrate-secret`);
  const statusBody = await status.json();
  check('status reports the bot identity', statusBody.bot?.username === 'snaxstore_bot',
    JSON.stringify(statusBody).slice(0, 120));
}

// ---------------------------------------------------------------------------
console.log('\n— a rate-limited command list must not leave the bot deaf —');
// Telegram rate-limits setMyCommands hard, and a few restarts in a row is
// enough to earn a several-minute cooldown. The command list is cosmetic; the
// webhook is the whole ballgame, so one must not be able to block the other.
{
  failing.add('setMyCommands');
  const before = sent.length;

  const res = await fetch(
    `${base}/api/admin/telegram/setup?key=bot-migrate-secret&url=https://snax.example.com`,
    { method: 'POST' }
  );
  const body = await res.json();
  failing.delete('setMyCommands');

  check('setup still succeeds', res.status === 200, JSON.stringify(body).slice(0, 140));
  check('the webhook was still registered', body.configured?.webhook === true);
  check('the command list is reported as skipped', body.configured?.commands === false);
  check('and the reason is passed back, not swallowed',
    (body.configured?.skipped ?? []).some((s) => /429|Too Many Requests/.test(s)),
    JSON.stringify(body.configured?.skipped));

  const calls = sent.slice(before).map((c) => c.method);
  check('setWebhook was reached despite the earlier failure', calls.includes('setWebhook'),
    calls.join(','));
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
server.close();
telegram.close();
const { close } = await import('../src/lib/db.js');
await close();
process.exit(fail ? 1 : 0);
