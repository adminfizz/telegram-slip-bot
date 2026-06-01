// ทดสอบว่า parseSlipData บันทึก tx_type เป็น "ชื่อหมวด" ถูกต้อง
const { parseSlipData } = require('../src/parser');

const cases = [
  ['TRANSFER', 'โอน'], ['ORF T-TRF', 'โอน'], ['PromptPay', 'โอน'], ['โอนเงิน', 'โอน'],
  ['FAST CASH', 'ถอน'], ['Withdrawal', 'ถอน'], ['ถอนเงินสด', 'ถอน'], ['ATM-โอน', 'โอน'],
  ['Cash Deposit', 'ฝาก/รับ'], ['รับโอน', 'ฝาก/รับ'], ['เงินเข้า', 'ฝาก/รับ'],
  ['Bill Payment', 'ชำระบิล'], ['ชำระค่าน้ำ', 'ชำระบิล'], ['QR Payment', 'ชำระบิล'],
  ['WeirdUnknownType', 'WeirdUnknownType'], // ไม่รู้จัก → คงคำดิบ
];
let pass = 0, fail = 0;
for (const [raw, exp] of cases) {
  const r = parseSlipData({ account_last4: '1234', amount: 100, fee: 0, tx_type: raw, date: '2026-06-01 10:00', bank: 'SCB' });
  const got = r ? r.tx_type : '(null)';
  if (got === exp) pass++;
  else { fail++; console.log(`  ❌ "${raw}" → "${got}" (ควรเป็น "${exp}")`); }
}
console.log(`ผล: ${pass}/${cases.length} ผ่าน` + (fail ? '' : ' ✅ บันทึกเป็นหมวดถูกต้องทุกเคส'));
process.exit(fail ? 1 : 0);
