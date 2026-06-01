const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { google } = require('googleapis');
const { clearTodayData, clearAllTodayData, wipeTabData, wipeAllTabsData, getTodayStr,
  setTokenUsage, setJobsSnapshot, setReviewQueue, buildWipeSummaryText } = require('../sheets');
const { deleteDriveFilesForAccount, deleteAllDriveFiles } = require('../drive_admin');

function checkAccess(msg) {
  const allowed = process.env.ALLOWED_CHAT_IDS;
  if (!allowed) return true;
  const ids = allowed.split(',').map(id => id.trim());
  return ids.includes(msg.chat.id.toString());
}

// ─── Build Excel from sheet data ─────────────────────────────────────────────
async function buildExcelFromSheets(auth, spreadsheetId, tabNames) {
  const sheets = google.sheets({ version: 'v4', auth });
  const wb = XLSX.utils.book_new();

  for (const tabName of tabNames) {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A:I`,
      });
      const rows = res.data.values || [];
      if (rows.length === 0) continue;

      const ws = XLSX.utils.aoa_to_sheet(rows);

      // Style header row width (A=วันที่ B=ยอด C=ค่าธรรมเนียม D=ประเภท E=ผู้โอน/ผู้รับ F=ธนาคาร G=ผู้ส่ง H=ลิงก์ I=Hash)
      ws['!cols'] = [
        { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 20 },
        { wch: 10 }, { wch: 14 }, { wch: 40 }, { wch: 36 },
      ];

      XLSX.utils.book_append_sheet(wb, ws, tabName.replace('บัญชี_', 'Acc_'));
    } catch (_) {}
  }

  return wb;
}

// ─── Send Excel file via Telegram ─────────────────────────────────────────────
async function sendExcel(bot, chatId, wb, filename, caption) {
  const tmpDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); // กันโฟลเดอร์หาย → ENOENT
  const tmpPath = path.join(tmpDir, filename);
  XLSX.writeFile(wb, tmpPath);
  try {
    // ระบุ contentType เพื่อปิด DeprecationWarning ของ node-telegram-bot-api
    await bot.sendDocument(chatId, tmpPath, { caption }, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ─── Build summary text ───────────────────────────────────────────────────────
function buildSummaryText(results, mode, target) {
  const today = getTodayStr();
  const label = mode === 'today' ? `วันที่ ${today}` : 'ทั้งหมด (ทุกวัน)';
  const who   = target === 'all' ? 'ทุกบัญชี' : `บัญชี ****${target}`;

  let text = `🗑️ *ล้างข้อมูล ${label} — ${who}*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (results.length === 0) {
    text += `📭 ไม่มีข้อมูลให้ลบ\n`;
  } else {
    for (const r of results) {
      text += `💳 บัญชี ****${r.last4}: ลบ ${r.count} รายการ\n`;
    }
    const total = results.reduce((s, r) => s + r.count, 0);
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📊 รวม: ${total} รายการ\n`;
  }

  text += `\n📎 ข้อมูลสำรองแนบมาด้านบนแล้วครับ`;
  return text;
}

// ─── Setup all clear/wipe commands ───────────────────────────────────────────
function setupClearCommand(bot, authClient, getSpreadsheetId) {

  // /clear 4321  — ล้างวันนี้ เฉพาะบัญชี
  bot.onText(/^\/clear\s+(\d{2,6})$/, async (msg, match) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const last4  = match[1];
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return bot.sendMessage(chatId, '⚠️ ยังไม่ได้ตั้งค่า Spreadsheet');

    const procMsg = await bot.sendMessage(chatId, `⏳ กำลังสำรองข้อมูลบัญชี ${last4} แล้วล้าง...`);
    try {
      // Build Excel BEFORE clearing
      const wb = await buildExcelFromSheets(authClient, spreadsheetId, [`บัญชี_${last4}`]);
      const today = getTodayStr();
      const count = await clearTodayData(authClient, spreadsheetId, last4);

      await bot.deleteMessage(chatId, procMsg.message_id);
      if (XLSX.utils.sheet_to_json(wb.Sheets[Object.keys(wb.Sheets)[0]] || {}).length > 0) {
        await sendExcel(bot, chatId, wb, `backup_${last4}_${today}.xlsx`,
          `📎 สำรองข้อมูลบัญชี ${last4} ก่อนล้าง`);
      }

      const results = count > 0 ? [{ last4, count }] : [];
      await bot.sendMessage(chatId, buildSummaryText(results, 'today', last4), { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.editMessageText(`❌ เกิดข้อผิดพลาด: ${e.message}`, { chat_id: chatId, message_id: procMsg.message_id });
    }
  });

  // /clear all, /clear_all, or button click
  bot.onText(/^(\/clear\s+all|\/clear_all|🗑️ ล้างยอดวันนี้)$/i, async (msg) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return bot.sendMessage(chatId, '⚠️ ยังไม่ได้ตั้งค่า Spreadsheet');

    const procMsg = await bot.sendMessage(chatId, '⏳ กำลังสำรองข้อมูลทุกบัญชีแล้วล้าง...');
    try {
      const { google } = require('googleapis');
      const sheetsApi = google.sheets({ version: 'v4', auth: authClient });
      const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
      const tabNames = meta.data.sheets.map(s => s.properties.title).filter(t => t.startsWith('บัญชี_'));

      // สำรองข้อมูลก่อนล้าง (best-effort — ถ้าพลาดก็ยังล้างต่อ)
      let wb = null;
      try { wb = await buildExcelFromSheets(authClient, spreadsheetId, tabNames); }
      catch (be) { console.error('clear_all backup build failed:', be.message); }

      const { results } = await clearAllTodayData(authClient, spreadsheetId);
      const today = getTodayStr();

      try { await bot.deleteMessage(chatId, procMsg.message_id); } catch (_) {}
      if (wb && wb.SheetNames && wb.SheetNames.length > 0) {
        try {
          await sendExcel(bot, chatId, wb, `backup_all_${today}.xlsx`, `📎 สำรองข้อมูลทุกบัญชี ก่อนล้างวันที่ ${today}`);
        } catch (se) { console.error('clear_all send backup failed:', se.message); }
      }
      await bot.sendMessage(chatId, buildSummaryText(results, 'today', 'all'), { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('clear_all error:', e);
      try { await bot.sendMessage(chatId, `❌ เกิดข้อผิดพลาด: ${e.message}`); } catch (_) {}
    }
  });

  // /wipe 4321  — ล้างข้อมูลทั้งหมด (ทุกวัน) + Drive เฉพาะบัญชี
  bot.onText(/^\/wipe\s+(\d{2,6})$/, async (msg, match) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const last4  = match[1];
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return bot.sendMessage(chatId, '⚠️ ยังไม่ได้ตั้งค่า Spreadsheet');

    const procMsg = await bot.sendMessage(chatId, `⏳ กำลังสำรองและล้างข้อมูลทั้งหมดของบัญชี ${last4}...`);
    try {
      const wb = await buildExcelFromSheets(authClient, spreadsheetId, [`บัญชี_${last4}`]);
      const count = await wipeTabData(authClient, spreadsheetId, last4);
      const driveCount = await deleteDriveFilesForAccount(authClient, last4);
      const today = getTodayStr();

      await bot.deleteMessage(chatId, procMsg.message_id);
      if (wb.SheetNames.length > 0) {
        await sendExcel(bot, chatId, wb, `wipe_backup_${last4}_${today}.xlsx`,
          `📎 สำรองข้อมูลทั้งหมดของบัญชี ${last4} ก่อนล้าง`);
      }

      const results = count > 0 ? [{ last4, count }] : [];
      let text = buildSummaryText(results, 'all', last4);
      if (driveCount > 0) text += `\n🗂️ ลบรูปใน Drive: ${driveCount} ไฟล์`;
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.editMessageText(`❌ เกิดข้อผิดพลาด: ${e.message}`, { chat_id: chatId, message_id: procMsg.message_id });
    }
  });

  // /wipe all, /wipe_all, or button click
  bot.onText(/^(\/wipe\s+all|\/wipe_all|🔥 ล้างเกลี้ยงทั้งหมด)$/i, async (msg) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return bot.sendMessage(chatId, '⚠️ ยังไม่ได้ตั้งค่า Spreadsheet');

    const procMsg = await bot.sendMessage(chatId, '⚠️ กำลังสำรองและล้างข้อมูลทั้งหมดทุกบัญชี...');
    try {
      const { google } = require('googleapis');
      const sheetsApi = google.sheets({ version: 'v4', auth: authClient });
      const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
      const tabNames = meta.data.sheets.map(s => s.properties.title).filter(t => t.startsWith('บัญชี_'));

      // สำรองข้อมูลก่อนล้าง (best-effort — ถ้าพลาดก็ยังล้างต่อ)
      let wb = null;
      try { wb = await buildExcelFromSheets(authClient, spreadsheetId, tabNames); }
      catch (be) { console.error('wipe_all backup build failed:', be.message); }

      const wipeResult = await wipeAllTabsData(authClient, spreadsheetId);
      const results = wipeResult.results || [];
      const totalRows = wipeResult.totalDeleted != null
        ? wipeResult.totalDeleted
        : results.reduce((s, r) => s + (r.count || 0), 0);
      let driveCount = 0;
      try { driveCount = await deleteAllDriveFiles(authClient); }
      catch (de) { console.error('wipe_all drive delete failed:', de.message); }
      const today = getTodayStr();

      // ล้างให้ครบเหมือนปุ่มบนเว็บ: ตัวนับ token/รูป + หน้าคิว + คิวรอตรวจ + งานในเครื่อง
      try { await setTokenUsage(authClient, spreadsheetId, 0, 0); } catch (e) { console.error('wipe_all reset usage:', e.message); }
      try { await setJobsSnapshot(authClient, spreadsheetId, { jobs: [], stats: {}, fetchedAt: new Date().toISOString() }); } catch (e) { console.error('wipe_all clear jobs:', e.message); }
      try { await setReviewQueue(authClient, spreadsheetId, []); } catch (e) { console.error('wipe_all clear review:', e.message); }
      try { require('../persistent_queue').clearAll(); } catch (e) { console.error('wipe_all clearAll local:', e.message); }
      try {
        const fs = require('fs'); const path = require('path');
        fs.writeFileSync(path.join(process.cwd(), 'ai_usage.json'), JSON.stringify({ totalTokens: 0, count: 0 }, null, 2), 'utf-8');
      } catch (e) { console.error('wipe_all reset ai_usage:', e.message); }

      try { await bot.deleteMessage(chatId, procMsg.message_id); } catch (_) {}
      if (wb && wb.SheetNames && wb.SheetNames.length > 0) {
        try {
          await sendExcel(bot, chatId, wb, `wipe_all_backup_${today}.xlsx`, `📎 สำรองข้อมูลทั้งหมดทุกบัญชี ก่อนล้าง`);
        } catch (se) { console.error('wipe_all send backup failed:', se.message); }
      }

      // ข้อความเดียวกับการล้างผ่านเว็บ
      await bot.sendMessage(chatId, buildWipeSummaryText({ rows: totalRows, driveCount }));
    } catch (e) {
      console.error('wipe_all error:', e);
      try { await bot.sendMessage(chatId, `❌ เกิดข้อผิดพลาด: ${e.message}`); } catch (_) {}
    }
  });
}

module.exports = { setupClearCommand };
