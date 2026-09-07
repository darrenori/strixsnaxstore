import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import log from './lib/logger.js';
import { requireTelegramUser, requireAdmin } from './lib/auth.js';
import catalogRoutes from './routes/catalog.js';
import orderRoutes from './routes/orders.js';
import adminRoutes from './routes/admin.js';
import migrateRoutes from './routes/migrate.js';
import { launchBot, getBot } from './bot/index.js';
import { expireStaleOrders, pruneOldProofs } from './services/order.service.js';
import { ensureTabs, sheetsEnabled } from './lib/sheets.js';
import { ping as pingDb, close as closeDb } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();

// Behind Render/Railway/Fly the client IP arrives in X-Forwarded-For; trusting
// exactly one hop keeps rate limiting keyed on the real caller.
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * CSP tuned for a Telegram Mini App: the page must be framable by Telegram,
 * loads its own scripts only, and needs data: URIs for the generated PayNow QR
 * plus blob: for the local preview of the screenshot the buyer picks.
 */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://telegram.org', 'https://*.telegram.org'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // Telegram's in-app browser loads the page inside its own frame.
  frameguard: false,
}));

/**
 * Some serverless runtimes (Vercel's included) read and parse the request body
 * before the handler runs, leaving an already-consumed stream. express.json()
 * would then wait forever on a body that has gone. Marking `_body` tells the
 * body parsers the work is already done, which is exactly the flag they check.
 */
app.use((req, _res, next) => {
  if (req.body !== undefined && req.body !== null) req._body = true;
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// ---------------------------------------------------------------------------
// Health check — before auth so uptime pings do not need Telegram data.
// ---------------------------------------------------------------------------
app.get('/healthz', async (req, res) => {
  // Touch the database so a health check actually means "can serve orders",
  // not merely "the process is alive".
  let db = false;
  try {
    await pingDb();
    db = true;
  } catch { /* reported below */ }

  res.status(db ? 200 : 503).json({
    ok: db,
    service: 'strix-snax-store',
    db,
    sheets: sheetsEnabled(),
    bot: Boolean(getBot()),
    uptime: Math.round(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// Telegram webhook (only when TELEGRAM_USE_WEBHOOK=true)
// ---------------------------------------------------------------------------
/**
 * Telegram webhook. Always mounted at a fixed path so a serverless deployment
 * has somewhere to receive updates without a boot step; long-polling hosts
 * simply never have it called.
 */
app.post('/telegram/webhook', async (req, res) => {
  // Telegram echoes the secret we registered with setWebhook; anything else
  // is not Telegram, and this endpoint is necessarily public.
  if (config.telegram.webhookSecret &&
      req.get('X-Telegram-Bot-Api-Secret-Token') !== config.telegram.webhookSecret) {
    log.warn('Webhook called with a bad secret', { ip: req.ip });
    return res.sendStatus(401);
  }

  // Answer Telegram first: it retries on anything slow, which would duplicate
  // work. The update is then handled on the same invocation.
  res.sendStatus(200);
  try {
    await getBot().handleUpdate(req.body);
  } catch (err) {
    log.error('Webhook update failed', { error: err.message });
  }
  return undefined;
});

/**
 * Scheduled maintenance, for hosts with no long-lived process to run a timer.
 * Guarded by a shared secret because it is a public URL that does real work.
 */
app.all('/api/cron/janitor', async (req, res) => {
  const secret = config.cronSecret;
  const presented = req.get('Authorization')?.replace(/^Bearer\s+/i, '')
    ?? req.query.key;
  if (!secret || presented !== secret) return res.sendStatus(401);

  try {
    const expired = await expireStaleOrders();
    const pruned = req.query.prune === '1' ? await pruneOldProofs() : 0;
    return res.json({ ok: true, expired, pruned });
  } catch (err) {
    log.error('Cron janitor failed', { error: err.message });
    return res.status(500).json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// API — everything past this point needs a valid Telegram signature.
// ---------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Slow down a moment and try again.' },
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Key on the Telegram user, not the IP — a hall full of students shares one NAT.
  keyGenerator: (req) => String(req.user?.telegram_id ?? req.ip),
  // Reading your own order status is cheap; only the mutations need throttling.
  skip: (req) => req.method === 'GET',
  message: { error: 'Too many attempts. Wait a minute and try again.' },
});

const api = express.Router();
api.use(apiLimiter);

// Bootstrap the database before anything can authenticate: there is no admin
// to check against until the tables exist. Its own shared secret is the gate.
api.use(migrateRoutes);

api.use(requireTelegramUser);
api.use(catalogRoutes);
api.use('/orders', writeLimiter);
api.use(orderRoutes);
// Bind the admin guard to the /admin prefix rather than to everything that
// falls through, so a typo'd buyer URL still reads as 404 and not 403.
api.use('/admin', requireAdmin);
api.use(adminRoutes);

app.use('/api', api);

// ---------------------------------------------------------------------------
// Mini App static files
// ---------------------------------------------------------------------------
app.use(express.static(publicDir, {
  maxAge: config.isProd ? '1h' : 0,
  setHeaders(res, filePath) {
    // The shell must never be cached, or a deploy leaves stale JS behind.
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Client-side routing fallback. Written as middleware rather than a '*' route
// because Express 5 rejects a bare wildcard path.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return next();
  return res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That screenshot is too large (max 10 MB).' });
  }
  const status = err.status ?? 500;
  if (status >= 500) {
    log.error('Unhandled error', { path: req.path, error: err.message, stack: err.stack });
  }
  return res.status(status).json({
    error: status >= 500 ? 'Something went wrong on our side.' : err.message,
    code: err.code ?? undefined,
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  // Fail loudly here rather than on a shopper's first order.
  await pingDb();

  const server = app.listen(config.port, () => {
    log.info('HTTP server listening', { port: config.port, publicUrl: config.publicUrl || '(unset)' });
  });

  try {
    await launchBot();
  } catch (err) {
    log.error('Bot failed to start', { error: err.message });
  }

  if (sheetsEnabled()) {
    ensureTabs().catch((err) => log.error('Sheets bootstrap failed', { error: err.message }));
  } else {
    log.warn('Google Sheets is not configured — orders will not be collated');
  }

  // Put stock held by abandoned checkouts back on the shelf, and keep the
  // screenshot table from growing without bound on a small disk.
  let sweeps = 0;
  const janitor = setInterval(() => {
    expireStaleOrders().catch((err) => log.error('Janitor failed', { error: err.message }));
    // Roughly daily, given a 5-minute tick.
    if (sweeps++ % 288 === 0) {
      pruneOldProofs().catch((err) => log.error('Proof prune failed', { error: err.message }));
    }
  }, 5 * 60 * 1000);
  janitor.unref();

  const shutdown = (signal) => {
    log.info('Shutting down', { signal });
    getBot()?.stop(signal);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Only boot when this file is the process entry point, so tests can import
// the Express app without starting a bot or binding a port.
const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch((err) => {
    log.error('Fatal boot error', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

export { main };
export default app;
