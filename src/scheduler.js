const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getReport, formatReport, getTodayStr } = require('./sheets');

// สำรองข้อมูลทุกบัญชีเป็นไฟล์ Excel ในเครื่อง (data/backups) เก็บล่าสุด 14 ไฟล์
async function runDailyBackup(authClient, spreadsheetId) {
  const XLSX = require('xlsx');
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs = meta.data.sheets.map(s => s.properties.title).filter(t => t.startsWith('บัญชี_'));
  if (tabs.length === 0) return;
  const wb = XLSX.utils.book_new();
  for (const t of tabs) {
    try {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${t}'!A:J` });
      const rows = r.data.values || [];
      if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), t.replace('บัญชี_', 'Acc_').slice(0, 31));
    } catch (_) {}
  }
  if (wb.SheetNames.length === 0) return;
  const dir = path.join(process.cwd(), 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backup_${getTodayStr()}.xlsx`);
  XLSX.writeFile(wb, file);
  // เก็บล่าสุด 14 ไฟล์
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('backup_') && f.endsWith('.xlsx')).sort();
    while (files.length > 14) { fs.unlinkSync(path.join(dir, files.shift())); }
  } catch (_) {}
  console.log(`💾 Daily backup saved: ${file}`);
}

function setupScheduler(bot, authClient, getSpreadsheetId) {
  const scheduleTime = process.env.SUMMARY_TIME || '59 23 * * *';

  // สำรองข้อมูลรายวัน 00:30
  cron.schedule(process.env.BACKUP_TIME || '30 0 * * *', async () => {
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return;
    try { await runDailyBackup(authClient, spreadsheetId); }
    catch (e) { console.error('❌ Daily backup error:', e.message); }
  });
  console.log('💾 Daily backup scheduled at: 00:30');

  cron.schedule(scheduleTime, async () => {
    console.log('⏰ Running daily summary scheduler...');

    const chatId = process.env.SUMMARY_CHAT_ID;
    if (!chatId) {
      console.log('⚠️ SUMMARY_CHAT_ID not set in .env, skipping daily summary.');
      return;
    }

    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) {
      console.log('⚠️ Spreadsheet not initialized yet, skipping.');
      return;
    }

    try {
      const report = await getReport(authClient, spreadsheetId);
      const reply = formatReport(report);
      await bot.sendMessage(chatId, reply);
      console.log('✅ Daily summary sent.');
    } catch (error) {
      console.error('❌ Scheduler error:', error);
    }
  });

  console.log(`⏰ Daily summary scheduled at: ${scheduleTime}`);
}

module.exports = { setupScheduler };
