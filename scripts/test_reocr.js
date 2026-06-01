// One-off test: re-OCR previously-captured slips (pulled from Google Drive)
// using the UPDATED ocr.js + parser.js, and compare BEFORE vs AFTER.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const { extractSlipData } = require('../src/ocr');
const { parseSlipData } = require('../src/parser');

function fileIdFromLink(link) {
  const m = String(link || '').match(/\/d\/([^/]+)/);
  return m ? m[1] : null;
}

function downloadFile(drive, fileId, dest) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
      const w = fs.createWriteStream(dest);
      res.data.on('end', () => resolve()).on('error', reject).pipe(w);
    } catch (e) { reject(e); }
  });
}

(async () => {
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });

  const jobsPath = path.join(process.cwd(), 'data', 'slip_jobs.json');
  const { jobs } = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
  const tmpDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`Re-OCR ${jobs.length} slip(s) with updated code...\n`);

  for (const job of jobs) {
    const before = job.parsedData || {};
    const fileId = fileIdFromLink(job.driveLink);
    console.log('======================================================');
    console.log('Job:', job.id);
    if (!fileId) { console.log('  ⚠️ no drive link, skip'); continue; }

    const dest = path.join(tmpDir, `reocr_${job.id}.jpg`);
    try {
      await downloadFile(drive, fileId, dest);
    } catch (e) {
      console.log('  ❌ download failed:', e.message);
      continue;
    }

    let ocr = null;
    try { ocr = await extractSlipData(dest); }
    catch (e) { console.log('  ❌ OCR error:', e.message); }
    const after = parseSlipData(ocr ? ocr.data : null);
    try { fs.unlinkSync(dest); } catch (_) {}

    console.log('  RAW OCR (ดิบจากสลิป):', ocr ? JSON.stringify(ocr.data, null, 0) : 'null');
    console.log('  BEFORE (ที่บันทึกไว้เดิม):');
    console.log('     date =', JSON.stringify(before.date), '| amount =', before.amount,
      '| fee =', before.fee, '| tx_type =', JSON.stringify(before.tx_type), '| last4 =', before.last4);
    console.log('  AFTER  (โค้ดใหม่):');
    if (after) {
      console.log('     date =', JSON.stringify(after.date), '| amount =', after.amount,
        '| fee =', after.fee, '| tx_type =', JSON.stringify(after.tx_type), '| last4 =', after.last4);
    } else {
      console.log('     (parse failed)');
    }
  }
  console.log('\n======================================================\nDone.');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
