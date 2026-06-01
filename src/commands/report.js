const { getReport, formatReport } = require('../sheets');

function checkAccess(msg) {
  const allowed = process.env.ALLOWED_CHAT_IDS;
  if (!allowed) return true;
  const ids = allowed.split(',').map(id => id.trim());
  return ids.includes(msg.chat.id.toString());
}

function setupReportCommand(bot, authClient, getSpreadsheetId) {
  bot.onText(/(?:^\/report(?:\s+(all|\d{2,6}))?(?:\s+(\d{4}-\d{2}-\d{2}))?$|📊 ดูสรุปยอดรวม)/, async (msg, match) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const spreadsheetId = getSpreadsheetId();

    if (!spreadsheetId) {
      bot.sendMessage(chatId, '⚠️ ระบบยังเชื่อมต่อ Spreadsheet ไม่เสร็จ');
      return;
    }

    let targetLast4 = null;
    let targetDate = null;
    
    if (msg.text && msg.text.startsWith('/report')) {
      if (match[1] && match[1] !== 'all') {
        targetLast4 = match[1];
      }
      if (match[2]) {
        targetDate = match[2];
      }
    }

    try {
      const processingMsg = await bot.sendMessage(chatId, '⏳ กำลังสรุปข้อมูล...');
      const report = await getReport(authClient, spreadsheetId, targetLast4, targetDate);
      const reply = formatReport(report, targetDate || 'วันนี้', targetLast4);
      await bot.editMessageText(reply, { chat_id: chatId, message_id: processingMsg.message_id });
    } catch (error) {
      console.error('Report error:', error);
      bot.sendMessage(chatId, '❌ เกิดข้อผิดพลาดในการดึงรายงาน');
    }
  });
}

module.exports = { setupReportCommand };
