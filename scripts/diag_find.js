require('dotenv').config();
const { google } = require('googleapis');
const { authorize } = require('../src/auth');

// ค้นหายอดในทุกแท็บบัญชี + dump แท็บที่ระบุ
// usage: node scripts/diag_find.js <amount> [last4]
(async () => {
  const amount = parseFloat(process.argv[2] || '30000');
  const dumpLast4 = process.argv[3] || '0906';
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const tabs = meta.data.sheets.map(s => s.properties.title).filter(t => t.startsWith('บัญชี_'));
  console.log('ACCOUNT TABS:', tabs.join(', '));

  const resp = await sheets.spreadsheets.values.batchGet({ spreadsheetId: ssid, ranges: tabs.map(t => `'${t}'!A:K`) });
  const num = (v) => parseFloat(String(v || '0').replace(/,/g, '')) || 0;

  console.log(`\n=== ค้นหายอด = ${amount} (และ ±1) ในทุกแท็บ ===`);
  let hits = 0;
  (resp.data.valueRanges || []).forEach((vr, idx) => {
    (vr.values || []).slice(1).forEach((row, r) => {
      if (!row[0]) return;
      if (Math.abs(num(row[1]) - amount) <= 1) {
        hits++;
        console.log(`  [${tabs[idx]}] row${r + 2}: date=${row[0]} amt=${row[1]} fee=${row[2]} type=${row[3]} cp=${row[4]} bank=${row[5]} recip=${row[9]} hash=${(row[8] || '').slice(0, 10)}`);
      }
    });
  });
  if (!hits) console.log('  ❌ ไม่พบยอดนี้ในแท็บใดเลย');

  const di = tabs.indexOf(`บัญชี_${dumpLast4}`);
  console.log(`\n=== DUMP บัญชี_${dumpLast4} (ทุกแถว) ===`);
  if (di < 0) { console.log('  (ไม่มีแท็บนี้)'); }
  else {
    const rows = (resp.data.valueRanges[di].values || []);
    console.log(`  rows (รวมหัว) = ${rows.length}, รายการ = ${rows.length - 1}`);
    rows.forEach((row, i) => {
      if (i === 0) return;
      console.log(`  row${i + 1}: date=${row[0]} amt=${row[1]} fee=${row[2]} type=${row[3]} cp=${row[4]} bank=${row[5]} drive=${row[7] ? 'y' : '-'} hash=${(row[8] || '').slice(0, 10)} recip=${row[9]}`);
    });
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
