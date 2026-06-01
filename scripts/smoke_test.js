// Smoke test: ตรวจ pipeline จริงหลังแก้เยอะ — extractSlipData (chain+attempts+recipient_last4),
// แต่ละ provider (เช็ค GPT strict schema), getReport (_fees/recipients/last4), getTrends
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const { extractSlipData, extractWithModel } = require('../src/ocr');
const { getReport, getTrends } = require('../src/sheets');
const { listJobs } = require('../src/persistent_queue');
const { parseSlipData } = require('../src/parser');

function fileId(l){const m=String(l||'').match(/\/d\/([^/]+)/);return m?m[1]:null;}
function dl(drive,id,dest){return new Promise((res,rej)=>{drive.files.get({fileId:id,alt:'media'},{responseType:'stream'}).then(r=>{const w=fs.createWriteStream(dest);r.data.on('error',rej).pipe(w);w.on('finish',res).on('error',rej);}).catch(rej);});}

(async () => {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const ssid = process.env.SPREADSHEET_ID;
  const job = listJobs().filter(j => j.driveLink).slice(-1)[0];
  if (!job) { console.log('ไม่มีสลิปทดสอบ'); process.exit(0); }
  const tmp = path.join(process.cwd(), 'temp'); if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  const dest = path.join(tmp, 'smoke.jpg');
  await dl(drive, fileId(job.driveLink), dest);

  console.log('===== 1) extractSlipData (full chain) =====');
  const r = await extractSlipData(dest);
  console.log('status:', r.status, '| provider:', r.provider, '| usedFallback:', r.usedFallback);
  console.log('data:', JSON.stringify(r.data));
  console.log('recipient_last4:', r.data && r.data.recipient_last4);
  console.log('attempts:', JSON.stringify(r.attempts));
  console.log('parseSlipData →', JSON.stringify(parseSlipData(r.data)));

  console.log('\n===== 2) แต่ละ provider (เช็ค schema/strict) =====');
  for (const m of ['gemini-2.5-flash', 'gpt-4o', 'typhoon-ocr']) {
    try { const x = await extractWithModel(m, dest); console.log(`  ${m}: OK last4=${x.data.account_last4} recip=${x.data.recipient_last4} amt=${x.data.amount}`); }
    catch (e) { console.log(`  ${m}: ❌ ${e.response?JSON.stringify(e.response.data).slice(0,150):e.message}`); }
  }

  console.log('\n===== 3) getReport (all) =====');
  const rep = await getReport(auth, ssid, null, 'all');
  const accts = Object.keys(rep).filter(k => !k.startsWith('_'));
  console.log('accounts:', accts.length, '| ตัวอย่าง feeSum:', accts[0]?rep[accts[0]].feeSum:'-', '| bank:', accts[0]?rep[accts[0]].bank:'-');
  console.log('_fees:', JSON.stringify(rep._fees));
  console.log('_recipients[0]:', JSON.stringify((rep._recipients||[])[0]));
  console.log('per-acct recipients[0]:', accts[0]?JSON.stringify((rep[accts[0]].recipients||[])[0]):'-');

  console.log('\n===== 4) getTrends 7d =====');
  const t = await getTrends(auth, ssid, 7);
  console.log('days:', t.length, '| last:', JSON.stringify(t[t.length-1]));

  try { fs.unlinkSync(dest); } catch (_) {}
  console.log('\n✅ smoke test done');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
