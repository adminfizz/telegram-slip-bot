// เขียน/เคลียร์ snapshot งานตัวอย่างลง _jobs (ใช้ทดสอบว่า Vercel อ่านได้)
require('dotenv').config();
const { authorize } = require('../src/auth');
const { setJobsSnapshot } = require('../src/sheets');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const mode = process.argv[2] || 'write';
  let payload = { jobs: [], stats: {}, fetchedAt: new Date().toISOString() };
  if (mode === 'write') {
    payload = {
      jobs: [
        { id: 'demo_A', status: 'done', step: 'done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), senderTG: '@demo', last4: '1234', parsedData: { last4: '1234', amount: 5000, tx_type: 'โอน', bank: 'SCB' }, fileHash: 'abc12345', driveLink: 'https://drive.google.com/file/d/DEMOID/view' },
        { id: 'demo_B', status: 'processing', step: 'ocr', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), senderTG: '@demo', last4: '', parsedData: null, fileHash: '', driveLink: '' },
      ],
      stats: { total: 2, done: 1, recoverable: 1, failed: 0 },
      fetchedAt: new Date().toISOString(),
    };
  }
  await setJobsSnapshot(auth, ssid, payload);
  console.log(`_jobs ${mode}: ${payload.jobs.length} job(s)`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
