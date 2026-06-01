// ดู raw OCR text ของ 2 สลิปที่ Typhoon จับเลขบัญชีพลาด (jn7pie→983, ifb64c→null)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const { listJobs } = require('../src/persistent_queue');

const TARGETS = ['jn7pie', 'ifb64c'];
function fileId(link) { const m = String(link || '').match(/\/d\/([^/]+)/); return m ? m[1] : null; }
function dl(drive, id, dest) {
  return new Promise((res, rej) => {
    drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' })
      .then(r => { const w = fs.createWriteStream(dest); r.data.on('error', rej).pipe(w); w.on('finish', res).on('error', rej); })
      .catch(rej);
  });
}
async function typhoonRaw(imagePath) {
  const form = new FormData();
  form.append('file', fs.readFileSync(imagePath), { filename: 'slip.jpg', contentType: 'image/jpeg' });
  form.append('model', 'typhoon-ocr'); form.append('task_type', 'default');
  form.append('max_tokens', '16384'); form.append('temperature', '0.1');
  form.append('top_p', '0.6'); form.append('repetition_penalty', '1.2');
  const resp = await axios.post('https://api.opentyphoon.ai/v1/ocr', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.TYPHOON_API_KEY}` },
    timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  const out = [];
  for (const page of (resp.data.results || [])) {
    if (page.success && page.message) {
      const c = page.message.choices[0].message.content;
      try { out.push(JSON.parse(c).natural_text || c); } catch (_) { out.push(c); }
    }
  }
  return out.join('\n');
}

(async () => {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const tmp = path.join(process.cwd(), 'temp'); if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  const jobs = listJobs().filter(j => j.driveLink && TARGETS.some(t => j.id.includes(t)));
  for (const job of jobs) {
    const dest = path.join(tmp, `raw_${job.id}.jpg`);
    await dl(drive, fileId(job.driveLink), dest);
    console.log(`\n========== ${job.id} (ของจริง last4=${(job.parsedData||{}).last4}) ==========`);
    try { console.log(await typhoonRaw(dest)); }
    catch (e) { console.log('❌', e.response ? JSON.stringify(e.response.data).slice(0,200) : e.message); }
    try { fs.unlinkSync(dest); } catch (_) {}
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
