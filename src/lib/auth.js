import crypto from 'node:crypto';
import { verifyInitData, displayNameOf, InitDataError } from './telegram-auth.js';
import { one } from './db.js';
import config from '../config.js';
import log from './logger.js';

/**
 * Turn a verified Telegram identity into our own user row, creating it on
 * first sight. Bootstrap admin ids from the environment are promoted here, so
 * the very first admin exists without anyone touching the database by hand.
 */
export async function upsertUser(tgUser) {
  const shouldBeAdmin = config.store.bootstrapAdminIds.includes(tgUser.id);

  // One statement, so two devices opening the app at once cannot race to
  // insert the same telegram_id. `is_admin` is only ever raised here, never
  // lowered - an admin granted in-app survives an env change.
  return one(
    `insert into app_users(telegram_id, username, first_name, last_name, photo_url,
                           display_name, is_admin)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (telegram_id) do update set
       username     = excluded.username,
       first_name   = excluded.first_name,
       last_name    = excluded.last_name,
       photo_url    = excluded.photo_url,
       is_admin     = app_users.is_admin or excluded.is_admin,
       last_seen_at = now()
     returning *`,
    [
      tgUser.id, tgUser.username, tgUser.firstName, tgUser.lastName,
      tgUser.photoUrl, displayNameOf(tgUser), shouldBeAdmin,
    ]
  );
}

/**
 * Express middleware: every /api request must carry a live Telegram signature.
 * There is no cookie, no bearer token and no session store - the proof travels
 * with each call, so there is nothing for an attacker to steal and reuse.
 */
export async function requireTelegramUser(req, res, next) {
  try {
    const initData =
      req.get('X-Telegram-Init-Data') ||
      req.body?.initData ||
      req.query?.initData;

    const verified = verifyInitData(initData);
    if (verified.signatureExcluded) {
      // Worth knowing: it means this client's initData only validates with
      // `signature` left out of the digest.
      log.warn('Init data validated without its signature field', {
        telegramId: verified.user.id,
      });
    }
    const user = await upsertUser(verified.user);

    if (user.is_blocked) {
      return res.status(403).json({ error: 'Your access to the store has been suspended.' });
    }

    req.telegram = verified;
    req.user = user;
    return next();
  } catch (err) {
    if (err instanceof InitDataError) {
      log.warn('Rejected init data', { code: err.code, ip: req.ip, fields: err.detail });
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    return next(err);
  }
}

/** Gate for the admin panel. Runs after requireTelegramUser. */
export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    log.warn('Non-admin hit an admin route', {
      telegramId: req.user?.telegram_id,
      path: req.path,
    });
    return res.status(403).json({ error: 'Admins only.' });
  }
  return next();
}

/** True when this Telegram id may act as an admin (used by the bot). */
export async function isAdminTelegramId(telegramId) {
  if (config.store.bootstrapAdminIds.includes(Number(telegramId))) return true;
  const row = await one('select is_admin from app_users where telegram_id = $1', [telegramId]);
  return Boolean(row?.is_admin);
}


/**
 * Compare a presented shared secret against the configured one in time that
 * does not depend on how much of it was right.
 *
 * `!==` on two strings stops at the first differing byte, so how long the
 * answer takes leaks how long a correct prefix was. Across the open internet
 * that signal sits well under the jitter, and these secrets are long and
 * random, so this closes a theoretical door rather than an open one. It costs
 * four lines.
 */
export function secretMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  // timingSafeEqual throws when the lengths differ, which would be its own
  // tell, so compare fixed-width digests rather than the raw bytes.
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export default {
  requireTelegramUser, requireAdmin, upsertUser, isAdminTelegramId, secretMatches,
};
