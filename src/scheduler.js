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

// ─── Health watchdog: เฝ้าระวังระบบ + แจ้งเตือน Telegram เมื่อมีปัญหา ───────────
let _healthAlertKeys = new Set();
let _healthChecking = false;

async function runHealthCheck(bot, authClient, getSpreadsheetId) {
  if (_healthChecking) return { skipped: true };
  _healthChecking = true;
  try {
    const chatId = process.env.SUMMARY_CHAT_ID;
    const spreadsheetId = getSpreadsheetId();
    const problems = []; // { key, text }

    // 1) เชื่อมต่อ Google / token ใช้ได้ไหม (เรียก API จริง 1 ครั้งเบาๆ)
    if (!spreadsheetId) {
      problems.push({ key: 'nospreadsheet', text: '🟠 ยังไม่ได้เชื่อมต่อ Spreadsheet' });
    } else {
      try {
        const sheets = google.sheets({ version: 'v4', auth: authClient });
        await sheets.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId' });
      } catch (e) {
        const msg = String(e && e.message || e);
        const authErr = /invalid_grant|unauthorized|invalid credentials|no refresh token|insufficient|forbidden|permission|401|403/i.test(msg);
        problems.push({
          key: 'google',
          text: authErr
            ? `🔴 เชื่อมต่อ Google ไม่ได้ — token อาจถูก revoke/หมดสิทธิ์ ต้อง Authorize ใหม่\n   (${msg.slice(0, 120)})`
            : `🔴 เรียก Google Sheets ไม่สำเร็จ: ${msg.slice(0, 120)}`,
        });
      }
    }

    // 2) โควต้า Google Sheets ใกล้เต็มไหม
    try {
      const { getQuotaUsage } = require('./sheets');
      const q = getQuotaUsage();
      const rPct = q.read.limit ? q.read.used / q.read.limit : 0;
      const wPct = q.write.limit ? q.write.used / q.write.limit : 0;
      if (rPct >= 0.95 || wPct >= 0.95) {
        problems.push({ key: 'quota', text: `🟠 โควต้า Google Sheets ใกล้เต็ม (read ${q.read.used}/${q.read.limit}, write ${q.write.used}/${q.write.limit})` });
      }
    } catch (_) {}

    // 3) มีงานค้างประมวลผลนานผิดปกติไหม (> 15 นาที)
    try {
      const { listJobs } = require('./persistent_queue');
      const now = Date.now();
      const stuck = listJobs({ status: 'processing' }).filter(j => {
        const t = Date.parse(j.startedAt || j.updatedAt || j.createdAt || '');
        return t && (now - t) > 15 * 60 * 1000;
      });
      if (stuck.length) {
        problems.push({ key: 'stuck', text: `🟠 มีงานค้างประมวลผลเกิน 15 นาที ${stuck.length} งาน (${stuck.map(j => j.id).slice(0, 3).join(', ')})` });
      }
    } catch (_) {}

    // ── แจ้งเตือนเฉพาะตอน "สถานะเปลี่ยน" เพื่อกัน spam ──
    const curKeys = new Set(problems.map(p => p.key));
    const hasNew = problems.some(p => !_healthAlertKeys.has(p.key));
    const recovered = _healthAlertKeys.size > 0 && curKeys.size === 0;

    if (chatId && bot) {
      if (hasNew) {
        const text = ['⚠️ แจ้งเตือนระบบ Slip Bot', ...problems.map(p => p.text), '', `🕐 ${new Date().toLocaleString('th-TH')}`].join('\n');
        try { await bot.sendMessage(chatId, text); } catch (_) {}
      } else if (recovered) {
        try { await bot.sendMessage(chatId, '✅ ระบบ Slip Bot กลับมาทำงานปกติแล้ว'); } catch (_) {}
      }
    }
    if (problems.length) console.warn('[health] ปัญหา:', problems.map(p => p.key).join(', '));
    else console.log('[health] ปกติ');
    _healthAlertKeys = curKeys;
    return { problems: problems.map(p => p.key) };
  } finally {
    _healthChecking = false;
  }
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

  // เฝ้าระวังสุขภาพระบบ + แจ้งเตือน Telegram (ดีฟอลต์ทุก 15 นาที)
  const healthCron = process.env.HEALTH_CHECK_CRON || '*/15 * * * *';
  cron.schedule(healthCron, () => { runHealthCheck(bot, authClient, getSpreadsheetId).catch(() => {}); });
  console.log(`🩺 Health watchdog scheduled: ${healthCron}`);
  // เช็คครั้งแรกหลังบูต ~60 วิ (ให้ระบบตั้งตัวก่อน)
  const t = setTimeout(() => { runHealthCheck(bot, authClient, getSpreadsheetId).catch(() => {}); }, 60000);
  if (t.unref) t.unref();
}

module.exports = { setupScheduler, runHealthCheck };
