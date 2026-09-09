import crypto from 'node:crypto';
import config from '../config.js';

/**
 * Telegram Mini App authentication.
 *
 * The Mini App hands us `window.Telegram.WebApp.initData` - a urlencoded query
 * string that Telegram itself signed with our bot token. Because only Telegram
 * and we know that token, a valid signature proves the caller really is the
 * Telegram user named inside it. That is the whole basis of trust here: the
 * client never tells us who it is, it proves it on every single request.
 *
 * Algorithm (per core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   secret_key = HMAC_SHA256(key: "WebAppData", data: bot_token)
 *   hash       = HMAC_SHA256(key: secret_key,  data: data_check_string)
 * where data_check_string is every field except `hash`, sorted by key,
 * joined as "k=v" with newlines.
 */

// Derived once - it is a pure function of the bot token.
const SECRET_KEY = crypto
  .createHmac('sha256', 'WebAppData')
  .update(config.telegram.botToken)
  .digest();

export class InitDataError extends Error {
  constructor(message, code = 'INVALID_INIT_DATA') {
    super(message);
    this.name = 'InitDataError';
    this.code = code;
    this.status = 401;
  }
}

/**
 * Verify an initData string and return the parsed, trusted payload.
 * Throws InitDataError on anything suspicious.
 */
export function verifyInitData(initData, { maxAgeSeconds = config.telegram.initDataMaxAgeSeconds } = {}) {
  if (typeof initData !== 'string' || initData.length === 0) {
    throw new InitDataError('Missing Telegram init data', 'MISSING_INIT_DATA');
  }
  if (initData.length > 8192) {
    throw new InitDataError('Init data too large', 'INIT_DATA_TOO_LARGE');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('Init data has no hash');

  /** Everything except `hash`, sorted, as k=v lines. */
  function digestOf({ excludeSignature }) {
    const pairs = [];
    for (const [key, value] of params.entries()) {
      if (key === 'hash') continue;
      if (excludeSignature && key === 'signature') continue;
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    return crypto.createHmac('sha256', SECRET_KEY).update(pairs.join('\n')).digest('hex');
  }

  const received = Buffer.from(hash, 'hex');

  /** Constant-time compare, so we do not leak the hash a byte at a time. */
  const matches = (hex) => {
    const expected = Buffer.from(hex, 'hex');
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  };

  // Newer clients also send `signature`, an Ed25519 signature meant for
  // validating without the bot token. The spec excludes only `hash` from the
  // data-check-string, so that is tried first - but clients have shipped both
  // readings, and being wrong here locks every shopper out of the store.
  // Accepting either is safe: whichever fields went into the digest, forging it
  // still needs the bot token, and `signature` carries its own proof anyway.
  let signatureExcluded = false;
  if (!matches(digestOf({ excludeSignature: false }))) {
    if (params.has('signature') && matches(digestOf({ excludeSignature: true }))) {
      signatureExcluded = true;
    } else {
      // The field names alone say whether this was a stale session or a shape
      // we do not handle. No values, so nothing sensitive reaches a log.
      const err = new InitDataError('Init data signature does not match');
      err.detail = [...params.keys()].sort().join(',');
      throw err;
    }
  }

  // A correct signature is forever valid, so freshness has to be checked too -
  // otherwise a header lifted from a proxy log would work months later.
  const authDate = Number.parseInt(params.get('auth_date') ?? '', 10);
  if (!Number.isFinite(authDate)) {
    throw new InitDataError('Init data has no auth_date');
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds) {
    throw new InitDataError('Telegram session expired - reopen the store', 'INIT_DATA_EXPIRED');
  }
  // Small clock skew is normal; a wildly future date is not.
  if (ageSeconds < -300) {
    throw new InitDataError('Init data auth_date is in the future');
  }

  let user = null;
  const rawUser = params.get('user');
  if (rawUser) {
    try {
      user = JSON.parse(rawUser);
    } catch {
      throw new InitDataError('Init data user payload is not valid JSON');
    }
  }
  if (!user || typeof user.id !== 'number') {
    throw new InitDataError('Init data has no usable user');
  }

  return {
    user: {
      id: user.id,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
      lastName: user.last_name ?? null,
      photoUrl: user.photo_url ?? null,
      languageCode: user.language_code ?? null,
      isPremium: Boolean(user.is_premium),
    },
    queryId: params.get('query_id') ?? null,
    startParam: params.get('start_param') ?? null,
    chatType: params.get('chat_type') ?? null,
    authDate,
    ageSeconds,
    /** True when the digest only matched with `signature` left out. */
    signatureExcluded,
  };
}

/** Best-effort display name for a Telegram user. */
export function displayNameOf(user) {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (user.username) return `@${user.username}`;
  return `User ${user.id}`;
}
