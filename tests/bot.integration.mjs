/**
 * Bot integration test - the real Telegraf handlers, driven through the real
 * webhook route, against a stub Bot API.
 *
 * Nothing here talks to Telegram: TELEGRAM_API_ROOT points at a local server
 * that records what the bot tried to send and answers the way Telegram would.
 * That makes it possible to assert what a shopper actually sees when they press
 * Start - the thing a signature check and a database test cannot tell you.
 *
 *   DATABASE_URL=postgres://... node tests/bot.integration.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';

// --- the stub Bot API, up before the app reads its config -------------------
const sent = [];

/** Methods the stub should reject, so failure paths can be exercised. */
const failing = new Set();

/**
 * A one-pixel PNG, which is what the stub hands back for a file download.
 * Real bytes matter: the shop sniffs magic numbers rather than trusting what
 * anything says it is sending, so a placeholder string would be refused.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const telegram = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // Telegraf downloads a file from /file/bot<token>/<path>, not from a
    // method endpoint, so that path is answered with the bytes themselves.
    if (req.url.includes('/file/bot')) {
      sent.push({ method: 'downloadFile', payload: { url: req.url } });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
      res.end(PNG);
      return;
    }

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
      getFile: { file_id: payload.file_id, file_unique_id: 'u1', file_size: PNG.length, file_path: 'photos/proof.png' },
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
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `  - ${extra}` : ''}`); }
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
console.log('\n- the webhook answers Telegram, and only Telegram -');
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
console.log('\n- the reply is sent before the webhook answers -');
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
console.log('\n- the commands a shopper will actually type -');
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
console.log('\n- /admin is for admins -');
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
console.log('\n- pressing Start makes you a known user -');
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
console.log('\n- a poison update cannot wedge the queue -');
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
    `got ${res.status} - anything else makes Telegram redeliver it forever`);
}

// ---------------------------------------------------------------------------
console.log('\n- the deployment can point Telegram at itself -');
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
console.log('\n- a rate-limited command list must not leave the bot deaf -');
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

// ---------------------------------------------------------------------------
// Payment screenshots now arrive in the chat rather than through the Mini App,
// which makes this the single most important path in the shop: it is how money
// gets proved and how the snacks get released.
// ---------------------------------------------------------------------------

/** Sign init data the way Telegram does, so the API can be driven as a buyer. */
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

const asBuyer = sign({ id: SHOPPER.id, first_name: SHOPPER.first_name, username: SHOPPER.username });
const asAdmin = sign({ id: ADMIN.id, first_name: ADMIN.first_name });

const call = async (path, { as = asBuyer, method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-Telegram-Init-Data': as, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/**
 * Give the fire-and-forget work a moment to land.
 *
 * The buyer's "got it" reply is deliberately not held up by the message to
 * the admins, so the admin notification arrives just after the webhook has
 * already answered. Waiting here is the test agreeing with that design rather
 * than papering over it.
 */
const settle = (ms = 300) => new Promise((r) => { setTimeout(r, ms); });

/** Deliver a photo message the way Telegram's webhook does. */
async function deliverPhoto({ from, caption = undefined, replyToText = undefined, messageId = null }) {
  const before = sent.length;
  const id = messageId ?? (updateId += 1);
  const res = await fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'bot-webhook-secret',
    },
    body: JSON.stringify({
      update_id: (updateId += 1),
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.id, type: 'private', first_name: from.first_name },
        from: { is_bot: false, ...from },
        caption,
        reply_to_message: replyToText
          ? { message_id: id - 1, text: replyToText, from: { is_bot: true, id: 1 } }
          : undefined,
        photo: [
          { file_id: 'small-1', file_unique_id: 's1', width: 90, height: 90, file_size: 400 },
          { file_id: 'big-1', file_unique_id: 'b1', width: 1280, height: 1280, file_size: PNG.length },
        ],
      },
    }),
  });
  await settle();
  return {
    status: res.status,
    messageId: id,
    replies: sent.slice(before).filter((c) => c.method === 'sendMessage'),
    all: sent.slice(before),
  };
}

console.log('\n- a screenshot with nothing waiting for it -');
{
  const shot = await deliverPhoto({ from: SHOPPER });
  check('the webhook still answers 200', shot.status === 200, String(shot.status));
  check('the buyer is told there is nothing to pay for',
    /no order waiting/i.test(shot.replies[0]?.payload?.text ?? ''),
    shot.replies[0]?.payload?.text?.slice(0, 80));
  check('nothing was downloaded', !shot.all.some((c) => c.method === 'downloadFile'));
}

console.log('\n- the Mini App asks the bot to collect the screenshot -');
let orderOne;
{
  const cat = await call('/api/catalog');
  const item = cat.body.categories.flatMap((c) => c.items).find((i) => i.inStock);
  const placed = await call('/api/orders', {
    method: 'POST',
    body: { buyerName: 'Darren', cart: [{ itemId: item.id, quantity: 1 }] },
  });
  orderOne = placed.body.order;
  check('an order can be placed', placed.status === 201, JSON.stringify(placed.body).slice(0, 120));

  const before = sent.length;
  const asked = await call(`/api/orders/${orderOne.id}/request-proof`, { method: 'POST' });
  const prompt = sent.slice(before).find((c) => c.method === 'sendMessage');

  check('the request is accepted', asked.status === 200, JSON.stringify(asked.body).slice(0, 120));
  check('the buyer gets a message', Boolean(prompt), 'no sendMessage');
  check('it goes to the buyer, not an admin', prompt?.payload?.chat_id === SHOPPER.id);
  check('it names the order', (prompt?.payload?.text ?? '').includes(orderOne.code));
  check('it forces a reply, so the photo lands on the right order',
    prompt?.payload?.reply_markup?.force_reply === true,
    JSON.stringify(prompt?.payload?.reply_markup));
  check('the order records that we asked', Boolean(asked.body?.order?.proofRequestedAt));
}

console.log('\n- sending the screenshot settles the order -');
{
  const shot = await deliverPhoto({ from: SHOPPER, replyToText: `Order ${orderOne.code} - $1.20` });
  const texts = shot.replies.map((r) => r.payload.text ?? '');

  check('the largest rendition is the one fetched',
    shot.all.some((c) => c.method === 'getFile' && c.payload.file_id === 'big-1'),
    JSON.stringify(shot.all.filter((c) => c.method === 'getFile').map((c) => c.payload.file_id)));
  check('the bytes were downloaded', shot.all.some((c) => c.method === 'downloadFile'));
  check('the buyer is told to go and collect',
    texts.some((t) => /Got it/.test(t) && t.includes(orderOne.code)),
    texts.join(' | ').slice(0, 140));
  check('an admin is asked to verify',
    shot.replies.some((r) => r.payload.chat_id === ADMIN.id && /verify/i.test(r.payload.text ?? '')),
    JSON.stringify(shot.replies.map((r) => r.payload.chat_id)));

  const after = await call(`/api/orders/${orderOne.id}`);
  check('the order is now in the review queue', after.body?.order?.status === 'pending_review',
    after.body?.order?.status);
  check('it carries a proof', after.body?.order?.hasProof === true);
  check('and records that it came from Telegram', after.body?.order?.proofSource === 'telegram',
    after.body?.order?.proofSource);
  check('the snacks are the buyer’s already', after.body?.order?.collectNow === true);
}

console.log('\n- an admin can read the screenshot the bot stored -');
{
  const res = await fetch(`${base}/api/admin/orders/${orderOne.id}/proof`, {
    headers: { 'X-Telegram-Init-Data': asAdmin },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  check('the image comes back', res.status === 200, String(res.status));
  check('it is stored as a PNG', res.headers.get('content-type') === 'image/png');
  check('and it is the bytes Telegram gave us', bytes.equals(PNG),
    `${bytes.length} vs ${PNG.length}`);
}

console.log('\n- two open orders and no clue which -');
{
  const cat = await call('/api/catalog');
  const items = cat.body.categories.flatMap((c) => c.items).filter((i) => i.inStock);
  const a = await call('/api/orders', {
    method: 'POST', body: { buyerName: 'Darren', cart: [{ itemId: items[0].id, quantity: 1 }] },
  });
  const b = await call('/api/orders', {
    method: 'POST', body: { buyerName: 'Darren', cart: [{ itemId: items[1].id, quantity: 1 }] },
  });
  check('both orders exist', a.status === 201 && b.status === 201);

  const shot = await deliverPhoto({ from: SHOPPER });
  const ask = shot.replies[0]?.payload;
  const buttons = (ask?.reply_markup?.inline_keyboard ?? []).flat();

  check('the buyer is asked which one', /Which order/i.test(ask?.text ?? ''), ask?.text);
  check('both codes are offered',
    buttons.some((x) => x.text.includes(a.body.order.code))
      && buttons.some((x) => x.text.includes(b.body.order.code)),
    JSON.stringify(buttons));
  check('the question is a reply to the photo, so the photo can be found again',
    ask?.reply_parameters?.message_id === shot.messageId,
    JSON.stringify(ask?.reply_parameters));
  check('nothing was filed while the question is open',
    !shot.all.some((c) => c.method === 'downloadFile'));

  // Press the first button. The callback carries the order; the photo is
  // reachable through the message the question replied to.
  const before = sent.length;
  const chosen = buttons[0].callback_data;
  await fetch(`${base}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'bot-webhook-secret',
    },
    body: JSON.stringify({
      update_id: (updateId += 1),
      callback_query: {
        id: 'cb-1',
        from: { is_bot: false, ...SHOPPER },
        chat_instance: 'ci',
        data: chosen,
        message: {
          message_id: shot.messageId + 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: SHOPPER.id, type: 'private' },
          from: { is_bot: true, id: 1 },
          text: 'Which order is that screenshot for?',
          reply_to_message: {
            message_id: shot.messageId,
            chat: { id: SHOPPER.id, type: 'private' },
            from: { is_bot: false, ...SHOPPER },
            photo: [{ file_id: 'big-1', file_unique_id: 'b1', width: 1280, height: 1280 }],
          },
        },
      },
    }),
  });

  const after = sent.slice(before);
  const picked = chosen.slice('proof:'.length);
  check('the button is acknowledged', after.some((c) => c.method === 'answerCallbackQuery'));
  check('the keyboard is taken away so it cannot be filed twice',
    after.some((c) => c.method === 'editMessageReplyMarkup'));
  check('the screenshot is filed against the chosen order',
    after.some((c) => c.method === 'sendMessage' && /Got it/.test(c.payload.text ?? '')),
    after.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text?.slice(0, 40)).join(' | '));

  const state = await call(`/api/orders/${picked}`);
  check('that order moved to review', state.body?.order?.status === 'pending_review',
    state.body?.order?.status);
}

console.log('\n- a code in the caption beats guessing -');
{
  // A second shopper, because the first one is now at the cap of three open
  // orders, which is the shop working as designed.
  const OTHER = { id: 930222, first_name: 'Mei', username: 'mei' };
  const asOther = sign({ id: OTHER.id, first_name: OTHER.first_name, username: OTHER.username });

  const cat = await call('/api/catalog', { as: asOther });
  const item = cat.body.categories.flatMap((c) => c.items).find((i) => i.inStock);
  const placed = await call('/api/orders', {
    as: asOther,
    method: 'POST',
    body: { buyerName: 'Mei', cart: [{ itemId: item.id, quantity: 1 }] },
  });
  check('the second shopper can order', placed.status === 201,
    JSON.stringify(placed.body).slice(0, 120));
  const code = placed.body.order.code;

  const shot = await deliverPhoto({ from: OTHER, caption: `paid for ${code.toLowerCase()}` });
  check('a lower-case code still matches',
    shot.replies.some((r) => (r.payload.text ?? '').includes(code)),
    shot.replies.map((r) => r.payload.text?.slice(0, 50)).join(' | '));

  const after = await call(`/api/orders/${placed.body.order.id}`, { as: asOther });
  check('the captioned order is the one settled', after.body?.order?.status === 'pending_review',
    after.body?.order?.status);

  const stranger = await deliverPhoto({ from: OTHER, caption: 'for SNX-ZZZZZ' });
  check('a code that is not theirs is refused, not guessed at',
    /No order of yours/i.test(stranger.replies[0]?.payload?.text ?? ''),
    stranger.replies[0]?.payload?.text?.slice(0, 80));
}

console.log('\n- the shelf running low tells the admins, once -');
{
  const { query } = await import('../src/lib/db.js');
  const { checkLowStock } = await import('../src/services/collation.service.js');

  const [item] = await query(
    "select id, sku from items where is_active and sku = 'HP-MILK'"
  );
  // Two left is the alert threshold, so this is the crossing.
  await query('update items set stock = 2, reserved = 0, low_stock_alerted_at = null where id = $1',
    [item.id]);

  let before = sent.length;
  await checkLowStock();
  const first = sent.slice(before).filter((c) => c.method === 'sendMessage');
  check('the admin is warned', first.some((c) => c.payload.chat_id === ADMIN.id),
    JSON.stringify(first.map((c) => c.payload.chat_id)));
  check('the message names the item and the count',
    /HP-MILK|Hello Panda/i.test(first[0]?.payload?.text ?? '') && /2/.test(first[0]?.payload?.text ?? ''),
    first[0]?.payload?.text?.slice(0, 120));
  check('the shopper is not told about stock levels',
    !first.some((c) => c.payload.chat_id === SHOPPER.id));

  before = sent.length;
  await checkLowStock();
  check('a second sweep at the same level says nothing',
    sent.slice(before).filter((c) => c.method === 'sendMessage').length === 0,
    `${sent.slice(before).length} calls`);

  // Restock, then sell down again: that is a new crossing and a new alert.
  await query('update items set stock = 40 where id = $1', [item.id]);
  await checkLowStock();
  await query('update items set stock = 1 where id = $1', [item.id]);
  before = sent.length;
  await checkLowStock();
  check('restocking re-arms the alert',
    sent.slice(before).some((c) => c.method === 'sendMessage' && c.payload.chat_id === ADMIN.id),
    `${sent.slice(before).length} calls`);
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
server.close();
telegram.close();
const { close } = await import('../src/lib/db.js');
await close();
process.exit(fail ? 1 : 0);
