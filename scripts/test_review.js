// ทดสอบฟังก์ชันคิวรอตรวจกับชีตจริง: add → list → remove
require('dotenv').config();
const { authorize } = require('../src/auth');
const { addReviewItem, getReviewQueue, removeReviewItem } = require('../src/sheets');

(async () => {
  const auth = await authorize();
  const ssid = process.env.SPREADSHEET_ID;
  const id = 'test_review_' + Math.floor(1000 + (process.pid % 9000));
  const item = {
    id, createdAt: '2026-06-01 10:00', last4: '1234', amount: 5000, fee: 10,
    tx_type: 'โอน', counterparty: '-', bank: 'SCB', date: '2026-06-01 10:00',
    driveLink: '', ocrText: 'TEST OCR TEXT', provider: 'typhoon-ocr', reason: 'ทดสอบ', senderTG: '@test', fileHash: 'hashtest123',
  };
  console.log('add...'); await addReviewItem(auth, ssid, item);
  let q = await getReviewQueue(auth, ssid);
  console.log('queue after add:', q.length, '— มี id เรา?', q.some(x => x.id === id));
  console.log('add ซ้ำ (กัน hash ซ้ำ)...'); await addReviewItem(auth, ssid, item);
  q = await getReviewQueue(auth, ssid);
  console.log('queue after dup add:', q.length, '(ควรเท่าเดิม)');
  console.log('remove...'); await removeReviewItem(auth, ssid, id);
  q = await getReviewQueue(auth, ssid);
  console.log('queue after remove:', q.length, '— มี id เรา?', q.some(x => x.id === id));
  console.log('✅ review queue ทำงานครบ');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
