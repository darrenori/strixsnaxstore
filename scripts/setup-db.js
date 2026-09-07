#!/usr/bin/env node
/**
 * Apply the schema and seed the menu in one command.
 *
 *   npm run db:setup      -- schema + menu
 *   npm run seed          -- menu only
 *
 * Needs DATABASE_URL. Render sets this automatically for a linked database;
 * locally, copy the External Connection String from the Render dashboard.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const seedOnly = process.argv.includes('--seed-only');
const files = seedOnly ? ['db/seed.sql'] : ['db/schema.sql', 'db/seed.sql'];

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('\n⚠️  DATABASE_URL is not set.\n');
  console.error('Set it in .env, then re-run. These are the files it applies:\n');
  for (const file of files) console.error(`   • ${file}`);
  console.error('\nRender → your database → Connections → External Connection String\n');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  // Render terminates TLS with its own CA; verifying it needs their bundle,
  // which most local setups do not have. The connection is still encrypted.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log('✅ Connected to Postgres');

  for (const file of files) {
    const sql = fs.readFileSync(path.join(root, file), 'utf8');
    process.stdout.write(`→ Applying ${file} … `);
    await client.query(sql);
    console.log('done');
  }

  const { rows } = await client.query(`
    select c.name as category, count(i.id)::int as items, coalesce(sum(i.stock), 0)::int as stock
    from categories c left join items i on i.category_id = c.id
    group by c.name, c.sort_order order by c.sort_order
  `);

  console.log('\n📋 Menu now in the database:\n');
  for (const row of rows) {
    console.log(`   ${row.category.padEnd(18)} ${String(row.items).padStart(2)} items · ${row.stock} units`);
  }

  const { rows: totals } = await client.query('select count(*)::int as n from items');
  console.log(`\n✨ ${totals[0].n} items ready. Start the bot with: npm start\n`);
} catch (err) {
  console.error('\n❌ Setup failed:', err.message);
  if (err.position) console.error(`   near character ${err.position}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
