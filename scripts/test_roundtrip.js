// Decisive test: does the new "DD-MM HH:mm" date survive a round-trip through
// Google Sheets (USER_ENTERED write → values.get read)? If Sheets coerces it to a
// date serial, the today-filter breaks. Uses a throwaway tab and cleans up after.
require('dotenv').config();
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const S = require('../src/sheets');
const { normalizeSlipDate } = require('../src/parser');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth });
  const last4 = process.argv[2] || '0000'; // รับเลขบัญชีความยาวใดก็ได้ (2-6 หลัก)
  const tabName = `บัญชี_${last4}`;
  const todayFull = S.getTodayStr();          // "YYYY-MM-DD" ปีปัจจุบัน
  const [, mm, dd] = todayFull.split('-');
  const slipRaw = `2099-${mm}-${dd} 22:33`;   // จำลองสลิปที่อ่าน "ปีผิด" (2099)
  const dateVal = normalizeSlipDate(slipRaw); // ต้องแทนปีด้วยปีปัจจุบัน วัน/เดือน/เวลาคงเดิม
  const expectedDate = `${todayFull} 22:33`;

  console.log('SPREADSHEET_ID:', ssid);
  console.log('Slip raw date (ปีผิด 2099):', JSON.stringify(slipRaw));
  console.log('normalizeSlipDate →', JSON.stringify(dateVal),
    dateVal === expectedDate ? '✅ ปีถูกแทนเป็นปีปัจจุบัน วัน/เดือน/เวลาคงเดิม' : '❌ ปีไม่ถูกแทน');
  console.log('Storing date value:', JSON.stringify(dateVal), '\n');

  await S.getOrCreateAccountTab(auth, ssid, last4, 'TEST');
  await S.appendSlip(auth, ssid, last4, {
    date: dateVal, amount: 12345.67, fee: 5, tx_type: 'TRANSFER',
    counterparty: 'ROUNDTRIP TEST', bank: 'TEST', senderTG: '@test',
    driveLink: '-', hash: 'roundtrip_test_hash',
  });

  const rb = await sheets.spreadsheets.values.get({ spreadsheetId: ssid, range: `'${tabName}'!A2:I2` });
  const row = (rb.data.values && rb.data.values[0]) || [];
  console.log('Read-back row:', JSON.stringify(row));
  console.log('  A date  =', JSON.stringify(row[0]), 'expected', JSON.stringify(dateVal),
    row[0] === dateVal ? '✅ MATCH (literal text preserved)' : '❌ COERCED — sheet changed the value');
  console.log('  C fee   =', JSON.stringify(row[2]));
  console.log('  D type  =', JSON.stringify(row[3]));
  console.log('  I hash  =', JSON.stringify(row[8]));

  const rep = await S.getReport(auth, ssid, last4);
  const acc = rep[last4] || {};
  console.log('\ngetReport(today) →', JSON.stringify(acc));
  console.log(acc.transferCount > 0
    ? '✅ today-filter INCLUDED the row (dashboard/report would show it)'
    : '❌ today-filter did NOT include the row (would show empty)');

  // idempotency: เขียนซ้ำด้วย hash เดิม (จำลองการ retry) → ต้องไม่เกิดแถวซ้ำ (บั๊ก 80000)
  await S.appendSlip(auth, ssid, last4, {
    date: dateVal, amount: 12345.67, fee: 5, tx_type: 'TRANSFER',
    counterparty: 'ROUNDTRIP TEST', bank: 'TEST', senderTG: '@test',
    driveLink: '-', hash: 'roundtrip_test_hash',
  });
  const allHashes = await sheets.spreadsheets.values.get({ spreadsheetId: ssid, range: `'${tabName}'!I:I` });
  const cnt = (allHashes.data.values || []).flat().filter(h => h === 'roundtrip_test_hash').length;
  console.log(`\nIdempotency: append ซ้ำ hash เดิม → จำนวนแถวที่มี hash นี้ = ${cnt}`,
    cnt === 1 ? '✅ ไม่เกิดแถวซ้ำ' : '❌ เกิดแถวซ้ำ!');

  // cleanup
  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const sh = meta.data.sheets.find(s => s.properties.title === tabName);
  if (sh) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssid,
      requestBody: { requests: [{ deleteSheet: { sheetId: sh.properties.sheetId } }] } });
    console.log('\n🧹 Deleted throwaway tab', tabName);
  }
  await S.syncSummaryTab(auth, ssid);
  console.log('Summary re-synced (without test tab).');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
