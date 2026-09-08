#!/usr/bin/env node
/**
 * Point the store at a spreadsheet you already own.
 *
 *   npm run sheets:link -- "https://docs.google.com/spreadsheets/d/<id>/edit"
 *
 * The other path — `sheets:bootstrap` — has the service account create the
 * file, which fails on most projects because a service account has no Drive
 * storage quota of its own. Making the sheet yourself and sharing it with the
 * service account as an Editor avoids that entirely, and leaves the file in
 * your Drive where you can find it.
 *
 * Paste the URL straight from the browser; the id is picked out of it. Access
 * is then proved before anything is written, so a missing share is reported
 * here rather than as silent nothing-in-the-sheet later on.
 */
import 'dotenv/config';
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
  console.error(`\n${bad('\u2717')} ${lines.join('\n  ')}\n`);
  process.exit(1);
}

// --- what are we linking to? ------------------------------------------------
const given = (process.argv[2] ?? '').replace(/^["']|["']$/g, '').trim();
if (!given) {
  die(
    'Give me the spreadsheet URL, or its id.',
    '',
    `  ${b('npm run sheets:link -- "https://docs.google.com/spreadsheets/d/.../edit"')}`
  );
}

// A full URL carries the id between /d/ and the next slash; otherwise assume
// the argument is already the id.
const spreadsheetId = given.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1] ?? given;
if (!/^[a-zA-Z0-9-_]{20,}$/.test(spreadsheetId)) {
  die(
    `"${given}" does not look like a spreadsheet URL or id.`,
    'Open the sheet and copy the address bar, or the long id inside it.'
  );
}

const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const key = (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
if (!email || !key) {
  die(
    'No service-account credentials in .env yet.',
    '',
    `  ${b('npm run sheets:creds -- "C:\\path\\to\\key.json"')}`
  );
}

// --- prove we can actually reach it -----------------------------------------
console.log(`\n${dim('sheet:')}          ${spreadsheetId}`);
console.log(`${dim('service account:')} ${email}\n`);

const { sheets: sheetsApi, auth: googleAuth } = await import('@googleapis/sheets');

const auth = new googleAuth.JWT({
  email,
  key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

let title;
try {
  await auth.authorize();
} catch (err) {
  die(
    'Google rejected the service-account key itself.',
    err.message,
    '',
    'Re-download the JSON key and run `npm run sheets:creds` again.'
  );
}

try {
  const api = sheetsApi({ version: 'v4', auth });
  const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'properties.title' });
  title = meta.data.properties?.title ?? '(untitled)';
} catch (err) {
  const status = err.status ?? err.code ?? err.response?.status;
  const message = String(err.message ?? '');

  // A disabled API answers 403 as well, so this has to be distinguished from a
  // sharing problem before the 403 is blamed on the share.
  if (/has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(message)) {
    die(
      'The Google Sheets API is not switched on for that Google Cloud project.',
      '',
      'Console → APIs & Services → Library → Google Sheets API → Enable.',
      'It can take a minute to take effect.',
      '',
      dim(message)
    );
  }
  if (status === 403) {
    die(
      'The service account cannot open that sheet.',
      '',
      'Open the sheet in your browser, press Share, paste this address and',
      'give it Editor (not Viewer):',
      '',
      `  ${b(email)}`,
      '',
      'Then run this command again.'
    );
  }
  if (status === 404) {
    die(
      'No spreadsheet with that id.',
      'Check the URL you copied — it must be a Sheets file, not a Drive folder.'
    );
  }
  die('Could not read that spreadsheet.', message);
}

console.log(`${ok('\u2713')} Opened "${title}" as an editor\n`);

// --- persist, then build the tabs -------------------------------------------
if (fs.existsSync(envPath)) {
  const before = fs.readFileSync(envPath, 'utf8');
  let after = before;
  for (const [name, value] of [['GOOGLE_SHEETS_ID', spreadsheetId], ['SHEETS_ENABLED', 'true']]) {
    const line = `${name}=${value}`;
    const existing = new RegExp(`^#?\\s*${name}=.*$`, 'm');
    after = existing.test(after)
      ? after.replace(existing, line)
      : `${after}${after.endsWith('\n') ? '' : '\n'}${line}\n`;
  }
  if (before.includes('\r\n')) after = after.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(envPath, after, { mode: 0o600 });
  console.log(`${ok('\u2713')} GOOGLE_SHEETS_ID and SHEETS_ENABLED written to .env\n`);
} else {
  console.log(`${bad('!')} No .env found — set GOOGLE_SHEETS_ID=${spreadsheetId} yourself.\n`);
}

// config.js reads the environment as it is imported, so this has to happen
// after the values above are in place.
process.env.GOOGLE_SHEETS_ID = spreadsheetId;
process.env.SHEETS_ENABLED = 'true';

const { ensureTabs, TABS } = await import('../src/lib/sheets.js');

try {
  await ensureTabs(true);
  console.log(`${ok('\u2713')} Tabs ready: ${Object.values(TABS).map((t) => t.title).join(', ')}\n`);
} catch (err) {
  die('Could not create the tabs.', err.message);
}

console.log(`   https://docs.google.com/spreadsheets/d/${spreadsheetId}\n`);
console.log(`${b('Next:')} ${b('npm run sheets:sync')} to fill Items & Stock from the catalogue.`);
console.log(dim('      On Vercel, set the same four variables and redeploy.\n'));
