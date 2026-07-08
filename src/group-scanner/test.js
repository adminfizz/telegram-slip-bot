const { parseGroupMessage } = require('./parser');
const cases = {
  'จากรูป (ปกติ)': `บ. 111
ยูสเซอร์ :88z90999
ชื่อ : กฤษณ อาจหาญ
ธนาคาร : กสิกรไทย
เลขบัญชี : 0658242210
จำนวนเงิน : 10,000`,
  'เพี้ยน: เว้นวรรค/emoji/label ต่าง': `💰 บริษัท 202
user： aa77bet
ชื่อบัญชี   สมชาย ใจดี
แบงค์ - ไทยพาณิชย์
บัญชีเลขที่ 123-4-56789-0
ยอดโอน  5,500.50 บาท`,
  'หลายรายการใน 1 ข้อความ': `บ.111
ชื่อ : กฤษณ อาจหาญ
ธนาคาร : กสิกรไทย
เลขบัญชี : 0658242210
จำนวนเงิน : 10,000
ชื่อ : สมหญิง รักดี
ธนาคาร : กรุงเทพ
เลขบัญชี : 9988776655
จำนวนเงิน : 2,000`,
  'ธนาคารไม่รู้จัก + ไม่ครบ': `ชื่อ : ทดสอบ ระบบ
ธนาคาร : ธนาคารต่างดาว
จำนวนเงิน : 999`,
};
for (const [name, txt] of Object.entries(cases)) {
  console.log('\n=== ' + name + ' ===');
  const recs = parseGroupMessage(txt);
  console.log('records: ' + recs.length);
  recs.forEach((r,i) => console.log(`  [${i}] amount=${r.amount} last4=${r.last4} bank=${r.bank}(${r.bankRaw}) name="${r.name}" acct=${r.account} usable=${r.usable} key=${r.matchKey}`));
}
