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
import { launchBot, getBot } from './bot/index.js';
import { expireStaleOrders } from './services/order.service.js';
import { ensureTabs, sheetsEnabled } from './lib/sheets.js';

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
      connectSrc: ["'self'", 'https://*.supabase.co'],
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

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// ---------------------------------------------------------------------------
// Health check — before auth so uptime pings do not need Telegram data.
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'strix-snax-store',
    sheets: sheetsEnabled(),
    bot: Boolean(getBot()),
    uptime: Math.round(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// Telegram webhook (only when TELEGRAM_USE_WEBHOOK=true)
// ---------------------------------------------------------------------------
if (config.telegram.useWebhook && config.telegram.webhookUrl) {
  const webhookPath = new URL(config.telegram.webhookUrl).pathname;
  app.post(webhookPath, (req, res) => {
    // Telegram echoes the secret we registered; anything else is not Telegram.
    if (config.telegram.webhookSecret &&
        req.get('X-Telegram-Bot-Api-Secret-Token') !== config.telegram.webhookSecret) {
      return res.sendStatus(401);
    }
    const bot = getBot();
    if (!bot) return res.sendStatus(503);
    bot.handleUpdate(req.body).catch((err) => log.error('Webhook update failed', { error: err.message }));
    return res.sendStatus(200);
  });
}

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

  // Put stock held by abandoned checkouts back on the shelf.
  const janitor = setInterval(() => {
    expireStaleOrders().catch((err) => log.error('Janitor failed', { error: err.message }));
  }, 5 * 60 * 1000);
  janitor.unref();

  const shutdown = (signal) => {
    log.info('Shutting down', { signal });
    getBot()?.stop(signal);
    server.close(() => process.exit(0));
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
