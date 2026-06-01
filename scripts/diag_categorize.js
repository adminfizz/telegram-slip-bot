require('dotenv').config();
const { google } = require('googleapis');
const { authorize } = require('../src/auth');

// ตรรกะจัดหมวดเดียวกับ getReport
function categorize(type) {
  const s = String(type || '');
  const t = s.toLowerCase();
  if (s.includes('ถอน') || t.includes('withdraw')) return 'ถอน';
  if (s.includes('ฝาก') || s.includes('รับ') || t.includes('deposit')) return 'ฝาก/รับ';
  if (s.includes('บิล') || s.includes('ชำระ') || t.includes('bill') || t.includes('payment')) return 'บิล';
  if (s.includes('โอน') || t.includes('transfer') || t.includes('promptpay')) return 'โอน';
  return 'อื่นๆ';
}

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const tabs = meta.data.sheets.map(s => s.properties.title).filter(t => t.startsWith('บัญชี_'));
  if (!tabs.length) { console.log('no account tabs'); process.exit(0); }
  const resp = await sheets.spreadsheets.values.batchGet({ spreadsheetId: ssid, ranges: tabs.map(t => `'${t}'!A:F`) });

  const allTypes = {};   // tx_type -> category
  const otherRows = [];
  (resp.data.valueRanges || []).forEach((vr, i) => {
    (vr.values || []).slice(1).forEach(row => {
      const type = row[3] || '';
      const cat = categorize(type);
      allTypes[type] = cat;
      if (cat === 'อื่นๆ') otherRows.push(`${tabs[i]} | "${type}" | ${row[1]}`);
    });
  });

  console.log('=== tx_type ทั้งหมด → หมวด ===');
  for (const [ty, cat] of Object.entries(allTypes)) console.log(`  "${ty}" → ${cat}`);
  console.log('\n=== รายการที่ตก "อื่นๆ" ===');
  if (otherRows.length === 0) console.log('  (ไม่มี)');
  else otherRows.forEach(r => console.log('  ' + r));
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
