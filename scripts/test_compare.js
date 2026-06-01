// เทียบความแม่นยำ OCR ทุก provider บนสลิปเก่า (ดึงจาก Drive)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const { extractWithModel } = require('../src/ocr');
const { listJobs } = require('../src/persistent_queue');

const MODELS = ['gemini-2.5-flash', 'gpt-4o', 'typhoon-ocr'];

function fileId(link) { const m = String(link || '').match(/\/d\/([^/]+)/); return m ? m[1] : null; }
function dl(drive, id, dest) {
  return new Promise(async (res, rej) => {
    try { const r = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
      const w = fs.createWriteStream(dest); r.data.on('error', rej).pipe(w); w.on('finish', res).on('error', rej);
    } catch (e) { rej(e); }
  });
}

(async () => {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const jobs = listJobs().filter(j => j.driveLink).slice(-8);
  const tmp = path.join(process.cwd(), 'temp'); if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  const stats = {}; MODELS.forEach(m => stats[m] = { complete: 0, ms: 0, err: 0 });
  let tested = 0;

  for (const job of jobs) {
    const id = fileId(job.driveLink); if (!id) continue;
    const dest = path.join(tmp, `cmp_${job.id}.jpg`);
    try { await dl(drive, id, dest); } catch (e) { console.log('ข้าม (โหลดรูปไม่ได้):', job.id); continue; }
    tested++;
    const ref = job.parsedData || {};
    console.log(`\n===== ${job.id}  [ของจริงที่บอทเคยจับ: last4=${ref.last4} amount=${ref.amount} type=${ref.tx_type}] =====`);
    for (const model of MODELS) {
      const t0 = Date.now();
      try {
        const r = await extractWithModel(model, dest);
        const ms = Date.now() - t0; stats[model].ms += ms;
        const d = r.data || {};
        const complete = Number(d.amount) > 0 && d.account_last4 && String(d.account_last4).toLowerCase() !== 'null';
        if (complete) stats[model].complete++;
        console.log(`  ${model.padEnd(22)} amount=${d.amount} last4=${d.account_last4} type="${d.tx_type}" date=${d.date} fee=${d.fee} (${ms}ms)`);
      } catch (e) {
        stats[model].err++;
        const msg = e.response ? JSON.stringify(e.response.data) : e.message;
        console.log(`  ${model.padEnd(22)} ❌ ${String(msg).slice(0, 140)}`);
      }
    }
    try { fs.unlinkSync(dest); } catch (_) {}
  }

  console.log(`\n===== สรุป (ทดสอบ ${tested} สลิป) =====`);
  MODELS.forEach(m => { const s = stats[m]; console.log(`  ${m.padEnd(22)} จับครบ ${s.complete}/${tested} | error ${s.err} | เฉลี่ย ${Math.round(s.ms / Math.max(1, tested))}ms`); });
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
