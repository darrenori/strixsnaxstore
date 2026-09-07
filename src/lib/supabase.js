import { createClient } from '@supabase/supabase-js';
import config from '../config.js';

/**
 * Server-side Supabase client.
 *
 * This uses the service-role key, which bypasses RLS entirely — so it must
 * never leave the server. The Mini App never receives a Supabase key of any
 * kind; it talks only to our own /api routes, which authenticate every call
 * against Telegram's signature first.
 */
export const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'x-application-name': 'strix-snax-store' } },
});

/** Unwrap a PostgREST result, turning its error into a real throw. */
export function unwrap({ data, error }, context = 'query') {
  if (error) {
    const err = new Error(`Supabase ${context} failed: ${error.message}`);
    err.cause = error;
    err.pgCode = error.code;
    throw err;
  }
  return data;
}

/**
 * Our SQL functions raise things like 'OUT_OF_STOCK:Coke:2'. Turn those into
 * a shape the API layer can render as a friendly message.
 */
export function parseRpcError(error) {
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

export default supabase;
