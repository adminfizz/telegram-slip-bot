// sheets-group.js — เก็บ record ประกาศกลุ่มลง Google Sheets tab `_group` (rows, กันซ้ำด้วย key)
// reuse auth เดียวกับบอท (authorize()) + spreadsheet เดิม → Vercel dashboard อ่านได้ทันที
const { google } = require('googleapis');

const TAB = '_group';
// คอลัมน์: A=key B=date C=time D=ts E=name F=bank G=account H=last4 I=amount J=user K=company L=usable M=raw
const HEADER = ['key', 'date', 'time', 'ts', 'name', 'bank', 'account', 'last4', 'amount', 'user', 'company', 'usable', 'raw'];
const RANGE = `${TAB}!A:M`;

function client(auth) { return google.sheets({ version: 'v4', auth }); }

const tabReady = new Set();     // spreadsheetId ที่ ensure tab แล้ว (กันเรียก get ทุกครั้ง)
const keyCache = new Map();     // spreadsheetId -> Set(existing keys) ในหน่วยความจำ
let writeChain = Promise.resolve(); // serialize การเขียน กัน read-modify-write ชนกัน

async function ensureGroupTab(auth, spreadsheetId) {
  if (tabReady.has(spreadsheetId)) return;
  const sheets = client(auth);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = meta.data.sheets.find(s => s.properties.title === TAB);
  if (!found) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB, hidden: true, gridProperties: { frozenRowCount: 1 } } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${TAB}!A1:M1`, valueInputOption: 'RAW', resource: { values: [HEADER] },
    });
  }
  tabReady.add(spreadsheetId);
}

// อ่าน key ที่มีอยู่แล้ว (คอลัมน์ A) เพื่อกันซ้ำ — UNFORMATTED กัน locale ใส่ comma
async function existingKeys(auth, spreadsheetId) {
  const sheets = client(auth);
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A2:A`, valueRenderOption: 'UNFORMATTED_VALUE' });
    return new Set((r.data.values || []).map(row => String(row[0] || '')));
  } catch (_) { return new Set(); }
}

// records = ผลจาก parser + metadata — เขียนเฉพาะที่ยังไม่มี (serialize + cache key)
async function appendGroupRecords(auth, spreadsheetId, records) {
  if (!records || !records.length) return { added: 0, skipped: 0 };
  const run = writeChain.then(() => _appendGroupRecords(auth, spreadsheetId, records));
  writeChain = run.catch(() => {}); // กัน chain ทั้งสายพังเมื่อ error รายตัว
  return run;
}

async function _appendGroupRecords(auth, spreadsheetId, records) {
  await ensureGroupTab(auth, spreadsheetId);
  let seen = keyCache.get(spreadsheetId);
  if (!seen) { seen = await existingKeys(auth, spreadsheetId); keyCache.set(spreadsheetId, seen); }
  const rows = [], newKeys = [];
  let skipped = 0;
  for (const r of records) {
    const key = `${r.msg_id}.${r.rec_idx}`;
    if (seen.has(key) || newKeys.includes(key)) { skipped++; continue; }
    newKeys.push(key);
    rows.push([
      key, r.date || '', r.time || '', String(r.ts || ''),
      r.name || '', r.bank || r.bankRaw || '', r.account || '', r.last4 || '',
      r.amount == null ? '' : r.amount, r.user || '', r.company || '',
      r.usable ? '1' : '0', (r.raw || '').slice(0, 500),
    ]);
  }
  if (!rows.length) return { added: 0, skipped };
  const sheets = client(auth);
  // append ทีละก้อน (≤500 แถว/ครั้ง กัน payload ใหญ่)
  for (let i = 0; i < rows.length; i += 500) {
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: RANGE, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      resource: { values: rows.slice(i, i + 500) },
    });
  }
  newKeys.forEach(k => seen.add(k)); // เพิ่มเข้า cache หลังเขียนสำเร็จ (ถ้า throw จะ retry รอบหน้า)
  return { added: rows.length, skipped };
}

// อ่าน record ในช่วงเวลา (from/to = YYYY-MM-DD inclusive; ไม่ใส่ = ทั้งหมด)
async function getGroupRecords(auth, spreadsheetId, { from = null, to = null } = {}) {
  const sheets = client(auth);
  let values = [];
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A2:M` });
    values = r.data.values || [];
  } catch (_) { return []; }
  const out = [];
  for (const row of values) {
    const date = row[1] || '';
    if (from && date < from) continue;
    if (to && date > to) continue;
    // strip comma กัน FORMATTED_VALUE ใส่ตัวคั่นหลักพัน → Number(...)=NaN
    const num = v => Number(String(v == null ? '' : v).replace(/,/g, ''));
    out.push({
      key: String(row[0] || ''), date, time: row[2] || '', ts: num(row[3]),
      name: row[4] || '', bank: row[5] || '', account: row[6] || '', last4: row[7] || '',
      amount: (row[8] === '' || row[8] == null) ? null : num(row[8]), user: row[9] || '', company: row[10] || '',
      usable: String(row[11]) === '1', raw: row[12] || '',
    });
  }
  return out;
}

module.exports = { ensureGroupTab, appendGroupRecords, getGroupRecords, TAB, HEADER };
