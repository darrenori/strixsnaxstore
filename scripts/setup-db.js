#!/usr/bin/env node
/**
 * Apply the schema and seed the menu in one command.
 *
 *   npm run db:setup      -- schema + menu
 *   npm run seed          -- menu only
 *
 * Needs SUPABASE_DB_URL — Supabase dashboard → Project Settings → Database →
 * Connection string → URI. If it is not set, the script prints the two files
 * so you can paste them into the SQL editor instead.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const seedOnly = process.argv.includes('--seed-only');
const files = seedOnly
  ? ['supabase/seed.sql']
  : ['supabase/schema.sql', 'supabase/seed.sql'];

const connectionString = process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.error('\n⚠️  SUPABASE_DB_URL is not set.\n');
  console.error('Either set it in .env, or open the Supabase SQL editor and run these files in order:\n');
  for (const file of files) console.error(`   • ${file}`);
  console.error('\nSupabase → Project Settings → Database → Connection string → URI');
  console.error('(use the "Session pooler" URI and add ?sslmode=require)\n');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  // Supabase terminates TLS with its own CA; verifying it needs the bundle,
  // which most local setups do not have. The connection is still encrypted.
  ssl: { rejectUnauthorized: false },
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
