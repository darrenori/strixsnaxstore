#!/usr/bin/env node
/**
 * Interactive first-run setup.
 *
 *   npm run setup
 *
 * Writes .env by asking for the two values only you can know, generating the
 * secrets itself, and then offering to build the database. Exists because a
 * heredoc is bash-only and this needs to work the same on PowerShell, CMD,
 * zsh and bash.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

/**
 * Prompting that works whether a human is typing or answers are piped in.
 *
 * readline emits every buffered line the moment piped input arrives, but
 * question() only captures the line that comes after it is called — so with a
 * pipe, everything past the first answer is dropped on the floor. When stdin
 * is not a TTY we therefore read it all up front and serve answers from a
 * queue, which also makes a scripted, non-interactive setup possible.
 */
const interactive = stdin.isTTY;
const rl = interactive ? readline.createInterface({ input: stdin, output: stdout }) : null;
let piped = [];

if (!interactive) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

async function prompt(question) {
  if (interactive) return rl.question(question);
  if (piped.length === 0) {
    // Nothing left to answer with. Without this the caller's retry loop would
    // spin forever on a required field, writing prompts until memory gives out.
    stdout.write(`\n${question}\n`);
    console.error('\nRan out of piped input. Run `npm run setup` interactively instead.\n');
    process.exit(1);
  }
  stdout.write(question);
  const answer = piped.shift() ?? '';
  stdout.write(`${answer}\n`);
  return answer;
}

function done() {
  rl?.close();
}

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

const secret = () => crypto.randomBytes(24).toString('base64url');

async function ask(question, { required = true, fallback = '' } = {}) {
  for (;;) {
    const answer = (await prompt(question)).trim();
    if (answer) return answer;
    if (!required) return fallback;
    console.log(bad('  That one is required.'));
  }
}

/** Sanity-check the Postgres URL and warn about the pooler port trap. */
function inspectDbUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, reason: 'That does not parse as a URL.' };
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    return { valid: false, reason: 'It should start with postgresql://' };
  }
  if (!url.password || url.password.includes('YOUR-PASSWORD') || url.password.startsWith('[')) {
    return { valid: false, reason: 'The password is still a placeholder — paste the real one.' };
  }
  return { valid: true, port: url.port || '5432', host: url.hostname };
}

console.log(`\n${b('STRIX Snax Store — setup')}\n`);

if (fs.existsSync(envPath)) {
  const answer = await ask(`${warn('.env already exists.')} Overwrite it? ${dim('(y/N)')} `, {
    required: false, fallback: 'n',
  });
  if (!/^y/i.test(answer)) {
    console.log('\nLeaving it alone. Run `npm run db:setup` if you just need the database.\n');
    done();
    process.exit(0);
  }
}

// --- 1. database -----------------------------------------------------------
console.log(b('1. Database'));
console.log(dim('   Supabase → Connect → Session pooler (port 5432).'));
console.log(dim('   Use 5432 here: schema changes through the 6543 transaction'));
console.log(dim('   pooler can misbehave. The deployed app uses 6543 instead.\n'));

let dbUrl;
for (;;) {
  dbUrl = await ask('   Connection URI: ');
  const check = inspectDbUrl(dbUrl);
  if (!check.valid) {
    console.log(bad(`   ${check.reason}\n`));
    continue;
  }
  if (check.port === '6543') {
    const go = await ask(
      warn('   That is the 6543 transaction pooler. Use it anyway? ') + dim('(y/N) '),
      { required: false, fallback: 'n' }
    );
    if (!/^y/i.test(go)) { console.log(); continue; }
  }
  console.log(ok(`   ✓ ${check.host}:${check.port}\n`));
  break;
}

// --- 2. telegram -----------------------------------------------------------
console.log(b('2. Telegram bot token'));
console.log(dim('   @BotFather → /mybots → API Token.\n'));
const botToken = await ask('   Bot token: ');
if (!/^\d+:[\w-]{30,}$/.test(botToken)) {
  console.log(warn('   That does not look like a bot token, but carrying on.\n'));
} else {
  console.log(ok('   ✓ looks right\n'));
}

// --- 3. paynow -------------------------------------------------------------
console.log(b('3. PayNow'));
console.log(dim('   The mobile number or UEN money should arrive at. This is what'));
console.log(dim('   locks the exact amount into every order QR. Blank = fall back to'));
console.log(dim('   the static poster QR, where buyers type the amount themselves.\n'));

const paynow = await ask('   PayNow number or UEN (blank to skip): ', { required: false });
const paynowType = paynow && /^[a-z]/i.test(paynow.replace(/^\+?\d+/, '')) && !paynow.startsWith('+')
  ? 'uen' : 'mobile';
if (paynow) console.log(ok(`   ✓ ${paynowType}\n`));
else console.log(warn('   ○ skipped — using the static QR\n'));

// --- 4. admin --------------------------------------------------------------
console.log(b('4. Admin'));
console.log(dim('   Your numeric Telegram id, so you can verify payments and take stock.'));
console.log(dim('   Send /id to your bot to get it. You can add it later instead.\n'));
const adminId = await ask('   Telegram id (blank to skip): ', { required: false });

// --- write -----------------------------------------------------------------
const env = `# Written by \`npm run setup\`. Never commit this file.

DATABASE_URL=${dbUrl}

TELEGRAM_BOT_TOKEN=${botToken}
TELEGRAM_WEBHOOK_SECRET=${secret()}
CRON_SECRET=${secret()}
MIGRATE_SECRET=${secret()}

ADMIN_TELEGRAM_IDS=${adminId}

PAYNOW_PROXY_TYPE=${paynowType}
PAYNOW_PROXY_VALUE=${paynow}
PAYNOW_MERCHANT_NAME=STRIX SNAX STORE
PAYNOW_AMOUNT_EDITABLE=false

SHEETS_ENABLED=false
STORE_NAME=STRIX Snax Store
STORE_AY=AY2026/2027
LOG_LEVEL=info

# Set this to your deployed https URL once you have one.
PUBLIC_URL=
`;

fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log(ok(`✓ wrote ${envPath}\n`));

// --- offer to migrate ------------------------------------------------------
const run = await ask(`Build the database now? ${dim('(Y/n)')} `, { required: false, fallback: 'y' });
done();

if (/^n/i.test(run)) {
  console.log('\nWhen ready: ' + b('npm run db:setup') + '\n');
  process.exit(0);
}

console.log('');
const child = spawn(process.execPath, [path.join(root, 'scripts', 'setup-db.js')], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, DATABASE_URL: dbUrl },
});
child.on('exit', (code) => {
  if (code === 0) {
    console.log(ok('\n✓ Database ready.') + ' Next: ' + b('npm run test:e2e') + ' then ' + b('npx vercel --prod') + '\n');
  }
  process.exit(code ?? 1);
});
