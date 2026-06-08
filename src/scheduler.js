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

// ซิงค์ SQLite mirror ให้ครบจากชีต (กันข้อมูลในตัวสำรองหายไม่ครบ) — คืนจำนวนที่ซิงค์
async function reconcileMirror(authClient, spreadsheetId) {
  const { listTransactions } = require('./sheets');
  const { mirrorMany, localDbStats } = require('./localdb');
  const rows = await listTransactions(authClient, spreadsheetId, { limit: 100000 });
  const n = mirrorMany(rows);
  const s = localDbStats();
  console.log(`🔄 SQLite mirror ซิงค์ ${n} รายการ (ตอนนี้มี ${s.count} รายการ)`);
  return n;
}

// รีเช็ครายวัน: รูปที่ส่งเข้า Telegram วันนี้ (= จำนวน job) vs รูปที่ผ่าน OCR/บันทึกแล้ว — ตรงกันไหม
async function runDailyReconcile(bot, authClient, getSpreadsheetId) {
  const { listJobs } = require('./persistent_queue');
  const { getTodayStr, appendReconcile } = require('./sheets');
  const spreadsheetId = getSpreadsheetId();
  const today = getTodayStr();

  // นับ job ที่ "สร้างวันนี้" (= รูปที่ส่งเข้ามาวันนี้) แยกตามสถานะ
  const todayJobs = listJobs().filter(j => {
    try { return getTodayStr(new Date(j.createdAt)) === today; } catch (_) { return false; }
  });
  const recoverable = new Set(['queued', 'processing', 'download', 'duplicate_check', 'ocr', 'ocr_retry', 'upload_drive', 'save_sheet']);
  let done = 0, review = 0, duplicate = 0, failed = 0, pending = 0;
  todayJobs.forEach(j => {
    if (j.status === 'done') done++;
    else if (j.status === 'review') review++;
    else if (j.status === 'duplicate') duplicate++;
    else if (j.status === 'failed' || j.status === 'error') failed++;
    else if (recoverable.has(j.status)) pending++;
    else done++; // เผื่อสถานะ done อื่นๆ
  });
  const received = todayJobs.length;
  const passedOcr = done + review + duplicate;            // ผ่าน OCR ได้ข้อมูล (รวมที่รอตรวจ/ซ้ำ)
  const accountedInSheet = done + duplicate;              // จบลงชีตแล้ว (บันทึก/ข้ามซ้ำ)
  const matched = (received === accountedInSheet) && review === 0 && failed === 0 && pending === 0;
  const leftover = received - accountedInSheet;           // ยังไม่จบลงชีต (รอตรวจ/ล้มเหลว/ค้าง)

  const record = { date: today, received, done, review, duplicate, failed, pending, passedOcr, matched, leftover };

  const summary = [
    `📊 รีเช็ครายวัน ${today} (23:55)`,
    `📥 รูปที่ส่งเข้า Telegram วันนี้: ${received}`,
    `✅ ผ่าน OCR + บันทึกลงชีต: ${done}`,
    `🟡 รอตรวจ (OCR ไม่ครบ/สำรอง): ${review}`,
    `♻️ ซ้ำ (ข้าม): ${duplicate}`,
    `❌ ล้มเหลว: ${failed}`,
    `⏳ ค้าง/กำลังทำ: ${pending}`,
    matched
      ? `✔️ ผลตรวจ: ตรงกัน — ทุกรูปจบลงชีตครบ`
      : `⚠️ ผลตรวจ: ไม่ตรง — มี ${leftover} รูปยังไม่ลงชีต (รอตรวจ ${review} / ล้มเหลว ${failed} / ค้าง ${pending})`,
  ].join('\n');

  // 1) log → โผล่ในแท็บ Log ของ dashboard local (logBuffer)
  console.log(summary);
  // 2) เก็บลงชีต → dashboard บน Vercel อ่านได้เหมือนกัน
  if (spreadsheetId) {
    try { await appendReconcile(authClient, spreadsheetId, record); } catch (e) { console.error('appendReconcile error:', e.message); }
  }
  // 3) แจ้ง Telegram เฉพาะตอน "ไม่ตรง" (กัน spam)
  const chatId = process.env.SUMMARY_CHAT_ID;
  if (bot && chatId && !matched) {
    try { await bot.sendMessage(chatId, summary); } catch (_) {}
  }
  return record;
}

function setupScheduler(bot, authClient, getSpreadsheetId) {
  const scheduleTime = process.env.SUMMARY_TIME || '59 23 * * *';

  // สำรองข้อมูลรายวัน 00:30
  cron.schedule(process.env.BACKUP_TIME || '30 0 * * *', async () => {
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return;
    try { await runDailyBackup(authClient, spreadsheetId); }
    catch (e) { console.error('❌ Daily backup error:', e.message); }
    try { await reconcileMirror(authClient, spreadsheetId); }
    catch (e) { console.error('❌ Mirror reconcile error:', e.message); }
    try { const n = require('./persistent_queue').pruneOldJobs({ keepDays: 14, keepRecent: 150 }); if (n > 0) console.log(`🧹 ลบ job เก่า ${n} รายการ`); }
    catch (e) { console.error('❌ Job prune error:', e.message); }
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

  // รีเช็ครายวัน 23:55 — เทียบรูปที่ส่ง vs ที่บันทึก แล้วเก็บผล (โชว์ในแท็บ Log)
  const reconcileTime = process.env.RECONCILE_TIME || '55 23 * * *';
  cron.schedule(reconcileTime, () => { runDailyReconcile(bot, authClient, getSpreadsheetId).catch(e => console.error('reconcile error:', e.message)); });
  console.log(`📊 Daily reconcile scheduled at: ${reconcileTime}`);
  // เช็คครั้งแรกหลังบูต ~60 วิ (ให้ระบบตั้งตัวก่อน)
  const t = setTimeout(() => { runHealthCheck(bot, authClient, getSpreadsheetId).catch(() => {}); }, 60000);
  if (t.unref) t.unref();
}

module.exports = { setupScheduler, runHealthCheck, reconcileMirror, runDailyReconcile };
