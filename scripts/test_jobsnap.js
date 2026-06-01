require('dotenv').config();
const { authorize } = require('../src/auth');
const { setJobsSnapshot, getJobsSnapshot } = require('../src/sheets');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const sample = {
    jobs: [{ id: 'test1', status: 'done', last4: '1234', parsedData: { amount: 500, tx_type: 'โอน', bank: 'SCB' }, driveLink: 'https://drive.google.com/file/d/ABC123/view' }],
    stats: { total: 1, done: 1 },
    fetchedAt: new Date().toISOString(),
  };
  await setJobsSnapshot(auth, ssid, sample);
  const back = await getJobsSnapshot(auth, ssid);
  console.log('read back -> jobs:', back.jobs.length, '| stats.total:', back.stats.total, '| job[0].id:', back.jobs[0] && back.jobs[0].id);
  console.log(back.jobs[0] && back.jobs[0].id === 'test1' ? '✅ snapshot _jobs round-trip OK' : '❌ FAIL');
  await setJobsSnapshot(auth, ssid, { jobs: [], stats: {}, fetchedAt: new Date().toISOString() }); // เคลียร์
  console.log('cleared _jobs.');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
