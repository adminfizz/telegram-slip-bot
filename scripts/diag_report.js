require('dotenv').config();
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const { getReport } = require('../src/sheets');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const tabs = meta.data.sheets.map(s => s.properties.title);
  console.log('TABS:', tabs.join(', '));

  const acct = tabs.find(t => t.startsWith('บัญชี_'));
  if (acct) {
    const raw = await sheets.spreadsheets.values.get({ spreadsheetId: ssid, range: `'${acct}'!A1:F4` });
    console.log(`\nRAW ${acct} (A1:F4):`);
    (raw.data.values || []).forEach((r, i) => console.log(' ', i, JSON.stringify(r)));
  }

  console.log('\n=== getReport(ALL) ===');
  const all = await getReport(auth, ssid, null, 'all');
  for (const [last4, d] of Object.entries(all)) {
    console.log(`  ${last4}: transfer=${d.transferSum}(${d.transferCount}) withdraw=${d.withdrawSum}(${d.withdrawCount}) other=${d.otherSum}(${d.otherCount}) total=${d.total}`);
  }

  console.log('\n=== getReport(TODAY) ===');
  const today = await getReport(auth, ssid, null, null);
  console.log('  accounts:', Object.keys(today).length);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
