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
- An order history with collection status.

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

Any Postgres 14+ works — Neon, Supabase, Render, Fly, or one on your laptop.
The app talks plain SQL through `pg`, with no vendor SDK, so moving between
providers is only ever a change of `DATABASE_URL`.

```bash
cp .env.example .env      # fill in DATABASE_URL
npm install
npm run db:setup          # applies db/schema.sql then db/seed.sql
```

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
2. IAM → Service Accounts → create one → Keys → **Add key → JSON**.
3. Copy `client_email` into `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `private_key`
   into `GOOGLE_PRIVATE_KEY` (keep the quotes and the `\n` escapes).
4. Create the spreadsheet:

```bash
npm run sheets:bootstrap -- you@gmail.com
```

That prints a `GOOGLE_SHEETS_ID`. Put it in `.env` and restart.

Service accounts have no Drive storage quota of their own. If the bootstrap
fails with `storageQuotaExceeded`, make a blank sheet in your own Drive, share
it with the service-account email as **Editor**, and use that id instead.

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

`render.yaml` and a `Dockerfile` are both here.

On Render: **New → Blueprint**, point it at this repo, then fill in the
`sync: false` variables. Set `PUBLIC_URL` to the https URL Render assigns.

Avoid free tiers that sleep — the bot uses long polling and stops receiving
messages while the instance is asleep. If you must, switch to a webhook
(`TELEGRAM_USE_WEBHOOK=true` plus `TELEGRAM_WEBHOOK_URL` and
`TELEGRAM_WEBHOOK_SECRET`).

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
npm test        # 28 unit tests: signature forgery, PayNow payloads, HTTP auth
npm run check   # parse every file, then run the tests
npm run test:e2e   # 28 more against a live database (see below)
```

The money and stock rules live in SQL, so they are tested in SQL. Against a
scratch database that has `schema.sql` and `seed.sql` applied:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test-logic.sql
```

14 assertions covering server-side totals, stock reservation, idempotent
approval, oversell rejection, hold release on reject/expire, the closed-store
gate, the open-order cap and the stock ledger. It runs inside a transaction
that is rolled back, so nothing it does survives.
