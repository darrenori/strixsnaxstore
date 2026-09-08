#!/usr/bin/env node
/**
 * Apply the schema and seed the menu in one command.
 *
 *   npm run db:setup      -- schema + menu
 *   npm run seed          -- menu only
 *
 * Needs DATABASE_URL in .env: the Postgres connection URI for your database.
 * On Supabase that is Connect → Session pooler (port 5432); the transaction
 * pooler on 6543 does not hold the session state that schema DDL relies on.
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

/**
 * Explain why a connection string is unusable, or null if it looks fine.
 *
 * Worth doing before we connect: pg resolves anything it cannot parse as a URI
 * against the base `postgres://base`, so an unedited placeholder arrives as
 * `getaddrinfo ENOTFOUND base` — a hostname that appears nowhere in .env and
 * reads like a network fault rather than a typo.
 */
function describeUrlProblem(raw) {
  const value = raw.trim().replace(/^['"]|['"]$/g, '');

  if (!value) return 'it is empty';
  if (value.includes('<<') || value.includes('>>') || /\bPASTE\b/i.test(value)) {
    return 'it is still the placeholder text, not a real connection URI';
  }
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    return 'it does not start with postgres:// or postgresql://';
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return 'it is not a parseable URI (an unescaped character in the password?)';
  }
  if (!url.hostname) return 'it has no host';
  if (/YOUR-PASSWORD|\[|\]/.test(decodeURIComponent(url.password))) {
    return 'the password is still the [YOUR-PASSWORD] placeholder';
  }
  return null;
}

function explainConnectionUri() {
  console.error('   Get it from Supabase → Connect → Session pooler (port 5432)');
  console.error('   and put it in .env on one line, no quotes and no spaces:\n');
  console.error('   DATABASE_URL=postgresql://postgres.abcd:PASSWORD@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres\n');
  console.error('   The password goes where PASSWORD is. If it contains any of');
  console.error('   @ : / ? # [ ] percent-encode it (@ becomes %40).\n');
  console.error('   Then re-run:  npm run db:setup\n');
}

if (!connectionString) {
  console.error('\n⚠️  DATABASE_URL is not set.\n');
  console.error('Set it in .env, then re-run. These are the files it applies:\n');
  for (const file of files) console.error(`   • ${file}`);
  console.error('');
  explainConnectionUri();
  process.exit(1);
}

const problem = describeUrlProblem(connectionString);
if (problem) {
  console.error(`\n⚠️  DATABASE_URL is not a usable Postgres URI — ${problem}.\n`);
  explainConnectionUri();
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  // Managed Postgres providers terminate TLS with their own CA, and verifying
  // it needs their bundle, which most local machines do not have. The
  // connection is still encrypted.
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

  if (err.code === 'ENOTFOUND' && err.hostname === 'base') {
    console.error('\n   `base` is not your database — it is pg\'s fallback host for a');
    console.error('   connection string it could not parse. DATABASE_URL is malformed.\n');
    explainConnectionUri();
  } else if (err.code === 'ENOTFOUND') {
    console.error(`\n   The host \`${err.hostname}\` does not resolve. Check it for a typo,`);
    console.error('   and check that the project has not been paused.\n');
  } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    console.error('\n   The host resolved but refused the connection. Check the port —');
    console.error('   the session pooler is 5432, not 6543.\n');
  } else if (/password authentication failed/i.test(err.message)) {
    console.error('\n   The host and port are right, the password is not. If it contains');
    console.error('   @ : / ? # [ ] it must be percent-encoded (@ becomes %40).\n');
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
