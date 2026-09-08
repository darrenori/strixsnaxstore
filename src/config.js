import 'dotenv/config';

/** Read an env var, or die loudly at boot rather than mysteriously at request time. */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
      `Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function optional(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function intOf(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/** "123, 456" -> [123n-ish numbers]. Used to bootstrap the first admin. */
function idList(name) {
  return optional(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV', 'development') === 'production',
  port: intOf('PORT', 3000),

  /** Public https origin the Mini App is served from — Telegram requires https. */
  publicUrl: optional('PUBLIC_URL', '').replace(/\/$/, ''),

  /** Shared secret for the scheduled-maintenance endpoint. */
  cronSecret: optional('CRON_SECRET'),

  /** Shared secret for the one-shot schema/seed endpoint. Unset = disabled. */
  migrateSecret: optional('MIGRATE_SECRET'),

  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    /**
     * Where the Bot API lives. Overridable so the bot can be pointed at a
     * self-hosted Bot API server — and so tests can drive the real handlers
     * against a stub instead of messaging actual people.
     */
    apiRoot: optional('TELEGRAM_API_ROOT', 'https://api.telegram.org'),
    // Long polling by default; set a webhook URL in production if you prefer.
    webhookUrl: optional('TELEGRAM_WEBHOOK_URL'),
    webhookSecret: optional('TELEGRAM_WEBHOOK_SECRET'),
    useWebhook: bool('TELEGRAM_USE_WEBHOOK', false),
    /** initData older than this is refused, so a copied header cannot be replayed forever. */
    initDataMaxAgeSeconds: intOf('TELEGRAM_INITDATA_MAX_AGE', 24 * 60 * 60),
  },

  db: {
    /** Postgres connection URI. Use the provider's pooled one on serverless. */
    url: required('DATABASE_URL'),
    ssl: bool('DATABASE_SSL', true),
    poolMax: intOf('DATABASE_POOL_MAX', 5),
  },

  sheets: {
    enabled: bool('SHEETS_ENABLED', true),
    spreadsheetId: optional('GOOGLE_SHEETS_ID'),
    serviceAccountEmail: optional('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    // Stored with literal \n in .env; turn them back into real newlines.
    privateKey: optional('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  },

  paynow: {
    /** 'uen' for a business UEN, 'mobile' for a +65 number. */
    proxyType: optional('PAYNOW_PROXY_TYPE', 'mobile'),
    proxyValue: optional('PAYNOW_PROXY_VALUE'),
    merchantName: optional('PAYNOW_MERCHANT_NAME', 'STRIX SNAX STORE').toUpperCase().slice(0, 25),
    /** Editable amount = false means the buyer cannot change the sum in their bank app. */
    amountEditable: bool('PAYNOW_AMOUNT_EDITABLE', false),
    /** Falls back to this image when no proxy is configured. */
    staticQrPath: optional('PAYNOW_STATIC_QR', '/assets/paynow-static.png'),
  },

  store: {
    name: optional('STORE_NAME', 'STRIX Snax Store'),
    academicYear: optional('STORE_AY', 'AY2026/2027'),
    /** Telegram user ids that are admins no matter what the DB says. */
    bootstrapAdminIds: idList('ADMIN_TELEGRAM_IDS'),
    maxUploadBytes: intOf('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  },
};

export default config;
