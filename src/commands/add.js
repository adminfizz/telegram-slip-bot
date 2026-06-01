const { appendSlip, getOrCreateAccountTab } = require('../sheets');
const { normalizeSlipDate } = require('../parser');

function checkAccess(msg) {
  const allowed = process.env.ALLOWED_CHAT_IDS;
  if (!allowed) return true;
  const ids = allowed.split(',').map(id => id.trim());
  return ids.includes(msg.chat.id.toString());
}

function setupAddCommand(bot, authClient, getSpreadsheetId) {
  // Format: /add [4-digit-account] [amount] [type] [memo]
  // Example: /add 4321 500 ถอนเงินสด กดเงินมาใช้
  bot.onText(/\/add\s+(\d{2,6})\s+([\d\.]+)\s+([^\s]+)(?:\s+(.*))?/, async (msg, match) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const targetLast4 = match[1];
    const amount = parseFloat(match[2]);
    const txType = match[3]; // e.g. "โอนเงิน", "ถอนเงิน", "รับเงิน"
    const memo = match[4] || '-';
    
    const spreadsheetId = getSpreadsheetId();
    if (!spreadsheetId) return bot.sendMessage(chatId, '⚠️ ยังไม่ได้ตั้งค่า Spreadsheet');

    const parsedData = {
      last4: targetLast4,
      amount: amount,
      fee: 0,
      tx_type: txType,
      counterparty: memo,
      bank: '-',
      date: normalizeSlipDate(null), // วัน-เดือน เวลา ปัจจุบัน
      slip_type: 'manual'
    };

    try {
      // สร้างแท็บถ้ายังไม่มี แล้วค่อย append (appendSlip ต้องการ last4 + data object)
      const tabName = await getOrCreateAccountTab(authClient, spreadsheetId, targetLast4, '-');
      const senderTG = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || '-');
      await appendSlip(authClient, spreadsheetId, targetLast4, {
        ...parsedData,
        senderTG,
        driveLink: '-',
        hash: '',
      });
      const amountStr = amount.toLocaleString('en-US', { minimumFractionDigits: 2 });
      const reply = [
        '✅ **บันทึกรายการ (Manual) สำเร็จ!**',
        `💰 ยอด: ${amountStr} บาท`,
        `🔄 ประเภท: ${parsedData.tx_type}`,
        `📝 โน้ต: ${parsedData.counterparty}`,
        `📅 วันที่: ${parsedData.date}`,
        `📂 แท็บ: "${tabName}"`
      ].join('\n');
      bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Manual Add Error:', err);
      bot.sendMessage(chatId, '❌ ไม่สามารถบันทึกรายการได้');
    }
  });
}

module.exports = { setupAddCommand };
