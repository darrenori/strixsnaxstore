import { Router } from 'express';
import { configureTelegram, getBot } from '../bot/index.js';
import config from '../config.js';
import log from '../lib/logger.js';

const router = Router();

/**
 * Point Telegram at this deployment, over HTTP.
 *
 * A long-running host does this at boot in launchBot(). A serverless
 * deployment has no boot: nothing runs until a request arrives, and the first
 * request can only arrive once Telegram already knows where to send it. That
 * is a chicken and egg, and this route is the way out of it — deploy, call
 * this once, and the bot is live.
 *
 * It shares MIGRATE_SECRET with the schema route: both are one-shot
 * deployment steps rather than part of the running app, both are public URLs
 * that change the world, and a second secret to lose helps nobody. Without
 * that variable set the route refuses outright rather than defaulting to open.
 */
function guard(req, res) {
  const secret = config.migrateSecret;
  if (!secret) {
    res.status(503).json({ error: 'Telegram setup is disabled: MIGRATE_SECRET is not set.' });
    return false;
  }
  const presented = req.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? req.query.key;
  if (presented !== secret) {
    log.warn('Telegram setup attempted with a bad secret', { ip: req.ip });
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  return true;
}

/**
 * Where this deployment can be reached. PUBLIC_URL wins when it is set;
 * otherwise fall back to the host the caller used, which is what makes
 * "deploy, then call your own URL once" work with no configuration at all.
 */
function originOf(req) {
  const explicit = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const base = explicit || config.publicUrl || `https://${req.get('host')}`;
  return base.replace(/\/$/, '');
}

router.post('/admin/telegram/setup', async (req, res) => {
  if (!guard(req, res)) return undefined;

  const origin = originOf(req);
  if (!origin.startsWith('https://')) {
    return res.status(400).json({
      error: `Telegram needs an https origin; got "${origin}". `
        + 'Pass ?url=https://your-deployment or set PUBLIC_URL.',
    });
  }

  const webhookUrl = `${origin}/telegram/webhook`;
  try {
    const done = await configureTelegram({ publicUrl: origin, webhookUrl });
    const [me, info] = await Promise.all([
      getBot().telegram.getMe(),
      getBot().telegram.getWebhookInfo(),
    ]);

    if (!config.telegram.webhookSecret) {
      log.warn('Webhook registered without a secret token — anyone can post updates');
    }

    return res.json({
      ok: true,
      configured: done,
      bot: { id: me.id, username: me.username, name: me.first_name },
      webhook: {
        url: info.url,
        pendingUpdates: info.pending_update_count,
        lastError: info.last_error_message ?? null,
        // Telegram only sends the secret header when one was registered.
        secured: Boolean(config.telegram.webhookSecret),
      },
      miniApp: origin,
    });
  } catch (err) {
    log.error('Telegram setup failed', { error: err.message });
    return res.status(502).json({ error: 'Telegram rejected the setup.', detail: err.message });
  }
});

/** Read-only: is the bot reachable, and where is Telegram delivering updates? */
router.get('/admin/telegram/status', async (req, res) => {
  if (!guard(req, res)) return undefined;

  try {
    const [me, info] = await Promise.all([
      getBot().telegram.getMe(),
      getBot().telegram.getWebhookInfo(),
    ]);
    return res.json({
      bot: { id: me.id, username: me.username, name: me.first_name },
      webhook: {
        url: info.url || null,
        pendingUpdates: info.pending_update_count,
        lastError: info.last_error_message ?? null,
        lastErrorAt: info.last_error_date
          ? new Date(info.last_error_date * 1000).toISOString()
          : null,
      },
      expected: `${originOf(req)}/telegram/webhook`,
      publicUrl: config.publicUrl || null,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Telegram.', detail: err.message });
  }
});

export default router;
