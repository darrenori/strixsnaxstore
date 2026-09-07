#!/usr/bin/env node
/** Push the current catalogue into the "Items & Stock" tab on demand. */
import 'dotenv/config';
import { syncCatalog, ensureTabs, sheetsEnabled } from '../src/lib/sheets.js';
import { getCatalogForSheets } from '../src/services/catalog.service.js';

if (!sheetsEnabled()) {
  console.error('⚠️  Google Sheets is not configured — check GOOGLE_SHEETS_ID and the service account vars.');
  process.exit(1);
}

try {
  await ensureTabs(true);
  const rows = await getCatalogForSheets();
  await syncCatalog(rows);
  console.log(`✅ Synced ${rows.length} items to the spreadsheet.`);
} catch (err) {
  console.error('❌ Sync failed:', err.message);
  process.exitCode = 1;
}
