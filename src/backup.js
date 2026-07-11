// backup.js — สำรอง config/data สำคัญ → เข้ารหัส AES → ส่งเข้า Telegram
// ครอบ: .env, credentials.json, tokens/*, data/*.json + slipbot.db  (ไม่รวมรูปสลิป — อยู่ Drive แล้ว)
// รันครั้งเดียวแล้วจบ (ใช้กับ PM2 cron):  node src/backup.js
// ต้องตั้ง env: BACKUP_PASSWORD (รหัสถอด — ลืมแล้ว restore ไม่ได้!), TELEGRAM_BOT_TOKEN, BACKUP_CHAT_ID (หรือ SUMMARY_CHAT_ID)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = process.env.BACKUP_ROOT || 'C:\\ANto';
const SINGLE = ['.env', 'credentials.json'];
const DIRS = ['tokens'];
const DATA = ['data/slip_jobs.json', 'data/ai_usage.json', 'data/slipbot.db'];

(async () => {
  const pass = process.env.BACKUP_PASSWORD;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.BACKUP_CHAT_ID || process.env.SUMMARY_CHAT_ID;
  if (!pass) { console.error('❌ ต้องตั้ง BACKUP_PASSWORD ใน .env (รหัสถอดรหัส backup)'); process.exit(1); }
  if (!token || !chat) { console.error('❌ ต้องมี TELEGRAM_BOT_TOKEN + BACKUP_CHAT_ID/SUMMARY_CHAT_ID'); process.exit(1); }

  // 1) รวมไฟล์เป็น bundle { relPath: base64 }
  const bundle = {};
  const add = (rel) => { const p = path.join(ROOT, rel); if (fs.existsSync(p) && fs.statSync(p).isFile()) bundle[rel.replace(/\\/g, '/')] = fs.readFileSync(p).toString('base64'); };
  SINGLE.forEach(add);
  DIRS.forEach(d => { const dp = path.join(ROOT, d); if (fs.existsSync(dp)) fs.readdirSync(dp).forEach(f => add(path.join(d, f))); });
  DATA.forEach(add);
  const names = Object.keys(bundle);
  if (!names.length) { console.error('❌ ไม่พบไฟล์สำรองเลย (เช็ค BACKUP_ROOT)'); process.exit(1); }

  // 2) gzip + เข้ารหัส AES-256-CBC (iv นำหน้า)
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)));
  const key = crypto.scryptSync(pass, 'slipbot-backup-v1', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([iv, cipher.update(gz), cipher.final()]);

  // 3) ส่งเข้า Telegram (sendDocument)
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('caption', `🔐 Backup slipbot ${stamp}\n${names.length} ไฟล์ · ${(enc.length / 1024).toFixed(0)} KB · เข้ารหัส AES\nถอดด้วย: node src/restore.js <ไฟล์>`);
  fd.append('document', new Blob([enc]), `slipbot-backup-${stamp}.enc`);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { console.error('❌ ส่ง Telegram ไม่สำเร็จ:', j.description || r.status); process.exit(1); }
  console.log(`✅ Backup สำเร็จ: ${names.length} ไฟล์ (${(enc.length / 1024).toFixed(0)} KB) ส่งเข้า Telegram แล้ว`);
  process.exit(0);
})().catch(e => { console.error('❌ backup ล้ม:', e.message); process.exit(1); });
