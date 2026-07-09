// run-live.js — entry สำหรับ PM2: scan กลุ่ม withdraw atm แบบ real-time + เขียน Sheets
// catch-up backfill ตั้งแต่ต้นเดือนปัจจุบัน (dedup กันซ้ำ) แล้วฟังสดต่อ
const path = require('path');
const now = new Date();
const since = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
process.argv = [process.argv[0], path.join(__dirname, 'scan.js'),
  '--group', 'withdraw atm', '--since', since, '--live', '--write'];
require('./scan.js');
