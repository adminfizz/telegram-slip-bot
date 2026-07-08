const { parseGroupMessage } = require('./parser');
const cases = {
  'report ยอดคงเหลือ (ต้องได้ 0)': `1. ชื่อ สุดารัตน์ 
เลขบัญชี : 2318957730
ธ. กสิกรไทย
มีเงิน 3,275 / วงเงิน 50,000

2. ชื่อ พิสุทธิ
เลขบัญชี : 2321308018
ธ. กสิกรไทย
มีเงิน 1,670 / วงเงิน 50,000`,
  'แจ้งเบิก ไทยพาณิช (สะกดสั้น) → SCB': `แจ้งเบิก
ชื่อ : สุดารัตน์
ธนาคาร : ไทยพาณิช
เลขบัญชี : 4170553898 
จำนวนเงิน : 50,000`,
  'ปกติ ธ.กสิกรไทย → KBANK': `บ. 111
ยูสเซอร์ :88z90999
ชื่อ : กฤษณ อาจหาญ
ธนาคาร : ธ.กสิกรไทย
เลขบัญชี : 0658242210
จำนวนเงิน : 20,920`,
  'ไทยพานิชย์ (สะกด น) → SCB': `ชื่อ จรัญ
ธนาคาร : ไทยพานิชย์
เลขบัญชี : 4380362477
จำนวนเงิน : 5,000`,
};
for (const [name, txt] of Object.entries(cases)) {
  const recs = parseGroupMessage(txt);
  console.log(`\n=== ${name} === (${recs.length} rec)`);
  recs.forEach((r,i)=>console.log(`  [${i}] usable=${r.usable} amount=${r.amount} last4=${r.last4} bank=${r.bank}(${r.bankRaw}) key=${r.matchKey}`));
}
