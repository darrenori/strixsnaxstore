# 🐼 STRIX Snax Store

A Telegram bot + Mini App that replaces the AY2026/2027 Google Form order flow
for the Blk B Lounge snack shelf and the Blk B Pantry drinks fridge.

Where the form asked for a name, then one item, then a quantity, then *"buying
any more items?"* — and looped — this is a shop: a real cart, live stock, a
PayNow QR with the amount already filled in, admin verification of the payment
screenshot, and every confirmed sale written into Google Sheets.

---

## What it does

**For buyers**
- Browse the full menu — Snax (Blk B Lounge) and Drinks (Blk B Pantry) — with
  live stock, so nothing can be ordered that is not on the shelf.
- One cart, any number of items. No "buying any more items? → Yes → repeat".
- A PayNow QR generated per order, with the exact amount and the order code
  already encoded, so the amount cannot be typed wrong.
- Upload the payment screenshot in the app; get a Telegram message the moment
  an admin verifies it.
- An order history with the payment-verification status of every purchase.

**For admins**
- A verification queue: see the screenshot next to the order, approve or reject
  with one tap. Both sides get notified.
- Stock taking: count the shelf, type the real numbers, save. Every movement
  lands in an audit ledger and in the spreadsheet.
- Add items, edit prices, hide sold-out lines, create whole new categories —
  all from the phone, no redeploy.
- Promote other people to admin.
- Open/close the store and set the header announcement.

**Collation**
- Every verified order is appended to Google Sheets: an `Orders` row, one
  `Order Items` row per line, plus live `Items & Stock` and `Stock Movements`
  tabs.
- The sheet edits back. Change a price, name, stock count or the Active flag
  in *Items & Stock*, press **SYNC FROM SHEET** in the admin tab, and it lands
  in the catalogue — stock through the ledger, like any stock-take. Rows are
  matched on SKU; an unknown SKU or an unreadable cell is reported rather than
  guessed at, and never inserted or deleted. **PUSH MENU TO SHEET** goes the
  other way and overwrites the sheet, so sync before you push.

---

## How the pieces fit

```
Telegram client
      │  initData (HMAC-signed by Telegram with the bot token)
      ▼
Express API  ──────────────►  Postgres
      │                        · catalogue, stock, orders, ledger
      │                        · SQL functions hold the money logic
      │                        · private bucket for payment screenshots
      │
      ├──────────────────►  Google Sheets  (collation for humans)
      │
      └──────────────────►  Telegram Bot API  (notifications)
```

### Why it is safe to take money through this

- **Identity.** Every API call carries Telegram's `initData`, and the server
  re-verifies the HMAC on each request (`src/lib/telegram-auth.js`). There is
  no cookie, no bearer token, no session store — so there is nothing to steal
  and replay. Signatures also expire, so a header lifted from a log is useless
  the next day.
- **Prices.** The client sends item ids and quantities. It never sends a price
  or a total. `create_order()` reads prices from the table under a row lock and
  computes the total in the database, so a tampered request just produces a
  correctly-priced order.
- **Stock.** The same row lock means two people cannot buy the same last packet.
  Placing an order *reserves* stock; only an admin approval spends it, and a
  rejection or a 45-minute timeout puts it back.
- **Keys.** The database URL stays on the server. The Mini App never receives a
  database credential of any kind — it talks only to our own `/api` routes.
- **Screenshots** live in the database and have no URL of their own. An admin
  fetches one through a route behind both the signature check and the admin
  gate, so there is nothing guessable to share or leak.
- **Uploads** are checked by magic bytes, not by the filename or the
  client-declared MIME type.

---

## Setup

### 1. A Postgres database

Any Postgres 14+ works — Supabase, Neon, Fly, or one on your laptop. On a
serverless host, use the provider's **pooled** connection string (Supabase's
port 6543, Neon's `-pooler` host): every function invocation opens its own
connection, and a direct URL will exhaust the server's connection limit.
The app talks plain SQL through `pg`, with no vendor SDK, so moving between
providers is only ever a change of `DATABASE_URL`.

```bash
npm install
npm run setup             # asks for the two values only you know, then builds the database
```

`npm run setup` writes `.env`, generating the secrets itself, and applies
`db/schema.sql` and `db/seed.sql`. It works the same on PowerShell, CMD, zsh
and bash, and takes piped answers for a scripted install. To redo just the
database later: `npm run db:setup`.

The seed is the menu straight off the two posters: Hello Panda, Roller
Coasters, Fish Crackers, the noodle wall, Lotte Pepero, the Under $1 deals,
the classic drinks and Red Bull. Re-running it updates names and prices but
**never** overwrites a stock count.

### 2. Telegram

1. `@BotFather` → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. `/mybots` → your bot → **Bot Settings → Menu Button** → set it to your
   `PUBLIC_URL`. (The server also sets this automatically at boot.)
3. Deploy somewhere with https — Telegram will not open a Mini App over plain
   http. For local work use `cloudflared tunnel --url http://localhost:3000`
   and put the https URL it prints into `PUBLIC_URL`.

### 3. Become an admin

Send `/id` to your bot, then put the number in `ADMIN_TELEGRAM_IDS` and
restart. From then on you can promote everyone else from the **People** tab —
no more env edits.

### 4. Google Sheets

1. Google Cloud console → new project → enable the **Google Sheets API** and
   the **Google Drive API**.
2. IAM → Service Accounts → create one → Keys → **Add key → JSON**. Keep the
   file that downloads.
3. Hand that file to the app. It reads the key and writes the three variables
   into `.env` itself, so there is no multi-line PEM block to paste:

```bash
npm run sheets:creds -- "C:\Users\you\Downloads\key.json"
```

4. Make a blank spreadsheet in your own Drive, press **Share**, and add the
   service-account address as an **Editor** — `sheets:creds` prints it, and it
   looks like `something@your-project.iam.gserviceaccount.com`.
5. Point the store at it. Paste the URL straight from the browser:

```bash
npm run sheets:link -- "https://docs.google.com/spreadsheets/d/.../edit"
```

That proves the service account can open the file before it writes anything,
puts `GOOGLE_SHEETS_ID` and `SHEETS_ENABLED` into `.env`, and creates the four
tabs. If the share did not take it says so and prints the address to share
with, rather than leaving you looking at an empty sheet wondering.

Then `npm run sheets:sync` fills *Items & Stock*, or press **SYNC MENU TO
SHEET** in the admin tab.

The service account can create the file itself instead —
`npm run sheets:bootstrap -- you@gmail.com` — but service accounts have no
Drive storage quota of their own, so on most projects that fails with
`storageQuotaExceeded`. Sharing a sheet you already own sidesteps that and
leaves the file somewhere you can find it.

Deployed, the same four variables — `SHEETS_ENABLED`, `GOOGLE_SHEETS_ID`,
`GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` — must be set on the
host too. `.env` never leaves your machine.

### 5. PayNow

```env
PAYNOW_PROXY_TYPE=mobile        # or 'uen'
PAYNOW_PROXY_VALUE=+6591234567  # or your UEN
PAYNOW_AMOUNT_EDITABLE=false
```

With these set, every order gets its own EMVCo/SGQR code carrying the exact
amount and the order code as the bill reference — the buyer just confirms.

Leave `PAYNOW_PROXY_VALUE` blank to keep the single printed QR from the poster
instead; see `public/assets/README.md`.

### 6. Run

```bash
npm start
```

---

## Deploying

The app runs two ways from the same source.

**As a long-running server** (Railway, Fly, a VPS, `npm start`): the bot uses
long polling and a timer sweeps expired holds. Nothing else to configure.

**As serverless functions** (Vercel): `vercel.json` and `api/index.js` are
here. There is no boot phase, so the bot switches to a webhook and the sweep
happens two other ways — a daily Vercel cron hits `/api/cron/janitor`, and
`create_order` releases expired holds itself before it counts stock, which
means the shelf is correct at the moment of purchase even if no cron ever runs.

Set these for the serverless path:

```env
TELEGRAM_USE_WEBHOOK=true
TELEGRAM_WEBHOOK_URL=https://<your-app>.vercel.app/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<a long random string>
CRON_SECRET=<another long random string>
```

**Avoid free tiers that sleep.** A sleeping instance stops long polling, and
the store advertises itself as open 24/7. Serverless does not have this
problem, which is why the Vercel path exists.

### Pointing Telegram at a serverless deployment

A long-running server registers itself with Telegram at boot. A serverless
deployment never boots — nothing runs until a request arrives, and the first
request can only arrive once Telegram already knows where to send it. Break
the loop by calling the setup endpoint once after deploying:

```powershell
Invoke-RestMethod -Method Post `
  "https://<your-app>.vercel.app/api/admin/telegram/setup?key=$env:MIGRATE_SECRET"
```

That registers the webhook (with its secret token), the command list and the
☰ menu button, then reports back what Telegram now thinks. It reads the
origin from the URL you called, so there is nothing to type twice. To check
later without changing anything:

```powershell
Invoke-RestMethod "https://<your-app>.vercel.app/api/admin/telegram/status?key=$env:MIGRATE_SECRET"
```

A `url` field of `""` in the reply means no webhook is registered and the bot
is deaf — run the setup call.

A `Dockerfile` is also here for anywhere that takes a container.

---

## Bot commands

| Command   | Who      | Does                                  |
|-----------|----------|---------------------------------------|
| `/start`  | anyone   | Opens the store                       |
| `/menu`   | anyone   | Today's menu and prices, with stock   |
| `/orders` | anyone   | Your recent orders                    |
| `/id`     | anyone   | Your Telegram id (for admin access)   |
| `/admin`  | admins   | Queue depth and low-stock summary     |

---

## Order lifecycle

```
awaiting_payment ──upload screenshot──► pending_review ──admin approves──► paid ──► collected
       │                                      │
       │                                admin rejects
       ├── buyer cancels ────► cancelled      ▼
       └── 45 min timeout ───► cancelled   rejected ──re-upload──► pending_review
```

Stock is reserved from the moment the order is placed and only truly deducted
on approval. `cancelled` and `rejected` both release the reservation, and a
janitor sweeps abandoned checkouts every five minutes.

---

## Layout

```
src/
  index.js               Express app, middleware, boot
  config.js              env parsing, fails loudly at boot
  lib/
    telegram-auth.js     initData HMAC verification
    auth.js              middleware: identity + admin gate
    supabase.js          service-role client, error translation
    paynow.js            EMVCo/SGQR payload + QR rendering
    sheets.js            Google Sheets collation
  services/              catalog, orders, admin — the business logic
  routes/                HTTP surface, zod-validated
  bot/                   Telegraf handlers and notifications
public/                  the Mini App (vanilla ES modules, no build step)
db/
  schema.sql             tables and the SQL functions holding the money logic
  seed.sql               the menu from the posters
  test-logic.sql         14 assertions, run inside a rolled-back transaction
scripts/                 db setup, sheet bootstrap, sync, syntax lint
tests/                   node:test — auth, PayNow, HTTP
```

There is no bundler on purpose. The Mini App is plain ES modules, so what runs
in Telegram is exactly what is in the repo.

The Google client is `@googleapis/sheets` and `@googleapis/drive` rather than
the umbrella `googleapis` package, which bundles every Google API and costs
209 MB for the two we actually use. Production `node_modules` is 47 MB.

## Tests

```bash
npm test          # 28 unit tests: signature forgery, PayNow payloads, HTTP auth
npm run test:local  # 148 integration checks against a throwaway Postgres
npm run check     # parse every file, then run all of the above
```

`test:local` needs no database, no Docker and no network. It starts PGlite —
Postgres compiled to WASM, so the same plpgsql and the same row locks — applies
`schema.sql` and `seed.sql`, and runs each suite against its own fresh copy:

| Suite | Checks | Covers |
|-------|--------|--------|
| `sql` | 23 | the money and stock rules asserted directly against the plpgsql functions |
| `e2e` | 28 | the happy path: catalogue, pricing, proof upload, approval, stock |
| `flows` | 57 | what happens when it goes wrong — rejection, cancellation, expiry, races, every guard |
| `bot` | 30 | the real Telegram handlers driven through the webhook, against a stub Bot API |
| `vercel` | 10 | the serverless request shape, including a screenshot upload on a pre-read body |

Run one at a time with `npm run test:local -- flows`. To run against a real
database instead, set `DATABASE_URL` and use `npm run test:e2e`.

The money and stock rules live in SQL, so they are tested in SQL. Against a
scratch database that has `schema.sql` and `seed.sql` applied:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test-logic.sql
```

14 assertions covering server-side totals, stock reservation, idempotent
approval, oversell rejection, hold release on reject/expire, the closed-store
gate, the open-order cap and the stock ledger. It runs inside a transaction
that is rolled back, so nothing it does survives.
