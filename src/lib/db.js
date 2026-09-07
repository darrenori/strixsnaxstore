import pg from 'pg';
import config from '../config.js';
import log from './logger.js';

/**
 * Postgres access layer.
 *
 * The business rules that matter — pricing, stock reservation, approval,
 * release — live in SQL functions (see db/schema.sql), so this module stays
 * deliberately thin: a pool, a query helper, and translation of the errors
 * those functions raise into something the API can show a shopper.
 */

// `money` and `int8` come back as strings by default because they can exceed
// JS number range. Our amounts are cents in `int`, and telegram ids fit
// comfortably in a double, so parse int8 to a number for ergonomics.
pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

export const pool = new pg.Pool({
  connectionString: config.db.url,
  // Render terminates TLS with its own CA. The connection is encrypted; we
  // just cannot chain-verify it without shipping their bundle.
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // An idle client dying is normal on free tiers; the pool replaces it.
  log.warn('Idle Postgres client error', { error: err.message });
});

/** Run a query and return the rows. */
export async function query(text, params = []) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    const ms = Date.now() - started;
    if (ms > 1000) log.warn('Slow query', { ms, sql: text.slice(0, 120) });
    return result.rows;
  } catch (err) {
    log.error('Query failed', { error: err.message, sql: text.slice(0, 160) });
    throw err;
  }
}

/** Exactly one row, or null. */
export async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}

/** Call a SQL function and return its single row. */
export async function rpc(fn, params = []) {
  const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await query(`select * from ${fn}(${placeholders})`, params);
  return rows[0] ?? null;
}

/**
 * Run several statements as one unit. Used where two writes must not be able
 * to half-apply — attaching a payment proof, for instance.
 */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Our SQL functions raise things like 'OUT_OF_STOCK:Coke:2'. Turn those into
 * a shape the API layer can render as a friendly message.
 */
export function parseDbError(error) {
  const raw = error?.message ?? '';
  const match = raw.match(/(EMPTY_CART|CART_TOO_LARGE|STORE_CLOSED|TOO_MANY_OPEN_ORDERS|BAD_QUANTITY|ITEM_NOT_FOUND|ITEM_INACTIVE|OUT_OF_STOCK|ORDER_NOT_FOUND|ORDER_NOT_REVIEWABLE|ORDER_ALREADY_PAID|BAD_RELEASE_STATUS|NEGATIVE_STOCK)(?::([^\n"]*))?/);
  if (!match) return null;

  const [, code, detail = ''] = match;
  const parts = detail.split(':');
  const messages = {
    EMPTY_CART:           'Your cart is empty.',
    CART_TOO_LARGE:       'That is too many different items for one order.',
    STORE_CLOSED:         'The store is closed right now. Check back soon!',
    TOO_MANY_OPEN_ORDERS: 'You already have 3 unpaid orders. Finish or cancel one first.',
    BAD_QUANTITY:         'One of the quantities is out of range.',
    ITEM_NOT_FOUND:       'One of those items no longer exists.',
    ITEM_INACTIVE:        `${parts[0] || 'That item'} is not available right now.`,
    OUT_OF_STOCK:         parts[1] === '0'
      ? `${parts[0] || 'An item'} just sold out.`
      : `Only ${parts[1]} left of ${parts[0] || 'that item'}.`,
    ORDER_NOT_FOUND:      'That order does not exist.',
    ORDER_NOT_REVIEWABLE: 'That order has already been dealt with.',
    ORDER_ALREADY_PAID:   'That order is already paid — it cannot be released.',
    BAD_RELEASE_STATUS:   'Invalid order transition.',
    NEGATIVE_STOCK:       'Stock cannot go below zero.',
  };
  return { code, message: messages[code] ?? 'Something went wrong with that order.' };
}

/** Verify connectivity at boot so a bad URL fails loudly, not on first order. */
export async function ping() {
  const row = await one('select now() as at, current_database() as db');
  log.info('Postgres connected', { database: row?.db });
  return row;
}

export async function close() {
  await pool.end().catch(() => {});
}

export default { pool, query, one, rpc, transaction, parseDbError, ping, close };
