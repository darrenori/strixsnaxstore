#!/usr/bin/env node
/**
 * Run the integration suites against a throwaway Postgres.
 *
 *   npm run test:local            -- every suite
 *   npm run test:local -- flows   -- just one
 *
 * The integration tests need a real database: the business rules live in
 * plpgsql, row locks decide who gets the last packet, and none of that can be
 * faked with a stub. Pointing them at the live Supabase would mean testing
 * against the shop people are actually ordering from, so this spins up its own.
 *
 * PGlite is Postgres compiled to WASM — the same engine, the same plpgsql, the
 * same locking — running in this process with no server to install and no
 * Docker daemon to keep alive. Schema and seed are applied fresh each run, so
 * every suite starts from the same known shelf.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const SUITES = {
  // Plain SQL, run in-process: db/test-logic.sql asserts the money and stock
  // rules directly against the functions rather than through HTTP.
  sql: null,
  e2e: 'tests/e2e.integration.mjs',
  flows: 'tests/flows.integration.mjs',
  bot: 'tests/bot.integration.mjs',
  vercel: 'tests/vercel.integration.mjs',
};

const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const unknown = asked.filter((name) => !SUITES[name]);
if (unknown.length) {
  console.error(`Unknown suite: ${unknown.join(', ')}`);
  console.error(`Available: ${Object.keys(SUITES).join(', ')}`);
  process.exit(2);
}
const chosen = asked.length ? asked : Object.keys(SUITES);

/** Ask the OS for a port nothing else is on, so parallel runs cannot collide. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A fresh database per suite. PGlite serves one connection at a time, so a
 * suite gets the socket to itself and hands it back before the next starts —
 * which also means no suite can see another's leftovers.
 */
async function runSuite(name) {
  const db = await PGlite.create({ extensions: { pgcrypto } });
  for (const file of ['db/schema.sql', 'db/seed.sql']) {
    // eslint-disable-next-line no-await-in-loop
    await db.exec(fs.readFileSync(path.join(root, file), 'utf8'));
  }

  console.log(`\n${'='.repeat(72)}\n  ${name} — ${SUITES[name] ?? 'db/test-logic.sql'}\n${'='.repeat(72)}`);

  // The SQL suite needs no server: it runs its assertions inside a transaction
  // and rolls back. Any failed assertion raises, which is what we catch.
  if (name === 'sql') {
    const sql = fs.readFileSync(path.join(root, 'db/test-logic.sql'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('\\'))   // one psql meta-command
      .join('\n');
    try {
      await db.exec(sql);
      console.log('  OK   every business-logic assertion in db/test-logic.sql passed');
      await db.close();
      return 0;
    } catch (err) {
      console.log(`  FAIL ${err.message}`);
      await db.close();
      return 1;
    }
  }

  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SUITES[name]], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
        DATABASE_SSL: 'false',
        // PGlite takes one client at a time; the pool must not open a second.
        DATABASE_POOL_MAX: '1',
      },
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });

  await server.stop();
  await db.close();
  return code;
}

const failed = [];
for (const name of chosen) {
  // eslint-disable-next-line no-await-in-loop
  const code = await runSuite(name);
  if (code !== 0) failed.push(name);
}

console.log(`\n${'='.repeat(72)}`);
if (failed.length) {
  console.log(`  FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`  All ${chosen.length} integration suite(s) passed against a throwaway Postgres.`);
process.exit(0);
