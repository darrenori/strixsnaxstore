import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, one } from '../lib/db.js';
import config from '../config.js';
import log from '../lib/logger.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(__dirname, '..', '..', 'db');

/**
 * One-shot database setup, triggered over HTTP.
 *
 * Normally you would run `npm run db:setup` from a laptop, but a managed
 * database is often only reachable from the deployed app — a CI sandbox or a
 * locked-down network cannot open a Postgres connection to it at all. Running
 * the same two files from inside the deployment sidesteps that entirely.
 *
 * Both files are idempotent (`create ... if not exists`, `create or replace`,
 * upserts keyed on natural keys), so calling this twice is a no-op rather than
 * a disaster. The seed deliberately does not overwrite stock counts, so it
 * cannot clobber a real stock-take.
 *
 * Guarded by a shared secret because it is a public URL that writes to the
 * database. Without MIGRATE_SECRET set, the route refuses outright rather than
 * defaulting to open.
 */
router.post('/admin/migrate', async (req, res) => {
  const secret = config.migrateSecret;
  if (!secret) {
    return res.status(503).json({ error: 'Migrations are disabled: MIGRATE_SECRET is not set.' });
  }

  const presented = req.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? req.query.key;
  if (presented !== secret) {
    log.warn('Migration attempted with a bad secret', { ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const seedOnly = req.query.seedOnly === '1';
  const files = seedOnly ? ['seed.sql'] : ['schema.sql', 'seed.sql'];
  const applied = [];

  // One connection for the whole run: these files create functions and types
  // that later statements depend on, so they must not be spread across the
  // pool's connections.
  const client = await pool.connect();
  try {
    for (const file of files) {
      const sql = await fs.readFile(path.join(dbDir, file), 'utf8');
      const started = Date.now();
      await client.query(sql);
      applied.push({ file, ms: Date.now() - started });
      log.info('Applied migration file', { file });
    }
  } catch (err) {
    log.error('Migration failed', { error: err.message });
    return res.status(500).json({
      error: 'Migration failed.',
      detail: err.message,
      applied,
    });
  } finally {
    client.release();
  }

  // Report what the database actually holds now, so the caller can see it
  // worked rather than trusting a 200.
  const summary = await one(`
    select
      (select count(*) from categories)::int as categories,
      (select count(*) from items)::int      as items,
      (select coalesce(sum(stock), 0) from items)::int as units,
      (select count(*) from app_users)::int  as users,
      (select count(*) from orders)::int     as orders
  `);

  return res.json({ ok: true, applied, summary });
});

/** Read-only sanity check, same guard. Useful before and after migrating. */
router.get('/admin/migrate/status', async (req, res) => {
  const secret = config.migrateSecret;
  const presented = req.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? req.query.key;
  if (!secret || presented !== secret) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const tables = await one(`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public'
        and table_name in ('categories','items','orders','order_items',
                           'app_users','stock_movements','settings','payment_proofs')
    `);
    const migrated = tables.n === 8;
    const summary = migrated
      ? await one(`select (select count(*) from items)::int as items,
                          (select count(*) from orders)::int as orders`)
      : null;
    return res.json({ migrated, tablesPresent: tables.n, expected: 8, summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
