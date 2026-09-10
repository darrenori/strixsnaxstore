#!/usr/bin/env node
/**
 * Push the server-side secrets from .env up to Vercel.
 *
 *   npm run vercel:env -- --check     # say what is set locally and stop
 *   npm run vercel:env                # push the Google Sheets variables
 *   npm run vercel:env -- --all       # push every server variable
 *
 * The Google private key is a multi-line PEM, which is exactly the thing that
 * cannot be typed at a prompt or pasted into a shell without something
 * mangling a newline. Every value here is handed to the Vercel CLI on stdin
 * instead, so nothing is quoted, escaped or retyped.
 *
 * `npx vercel login` once first; this reuses that session and the project link
 * already in .vercel/project.json. Vercel reads environment variables at
 * deploy time, so a redeploy is needed afterwards and this offers to run it.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** The variables the deployed app cannot work without, by group. */
const GROUPS = {
  sheets: [
    'SHEETS_ENABLED',
    'GOOGLE_SHEETS_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  ],
  rest: [
    'DATABASE_URL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_USE_WEBHOOK',
    'TELEGRAM_WEBHOOK_URL',
    'TELEGRAM_WEBHOOK_SECRET',
    'PUBLIC_URL',
    'MIGRATE_SECRET',
    'CRON_SECRET',
    'PAYNOW_PROXY_TYPE',
    'PAYNOW_PROXY_VALUE',
    'ADMIN_TELEGRAM_IDS',
    'LOW_STOCK_ALERT_AT',
  ],
};

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const checkOnly = args.includes('--check');
const names = wantAll ? [...GROUPS.sheets, ...GROUPS.rest] : GROUPS.sheets;

/** Never print a secret. Say only that it is there, and how big it is. */
function describe(name, value) {
  if (value === undefined) return 'not in .env';
  if (value === '') return 'empty in .env';
  const plain = ['SHEETS_ENABLED', 'TELEGRAM_USE_WEBHOOK', 'PUBLIC_URL',
    'TELEGRAM_WEBHOOK_URL', 'PAYNOW_PROXY_TYPE', 'ADMIN_TELEGRAM_IDS',
    'LOW_STOCK_ALERT_AT', 'GOOGLE_SERVICE_ACCOUNT_EMAIL'];
  return plain.includes(name) ? value : `set (${value.length} chars)`;
}

/** Run the Vercel CLI, optionally writing `input` to its stdin. */
function vercel(cliArgs, input = null) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--yes', 'vercel@latest', ...cliArgs], {
      shell: process.platform === 'win32',
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    if (input !== null) { child.stdin.end(input); }
    child.on('error', (e) => resolve({ code: 1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
});

// ---------------------------------------------------------------------------

console.log('\nVariables in your local .env:\n');
const present = [];
for (const name of names) {
  const value = process.env[name];
  console.log(`  ${name.padEnd(30)} ${describe(name, value)}`);
  if (value) present.push([name, value]);
}

if (present.length === 0) {
  console.error('\nNothing to push. Run `npm run sheets:creds -- <key.json>` first.');
  process.exit(1);
}

if (checkOnly) {
  console.log(`\n${present.length} variable(s) ready to push. Re-run without --check.`);
  process.exit(0);
}

const who = await vercel(['whoami']);
if (who.code !== 0) {
  console.error('\nThe Vercel CLI is not signed in on this machine.');
  console.error('Run `npx vercel login`, then this script again.');
  console.error('Alternatively add them by hand at');
  console.error('  https://vercel.com/darrenoris-projects/strixsnaxstore/settings/environment-variables');
  process.exit(1);
}
console.log(`\nSigned in to Vercel as ${who.out.trim()}.`);

let pushed = 0;
for (const [name, value] of present) {
  // Remove first: `env add` refuses a name that already has a value for the
  // same environment, and we want this script to be re-runnable.
  await vercel(['env', 'rm', name, 'production', '--yes']);
  const res = await vercel(['env', 'add', name, 'production'], value);
  if (res.code === 0) {
    console.log(`  pushed  ${name}`);
    pushed += 1;
  } else {
    console.error(`  FAILED  ${name}: ${(res.err || res.out).trim().split('\n').pop()}`);
  }
}

console.log(`\n${pushed}/${present.length} variable(s) now set on production.`);
if (pushed === 0) process.exit(1);

console.log('Vercel reads these at deploy time, so the running deployment still has the old set.');
const answer = await ask('Redeploy production now? [y/N] ');
if (answer === 'y' || answer === 'yes') {
  console.log('\nDeploying...');
  const dep = await vercel(['--prod', '--yes']);
  console.log(dep.code === 0 ? dep.out.trim() : `Deploy failed: ${dep.err.trim()}`);
  if (dep.code === 0) {
    console.log('\nCheck it landed:  curl https://strixsnaxstore.vercel.app/healthz');
    console.log('"sheets" should now read true.');
  }
} else {
  console.log('\nSkipped. Redeploy from the Vercel dashboard, or run `npx vercel --prod`.');
}
