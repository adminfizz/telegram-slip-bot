// จำลอง "บันทึกโมเดลบนเว็บ" → เขียนลง _config แล้วดูว่าบอทดึงไปใช้ (อ่านกลับยืนยัน)
require('dotenv').config();
const { authorize } = require('../src/auth');
const { setOcrConfig, getOcrConfig } = require('../src/sheets');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  await setOcrConfig(auth, ssid, {
    OCR_MODEL: 'gemini-2.5-flash',
    OCR_FALLBACK_1: 'typhoon-ocr',
    OCR_FALLBACK_2: 'gpt-4o',
  });
  const c = await getOcrConfig(auth, ssid);
  console.log('_config ตอนนี้:', JSON.stringify(c));
  console.log('→ รีสตาร์ทบอทแล้วดู log "[OCR config] ใช้ค่าจากเว็บ"');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
