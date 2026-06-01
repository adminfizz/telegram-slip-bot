const { deleteLastRow } = require('../sheets');

function checkAccess(msg) {
  const allowed = process.env.ALLOWED_CHAT_IDS;
  if (!allowed) return true;
  const ids = allowed.split(',').map(id => id.trim());
  return ids.includes(msg.chat.id.toString());
}

function setupUndoCommand(bot, authClient, getSpreadsheetId) {
  bot.onText(/\/undo\s+(\d{2,6})/, async (msg, match) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const targetLast4 = match[1];
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return bot.sendMessage(chatId, '⚠️ ยังไม่ได้ตั้งค่า Spreadsheet');

    const success = await deleteLastRow(authClient, spreadsheetId, targetLast4);
    if (success) {
      bot.sendMessage(chatId, `✅ ลบรายการล่าสุดของบัญชี **${targetLast4}** สำเร็จ`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `❌ ไม่พบข้อมูล หรือไม่สามารถลบรายการของบัญชี **${targetLast4}** ได้`, { parse_mode: 'Markdown' });
    }
  });
}

module.exports = { setupUndoCommand };
