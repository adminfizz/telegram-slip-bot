// sheets-group.js — เก็บ record ประกาศกลุ่มลง Google Sheets tab `_group` (rows, กันซ้ำด้วย key)
// reuse auth เดียวกับบอท (authorize()) + spreadsheet เดิม → Vercel dashboard อ่านได้ทันที
const { google } = require('googleapis');

const TAB = '_group';
// คอลัมน์: A=key B=date C=time D=ts E=name F=bank G=account H=last4 I=amount J=user K=company L=usable M=raw N=reacts O=fire
// reacts = reaction ของ "ทั้งข้อความ" (เช่น "🔥x1 ⚡x2") — ทุก record ในข้อความเดียวกันได้ค่าเดียวกัน
const HEADER = ['key', 'date', 'time', 'ts', 'name', 'bank', 'account', 'last4', 'amount', 'user', 'company', 'usable', 'raw', 'reacts', 'fire'];
const RANGE = `${TAB}!A:O`;

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
  }
  // เขียน header ทุกครั้งที่ ensure (ครั้งแรกต่อ process) — อัปเกรดหัวคอลัมน์อัตโนมัติเมื่อเพิ่มคอลัมน์ใหม่
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${TAB}!A1:O1`, valueInputOption: 'RAW', resource: { values: [HEADER] },
  });
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

// สร้างแถว (15 คอลัมน์ A-O) จาก record เดียว
function rowOf(r) {
  return [
    `${r.msg_id}.${r.rec_idx}`, r.date || '', r.time || '', String(r.ts || ''),
    r.name || '', r.bank || r.bankRaw || '', r.account || '', r.last4 || '',
    r.amount == null ? '' : r.amount, r.user || '', r.company || '',
    r.usable ? '1' : '0', (r.raw || '').slice(0, 500),
    r.reacts || '', r.fire ? '1' : '0',
  ];
}

// เขียนทับ "เฉพาะช่วง date >= sinceDate" ด้วย records ล่าสุด — คงแถวเดือนก่อน (date < since) ไว้
// รองรับ แก้ไข (ยอดเปลี่ยน→ทับ) + ลบ (หายจาก records→หายจากชีต) โดยไม่แตะข้อมูลนอกช่วง
// safety: ถ้า records ว่างทั้งที่มีของเดิมในช่วง = สแกนน่าจะพลาด → ไม่เขียนทับ (กันข้อมูลหาย)
async function replaceGroupRecordsInRange(auth, spreadsheetId, records, sinceDate) {
  const run = writeChain.then(() => _replaceInRange(auth, spreadsheetId, records, sinceDate));
  writeChain = run.catch(() => {});
  return run;
}

async function _replaceInRange(auth, spreadsheetId, records, sinceDate) {
  await ensureGroupTab(auth, spreadsheetId);
  const sheets = client(auth);
  let existing = [];
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A2:O`, valueRenderOption: 'UNFORMATTED_VALUE' });
    existing = (r.data.values || []).map(row => row.map(c => (c == null ? '' : String(c))));
  } catch (_) {}
  const dateOf = row => String(row[1] || '');
  const keep = sinceDate ? existing.filter(row => dateOf(row) && dateOf(row) < sinceDate) : [];
  const inRangeOld = existing.length - keep.length;
  // safety guard: สแกนได้ 0 แต่ของเดิมในช่วงมีเยอะ = พลาด → ไม่เขียนทับ
  if (records.length === 0 && inRangeOld > 5) {
    return { skipped: true, reason: `guard: สแกนได้ 0 record แต่ของเดิมในช่วงมี ${inRangeOld} — ไม่เขียนทับ` };
  }
  const newRows = records.map(rowOf);
  const allRows = [...keep, ...newRows];
  // เขียนทับจาก A2 (update ก่อน—ไม่มี gap ว่าง) แล้ว clear ส่วนเกิน (ถ้าของเดิมยาวกว่า)
  if (allRows.length) {
    for (let i = 0; i < allRows.length; i += 500) {
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${TAB}!A${i + 2}`, valueInputOption: 'RAW',
        resource: { values: allRows.slice(i, i + 500) },
      });
    }
  }
  if (existing.length > allRows.length) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${TAB}!A${allRows.length + 2}:O${existing.length + 1}` });
  }
  keyCache.set(spreadsheetId, new Set(allRows.map(row => String(row[0]))));
  return { total: allRows.length, kept: keep.length, replaced: newRows.length, removed: Math.max(0, inRangeOld - newRows.length) };
}

// อ่าน record ในช่วงเวลา (from/to = YYYY-MM-DD inclusive; ไม่ใส่ = ทั้งหมด)
async function getGroupRecords(auth, spreadsheetId, { from = null, to = null } = {}) {
  const sheets = client(auth);
  let values = [];
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!A2:O` });
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
      reacts: row[13] || '', fire: String(row[14]) === '1',
    });
  }
  return out;
}

module.exports = { ensureGroupTab, appendGroupRecords, replaceGroupRecordsInRange, getGroupRecords, TAB, HEADER };
