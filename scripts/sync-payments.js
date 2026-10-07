#!/usr/bin/env node
/**
 * Fill the "Payments" tab from orders that were paid before it existed.
 *
 * New payments reach the tab on their own, with every order transition. This
 * is for the orders that came before: each one is re-synced, which refreshes
 * its Orders row and adds the Payments row it is missing. Safe to re-run;
 * rows are matched on Purchase ID, never duplicated.
 */
import 'dotenv/config';
import { ensureTabs, sheetsEnabled } from '../src/lib/sheets.js';
import { syncOrderToSheets } from '../src/services/collation.service.js';
import { query, close } from '../src/lib/db.js';

if (!sheetsEnabled()) {
  console.error('⚠️  Google Sheets is not configured - check GOOGLE_SHEETS_ID and the service account vars.');
  process.exit(1);
}

try {
  await ensureTabs(true);
  const orders = await query(
    `select id from orders
      where payment_proof_id is not null
         or proof_source is not null
         or status in ('paid', 'collected')
      order by created_at`
  );
  let synced = 0;
  for (const { id } of orders) {
    if (await syncOrderToSheets(id)) synced += 1;
  }
  console.log(`✅ Synced ${synced} of ${orders.length} paid orders to the Payments tab.`);
  if (synced < orders.length) process.exitCode = 1;
} catch (err) {
  console.error('❌ Sync failed:', err.message);
  process.exitCode = 1;
} finally {
  await close();
}
