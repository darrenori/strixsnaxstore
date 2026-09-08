#!/usr/bin/env node
/**
 * Load a Google service-account key into .env.
 *
 *   npm run sheets:creds -- "C:\\Users\\you\\Downloads\\project-abc123.json"
 *
 * The key Google hands you is a JSON file whose private_key is a multi-line
 * PEM block. Pasting that into .env by hand means escaping every newline and
 * getting the quoting right, which is exactly the sort of thing that fails
 * silently and then looks like a credentials problem an hour later. So the
 * file is read here and the three variables are written for you.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

function die(...lines) {
  console.error(`\n${bad('✗')} ${lines.join('\n  ')}\n`);
  process.exit(1);
}

// --- find the key file ------------------------------------------------------
const given = process.argv[2];
if (!given) {
  die(
    'Give me the path to the service-account JSON you downloaded.',
    '',
    `  ${b('npm run sheets:creds -- "C:\\Users\\you\\Downloads\\key.json"')}`,
    '',
    'Google Cloud console → IAM → Service Accounts → your account →',
    'Keys → Add key → Create new key → JSON.'
  );
}

const keyPath = path.resolve(given.replace(/^["']|["']$/g, ''));
if (!fs.existsSync(keyPath)) die(`No file at ${keyPath}`);

let key;
try {
  key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
} catch (err) {
  die(`${keyPath} is not valid JSON.`, err.message);
}

if (key.type !== 'service_account') {
  die(
    `That file has type "${key.type ?? 'none'}", not "service_account".`,
    'An OAuth client-secret file will not work here — the server has no',
    'browser to consent in. Create a service account key instead.'
  );
}
if (!key.client_email || !key.private_key) {
  die('That JSON is missing client_email or private_key.');
}

// --- merge into .env --------------------------------------------------------
if (!fs.existsSync(envPath)) {
  die('No .env yet — run `npm run setup` first, then come back to this.');
}

const vars = {
  SHEETS_ENABLED: 'true',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: key.client_email,
  // Stored with literal \n; config.js turns them back into real newlines.
  GOOGLE_PRIVATE_KEY: `"${key.private_key.replace(/\r?\n/g, '\\n')}"`,
};

const original = fs.readFileSync(envPath, 'utf8');
const crlf = original.includes('\r\n');
let env = original;

for (const [name, value] of Object.entries(vars)) {
  const line = `${name}=${value}`;
  // Match the assignment anywhere in the file, commented out or not.
  const existing = new RegExp(`^#?\\s*${name}=.*$`, 'm');
  if (existing.test(env)) env = env.replace(existing, line);
  else env += `${env.endsWith('\n') ? '' : '\n'}${line}\n`;
}

// Leave a placeholder so the next step has somewhere obvious to write.
if (!/^#?\s*GOOGLE_SHEETS_ID=/m.test(env)) {
  env += `GOOGLE_SHEETS_ID=\n`;
}

if (crlf) env = env.replace(/\r?\n/g, '\r\n');
fs.writeFileSync(envPath, env, { mode: 0o600 });

const sheetId = (env.match(/^GOOGLE_SHEETS_ID=(.*)$/m)?.[1] ?? '').trim();

console.log(`\n${ok('✓')} Credentials written to .env`);
console.log(`  ${dim('service account:')} ${key.client_email}`);
console.log(`  ${dim('private key:')}     ${key.private_key.length} chars, newlines escaped\n`);

if (sheetId) {
  console.log(`Spreadsheet already set: ${dim(sheetId)}`);
  console.log(`Check it works:  ${b('npm run sheets:sync')}\n`);
} else {
  console.log(`${b('Next:')} create the spreadsheet and share it with yourself —\n`);
  console.log(`  ${b('npm run sheets:bootstrap -- you@gmail.com')}\n`);
  console.log(dim('  Use the Google account you want to open the sheet with.\n'));
}
