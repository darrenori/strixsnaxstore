#!/usr/bin/env node
/**
 * Create the collation spreadsheet and print its id.
 *
 *   npm run sheets:bootstrap -- you@gmail.com
 *
 * The service account owns the new file, so it is shared with the email you
 * pass (and with anyone else you add later in Drive). Put the printed id into
 * GOOGLE_SHEETS_ID and restart the server.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { TABS } from '../src/lib/sheets.js';

const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const key = (process.env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
const shareWith = process.argv[2] ?? process.env.GOOGLE_SHARE_WITH;

if (!email || !key) {
  console.error('\n⚠️  Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in .env first.\n');
  process.exit(1);
}

const auth = new google.auth.JWT({
  email,
  key,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ],
});

try {
  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const tabs = Object.values(TABS);

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `STRIX Snax Store — Collation ${new Date().getFullYear()}` },
      sheets: tabs.map((tab, index) => ({
        properties: {
          title: tab.title,
          index,
          gridProperties: {
            rowCount: 2000,
            columnCount: Math.max(tab.headers.length, 12),
            frozenRowCount: 1,
          },
        },
      })),
    },
  });

  const spreadsheetId = created.data.spreadsheetId;

  // Header rows.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: tabs.map((tab) => ({ range: `${tab.title}!A1`, values: [tab.headers] })),
    },
  });

  // Bold the header row on every tab so the sheet is readable at a glance.
  const sheetIds = new Map(
    (created.data.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId])
  );
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: tabs.flatMap((tab) => {
        const sheetId = sheetIds.get(tab.title);
        if (sheetId === undefined) return [];
        return [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.14, green: 0.22, blue: 0.36 },
                },
              },
              fields: 'userEnteredFormat(textFormat,backgroundColor)',
            },
          },
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 } } } },
              fields: 'userEnteredFormat.textFormat.foregroundColor',
            },
          },
          {
            autoResizeDimensions: {
              dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: tab.headers.length },
            },
          },
        ];
      }),
    },
  });

  if (shareWith) {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { type: 'user', role: 'writer', emailAddress: shareWith },
      sendNotificationEmail: false,
    });
    console.log(`🔗 Shared with ${shareWith}`);
  } else {
    console.log('ℹ️  No email given — run again with your address to get edit access:');
    console.log('   npm run sheets:bootstrap -- you@gmail.com');
  }

  console.log('\n✅ Spreadsheet created\n');
  console.log(`   GOOGLE_SHEETS_ID=${spreadsheetId}\n`);
  console.log(`   https://docs.google.com/spreadsheets/d/${spreadsheetId}\n`);
  console.log('Put that id in .env and restart the server.\n');
} catch (err) {
  console.error('\n❌ Could not create the spreadsheet:', err.message);
  if (String(err.message).includes('storageQuotaExceeded')) {
    console.error('   Service accounts have no Drive quota of their own.');
    console.error('   Create a blank sheet in your own Drive, share it with');
    console.error(`   ${email} as Editor, and paste its id into GOOGLE_SHEETS_ID instead.`);
  }
  process.exitCode = 1;
}
