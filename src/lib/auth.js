import { verifyInitData, displayNameOf, InitDataError } from './telegram-auth.js';
import { supabase, unwrap } from './supabase.js';
import config from '../config.js';
import log from './logger.js';

/**
 * Turn a verified Telegram identity into our own user row, creating it on
 * first sight. Bootstrap admin ids from the environment are promoted here, so
 * the very first admin exists without anyone touching the database by hand.
 */
export async function upsertUser(tgUser) {
  const shouldBeAdmin = config.store.bootstrapAdminIds.includes(tgUser.id);

  const existing = unwrap(
    await supabase.from('app_users').select('*').eq('telegram_id', tgUser.id).maybeSingle(),
    'load user'
  );

  if (existing) {
    const patch = {
      username: tgUser.username,
      first_name: tgUser.firstName,
      last_name: tgUser.lastName,
      photo_url: tgUser.photoUrl,
      last_seen_at: new Date().toISOString(),
    };
    // Env bootstrap can promote, but never demotes an admin granted in-app.
    if (shouldBeAdmin && !existing.is_admin) patch.is_admin = true;

    return unwrap(
      await supabase.from('app_users').update(patch).eq('id', existing.id).select('*').single(),
      'update user'
    );
  }

  return unwrap(
    await supabase.from('app_users').insert({
      telegram_id: tgUser.id,
      username: tgUser.username,
      first_name: tgUser.firstName,
      last_name: tgUser.lastName,
      photo_url: tgUser.photoUrl,
      display_name: displayNameOf(tgUser),
      is_admin: shouldBeAdmin,
    }).select('*').single(),
    'create user'
  );
}

/**
 * Express middleware: every /api request must carry a live Telegram signature.
 * There is no cookie, no bearer token and no session store — the proof travels
 * with each call, so there is nothing for an attacker to steal and reuse.
 */
export async function requireTelegramUser(req, res, next) {
  try {
    const initData =
      req.get('X-Telegram-Init-Data') ||
      req.body?.initData ||
      req.query?.initData;

    const verified = verifyInitData(initData);
    const user = await upsertUser(verified.user);

    if (user.is_blocked) {
      return res.status(403).json({ error: 'Your access to the store has been suspended.' });
    }

    req.telegram = verified;
    req.user = user;
    return next();
  } catch (err) {
    if (err instanceof InitDataError) {
      log.warn('Rejected init data', { code: err.code, ip: req.ip });
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
  const row = unwrap(
    await supabase.from('app_users').select('is_admin').eq('telegram_id', telegramId).maybeSingle(),
    'admin check'
  );
  return Boolean(row?.is_admin);
}

export default { requireTelegramUser, requireAdmin, upsertUser, isAdminTelegramId };
