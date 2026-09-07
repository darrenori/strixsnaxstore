import { google } from 'googleapis';
import config from '../config.js';
import log from './logger.js';

/**
 * Google Sheets collation.
 *
 * Supabase is the system of record; the spreadsheet is the human-readable
 * ledger the committee actually opens. Every write here is best-effort: if
 * Google is down or the credentials lapse, orders must still go through, so
 * failures are logged and swallowed rather than thrown at the buyer.
 */

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/** Tab layouts. Order matters — it is the column order in the sheet. */
export const TABS = {
  orders: {
    title: 'Orders',
    headers: [
      'Order Code', 'Placed At (SGT)', 'Status', 'Buyer Name', 'Telegram ID', 'Username',
      'Items', 'Units', 'Total (SGD)', 'Collection Point(s)', 'Payment Ref', 'Note',
      'Verified By', 'Verified At (SGT)', 'Review Note',
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

  const auth = new google.auth.JWT({
    email: config.sheets.serviceAccountEmail,
    key: config.sheets.privateKey,
    scopes: SCOPES,
  });
  await auth.authorize();
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
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
 * Create any missing tab and write its header row. Runs once per process, and
 * is safe to run against a spreadsheet that already has the tabs.
 */
export async function ensureTabs(force = false) {
  const api = await client();
  if (!api) return false;
  if (ensuredTabs && !force) return true;

  const spreadsheetId = config.sheets.spreadsheetId;
  const meta = await api.spreadsheets.get({ spreadsheetId });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties.title));

  const missing = Object.values(TABS).filter((t) => !existing.has(t.title));
  if (missing.length) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missing.map((t) => ({
          addSheet: {
            properties: {
              title: t.title,
              gridProperties: { rowCount: 2000, columnCount: Math.max(t.headers.length, 12), frozenRowCount: 1 },
            },
          },
        })),
      },
    });
  }

  // Write headers for every tab we own (cheap, and self-heals a mangled header).
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: Object.values(TABS).map((t) => ({
        range: `${t.title}!A1`,
        values: [t.headers],
      })),
    },
  });

  ensuredTabs = true;
  log.info('Google Sheets tabs ready', { created: missing.map((m) => m.title) });
  return true;
}

async function append(tab, rows) {
  const api = await client();
  if (!api || rows.length === 0) return false;
  await ensureTabs();
  await api.spreadsheets.values.append({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${tab.title}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return true;
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

/** Row number (1-based) of an order code in a tab, or 0 when absent. */
async function findRowByCode(tab, code, column = 'A') {
  const api = await client();
  if (!api) return 0;
  const res = await api.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${tab.title}!${column}:${column}`,
  });
  const values = res.data.values ?? [];
  for (let i = 0; i < values.length; i += 1) {
    if ((values[i]?.[0] ?? '') === code) return i + 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Public writes
// ---------------------------------------------------------------------------

/**
 * Append (or refresh) a full order — the header row plus one row per line item.
 * Called when an admin approves the payment, so the sheet only ever contains
 * money that actually arrived.
 */
export async function recordOrder({ order, items, user }) {
  if (!credentialsPresent()) return false;
  try {
    const placedAt = sgt(order.created_at);
    const summary = items
      .map((i) => `${i.quantity}x ${[i.name, i.variant].filter(Boolean).join(' — ')}`)
      .join('; ');
    const units = items.reduce((sum, i) => sum + i.quantity, 0);

    const orderRow = [
      order.code,
      placedAt,
      order.status,
      order.buyer_name,
      String(order.telegram_id),
      user?.username ? `@${user.username}` : '',
      summary,
      units,
      money(order.total_cents),
      (order.collection_points ?? []).join(' + '),
      order.payment_ref ?? '',
      order.note ?? '',
      order.reviewer_name ?? '',
      order.reviewed_at ? sgt(order.reviewed_at) : '',
      order.review_note ?? '',
    ];

    const existingRow = await findRowByCode(TABS.orders, order.code);
    const api = await client();
    if (existingRow > 1) {
      // Already collated — refresh it in place instead of duplicating.
      await api.spreadsheets.values.update({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${TABS.orders.title}!A${existingRow}:${columnLetter(orderRow.length - 1)}${existingRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [orderRow] },
      });
    } else {
      await append(TABS.orders, [orderRow]);
      await append(
        TABS.orderItems,
        items.map((i) => [
          order.code, placedAt, order.buyer_name, i.category_name ?? '', i.sku, i.name,
          i.variant ?? '', money(i.unit_price_cents), i.quantity, money(i.line_total_cents),
          order.status,
        ])
      );
    }
    return true;
  } catch (err) {
    log.error('Sheets recordOrder failed', { code: order?.code, error: err.message });
    return false;
  }
}

/** Update just the status cells of an already-collated order. */
export async function updateOrderStatus(order) {
  if (!credentialsPresent()) return false;
  try {
    const row = await findRowByCode(TABS.orders, order.code);
    if (row < 2) return false;
    const api = await client();
    await api.spreadsheets.values.update({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${TABS.orders.title}!C${row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[order.status]] },
    });
    return true;
  } catch (err) {
    log.error('Sheets updateOrderStatus failed', { code: order?.code, error: err.message });
    return false;
  }
}

/** Mirror the whole catalog into the "Items & Stock" tab. */
export async function syncCatalog(rows) {
  if (!credentialsPresent()) return false;
  try {
    const api = await client();
    await ensureTabs();

    const values = rows.map((i) => {
      const available = Math.max((i.stock ?? 0) - (i.reserved ?? 0), 0);
      return [
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
      ];
    });

    // Clear the data range first so deleted items do not linger as ghosts.
    await api.spreadsheets.values.clear({
      spreadsheetId: config.sheets.spreadsheetId,
      range: `${TABS.catalog.title}!A2:Z5000`,
    });
    if (values.length) {
      await api.spreadsheets.values.update({
        spreadsheetId: config.sheets.spreadsheetId,
        range: `${TABS.catalog.title}!A2`,
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
}

/** Append one stock-take / restock movement to the ledger tab. */
export async function recordStockMovement(movement) {
  if (!credentialsPresent()) return false;
  try {
    await append(TABS.stock, [[
      sgt(movement.created_at ?? new Date()),
      movement.sku ?? '',
      movement.item_name ?? '',
      movement.delta ?? 0,
      movement.balance_after ?? 0,
      movement.reason ?? '',
      movement.order_code ?? '',
      movement.actor_name ?? '',
      movement.note ?? '',
    ]]);
    return true;
  } catch (err) {
    log.error('Sheets recordStockMovement failed', { error: err.message });
    return false;
  }
}

export default {
  sheetsEnabled, ensureTabs, recordOrder, updateOrderStatus,
  syncCatalog, recordStockMovement, sgt, TABS,
};
