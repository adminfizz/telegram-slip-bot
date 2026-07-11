// restore.js — ถอดรหัส backup แล้วคืนไฟล์กลับ
// ใช้:  node src/restore.js <ไฟล์.enc> [--apply]
//   ไม่ใส่ --apply = แสดงรายการไฟล์ที่จะคืน (dry-run ไม่เขียนจริง)
//   ใส่ --apply    = เขียนไฟล์กลับจริง (สำรองของเดิมเป็น .bak-restore ก่อน)
// ต้องตั้ง env BACKUP_PASSWORD ให้ตรงกับตอน backup
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = process.env.BACKUP_ROOT || 'C:\\ANto';
const file = process.argv[2];
const apply = process.argv.includes('--apply');

if (!file) { console.error('❌ ใช้: node src/restore.js <ไฟล์.enc> [--apply]'); process.exit(1); }
const pass = process.env.BACKUP_PASSWORD;
if (!pass) { console.error('❌ ต้องตั้ง BACKUP_PASSWORD (รหัสเดียวกับตอน backup)'); process.exit(1); }

let bundle;
try {
  const enc = fs.readFileSync(file);
  const iv = enc.subarray(0, 16);
  const data = enc.subarray(16);
  const key = crypto.scryptSync(pass, 'slipbot-backup-v1', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const gz = Buffer.concat([decipher.update(data), decipher.final()]);
  bundle = JSON.parse(zlib.gunzipSync(gz).toString());
} catch (e) {
  console.error('❌ ถอดรหัสไม่สำเร็จ (รหัสผิด หรือไฟล์เสีย):', e.message); process.exit(1);
}

const names = Object.keys(bundle);
console.log(`📦 backup มี ${names.length} ไฟล์:`);
names.forEach(n => console.log('  - ' + n + ' (' + Math.round(Buffer.from(bundle[n], 'base64').length / 1024 * 10) / 10 + ' KB)'));

if (!apply) { console.log('\n(dry-run — ยังไม่เขียนไฟล์ ใส่ --apply เพื่อคืนจริง)'); process.exit(0); }

let n = 0;
for (const rel of names) {
  const dest = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.copyFileSync(dest, dest + '.bak-restore'); // สำรองของเดิมก่อนทับ
  fs.writeFileSync(dest, Buffer.from(bundle[rel], 'base64'));
  n++;
}
console.log(`\n✅ คืนไฟล์กลับ ${n} ไฟล์ที่ ${ROOT} (ของเดิมสำรองเป็น .bak-restore)`);
process.exit(0);
