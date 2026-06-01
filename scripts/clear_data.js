// One-off: clear Google Sheet account tabs + summary rows + all Drive slip files.
// Gives a clean slate so the bot recreates tabs in the new 9-column layout.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authorize } = require('../src/auth');
const { deleteAllDriveFiles } = require('../src/drive_admin');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth });
  console.log('SPREADSHEET_ID:', ssid);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: ssid });
  const tabs = meta.data.sheets.map(s => s.properties);

  // 1) delete all บัญชี_* account tabs
  const accountTabs = tabs.filter(p => p.title.startsWith('บัญชี_'));
  console.log(`\nAccount tabs (${accountTabs.length}): ${accountTabs.map(t => t.title).join(', ') || '(none)'}`);
  if (accountTabs.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: ssid,
      requestBody: { requests: accountTabs.map(p => ({ deleteSheet: { sheetId: p.sheetId } })) },
    });
    console.log(`✅ Deleted ${accountTabs.length} account tab(s).`);
  }

  // 2) clear summary data rows (keep header)
  const summary = tabs.find(p => !p.title.startsWith('บัญชี_') && p.title !== '_system');
  if (summary) {
    await sheets.spreadsheets.values.clear({ spreadsheetId: ssid, range: `'${summary.title}'!A2:Z` });
    console.log(`✅ Cleared summary rows in "${summary.title}".`);
  }

  // 3) delete all Drive files under TelegramSlipBot
  console.log('\nDeleting Drive files under TelegramSlipBot ...');
  const driveCount = await deleteAllDriveFiles(auth);
  console.log(`✅ Deleted ${driveCount} Drive item(s).`);

  // 4) reset local job store (ประวัติงาน + hash กันซ้ำ) ให้ส่งสลิปเดิมใหม่ได้
  const jobsPath = path.join(process.cwd(), 'data', 'slip_jobs.json');
  try {
    fs.writeFileSync(jobsPath, JSON.stringify({ jobs: [] }, null, 2), 'utf-8');
    console.log('✅ Reset local slip_jobs.json (cleared job history + dedup hashes).');
  } catch (e) {
    console.error('reset slip_jobs.json failed:', e.message);
  }

  // reset ตัวนับ token/จำนวนรูป (ทั้งไฟล์ในเครื่องและในแท็บ _system)
  const usagePath = path.join(process.cwd(), 'ai_usage.json');
  try {
    fs.writeFileSync(usagePath, JSON.stringify({ totalTokens: 0, count: 0 }, null, 2), 'utf-8');
    console.log('✅ Reset ai_usage.json (tokens + count = 0).');
  } catch (e) {
    console.error('reset ai_usage.json failed:', e.message);
  }
  try {
    const { setTokenUsage } = require('../src/sheets');
    await setTokenUsage(auth, ssid, 0, 0);
    console.log('✅ Reset usage counters in _system tab.');
  } catch (e) {
    console.error('reset _system usage failed:', e.message);
  }

  // เคลียร์ snapshot รายการงาน (หน้าคิวบน Vercel)
  try {
    const { setJobsSnapshot } = require('../src/sheets');
    await setJobsSnapshot(auth, ssid, { jobs: [], stats: {}, fetchedAt: new Date().toISOString() });
    console.log('✅ Cleared _jobs snapshot.');
  } catch (e) {
    console.error('reset _jobs failed:', e.message);
  }

  console.log('\n🧹 Sheet + Drive + local data + usage counters cleared. Fresh slate ready.');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
