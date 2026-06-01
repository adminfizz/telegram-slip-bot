// ทดสอบการจัดหมวดประเภทรายการให้ครอบคลุมทุกคำ (ไทย/อังกฤษ/โค้ดย่อธนาคาร)
const { categorizeTxType } = require('../src/sheets');

const cases = [
  // โอน (transfer)
  ['TRANSFER', 'transfer'], ['Transfer', 'transfer'], ['Funds Transfer', 'transfer'],
  ['โอนเงิน', 'transfer'], ['โอน', 'transfer'], ['ATM-โอน', 'transfer'], ['โอนเข้า', 'transfer'],
  ['ORF T-TRF', 'transfer'], ['T-TRF', 'transfer'], ['TRF', 'transfer'], ['ORF', 'transfer'],
  ['PromptPay', 'transfer'], ['Prompt Pay', 'transfer'], ['พร้อมเพย์', 'transfer'],
  ['โอนพร้อมเพย์', 'transfer'], ['IFT', 'transfer'], ['BAHTNET', 'transfer'],
  // ถอน (withdraw)
  ['ถอนเงิน', 'withdraw'], ['ถอน', 'withdraw'], ['ถอนเงินสด', 'withdraw'], ['กดเงิน', 'withdraw'],
  ['ATM-ถอน', 'withdraw'], ['FAST CASH', 'withdraw'], ['Fast Cash', 'withdraw'],
  ['Withdrawal', 'withdraw'], ['Cash Withdrawal', 'withdraw'], ['CASH WD', 'withdraw'],
  ['Cardless Withdrawal', 'withdraw'],
  // ฝาก/รับ (deposit)
  ['ฝากเงิน', 'deposit'], ['ฝาก', 'deposit'], ['ATM-ฝาก', 'deposit'], ['Deposit', 'deposit'],
  ['Cash Deposit', 'deposit'], ['รับโอน', 'deposit'], ['รับเงิน', 'deposit'], ['เงินเข้า', 'deposit'],
  ['Received', 'deposit'], ['Money In', 'deposit'],
  // ชำระบิล (bill)
  ['ชำระบิล', 'bill'], ['ชำระเงิน', 'bill'], ['ชำระค่าบริการ', 'bill'], ['จ่ายบิล', 'bill'],
  ['Bill Payment', 'bill'], ['Payment', 'bill'], ['QR Payment', 'bill'], ['Bill Pay', 'bill'],
  // อื่นๆ (other) — คำที่ไม่เข้าหมวดใด
  ['ดอกเบี้ย', 'other'], ['ค่าธรรมเนียม', 'other'], ['Interest', 'other'], ['Fee', 'other'],
];

let pass = 0, fail = 0;
const fails = [];
for (const [input, expected] of cases) {
  const got = categorizeTxType(input);
  if (got === expected) pass++;
  else { fail++; fails.push(`  ❌ "${input}" → ${got} (ควรเป็น ${expected})`); }
}
console.log(`ผลทดสอบ: ${pass} ผ่าน / ${fail} ไม่ผ่าน (จาก ${cases.length} เคส)`);
if (fails.length) { console.log('รายการที่ผิด:'); fails.forEach(f => console.log(f)); }
else console.log('✅ ครบทุกหมวด ถูกต้องหมด');
process.exit(fail ? 1 : 0);
