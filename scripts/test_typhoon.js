// เทส Typhoon OCR ผ่าน endpoint /v1/ocr (แบบเดียวกับโค้ด Python ที่ทางการให้มา)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const { listJobs } = require('../src/persistent_queue');

function fileId(link) { const m = String(link || '').match(/\/d\/([^/]+)/); return m ? m[1] : null; }
function dl(drive, id, dest) {
  return new Promise(async (res, rej) => {
    try { const r = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
      const w = fs.createWriteStream(dest); r.data.on('error', rej).pipe(w); w.on('finish', res).on('error', rej);
    } catch (e) { rej(e); }
  });
}

// เลียนแบบ extract_text_from_image() ของ Python
async function typhoonOcr(imagePath, { model = 'typhoon-ocr', task_type = 'default', max_tokens = 16384, temperature = 0.1, top_p = 0.6, repetition_penalty = 1.2 } = {}) {
  const form = new FormData();
  form.append('file', fs.readFileSync(imagePath), { filename: path.basename(imagePath), contentType: 'image/jpeg' });
  form.append('model', model);
  form.append('task_type', task_type);
  form.append('max_tokens', String(max_tokens));
  form.append('temperature', String(temperature));
  form.append('top_p', String(top_p));
  form.append('repetition_penalty', String(repetition_penalty));

  const resp = await axios.post('https://api.opentyphoon.ai/v1/ocr', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.TYPHOON_API_KEY}` },
    timeout: 120000,
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });

  const texts = [];
  for (const page of (resp.data.results || [])) {
    if (page.success && page.message) {
      const content = page.message.choices[0].message.content;
      try { const parsed = JSON.parse(content); texts.push(parsed.natural_text || content); }
      catch (_) { texts.push(content); }
    } else if (!page.success) {
      console.log(`  ❌ page error: ${page.error || 'unknown'}`);
    }
  }
  return texts.join('\n');
}

(async () => {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const job = listJobs().filter(j => j.driveLink).slice(-1)[0];
  const tmp = path.join(process.cwd(), 'temp'); if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  const dest = path.join(tmp, `typhoon_test.jpg`);
  await dl(drive, fileId(job.driveLink), dest);
  console.log(`สลิป: ${job.id} (ของจริง last4=${(job.parsedData||{}).last4} amount=${(job.parsedData||{}).amount})\n`);

  const t0 = Date.now();
  try {
    const text = await typhoonOcr(dest);
    console.log(`===== Typhoon OCR /v1/ocr  [${Date.now()-t0}ms] =====\n`);
    console.log(text);
  } catch (e) {
    const msg = e.response ? JSON.stringify(e.response.data) : e.message;
    console.log(`❌ ${String(msg).slice(0, 400)}`);
  }
  try { fs.unlinkSync(dest); } catch (_) {}
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
