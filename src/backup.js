// backup.js — สำรอง config/data สำคัญ → เข้ารหัส AES → อัปโหลด Google Drive (+Telegram เสริม)
// โครงสร้าง Drive:  TelegramSlipBot-Backup / <MM/YY พ.ศ. เช่น 07/69> / <DD/MM/YY เช่น 10/07/69> /
//   ├─ slipbot-backup_<วันเวลา>.enc   (ไฟล์เข้ารหัส — private ไม่แชร์ลิงก์)
//   └─ รายละเอียด_<วันเวลา>.txt       (manifest: มีไฟล์อะไร ขนาด checksum วิธี restore)
// ครอบ: .env, credentials.json, tokens/*, data/*.json + slipbot.db  (ไม่รวมรูปสลิป — อยู่ Drive อยู่แล้ว)
// รันครั้งเดียวแล้วจบ (ใช้กับ PM2 cron):  node src/backup.js
// env: BACKUP_PASSWORD (จำเป็น — ลืมแล้ว restore ไม่ได้!), BACKUP_CHAT_ID/SUMMARY_CHAT_ID (เสริม ส่ง Telegram ด้วย)
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');

const ROOT = process.env.BACKUP_ROOT || 'C:\\ANto';
const SINGLE = ['.env', 'credentials.json', 'ai_usage.json'];
const DIRS = ['tokens'];
const DATA = ['data/slip_jobs.json', 'data/slipbot.db'];
const DRIVE_BACKUP_ROOT = 'TelegramSlipBot-Backup';

// เวลาไทย (Asia/Bangkok) — วัน/เดือน/ปี พ.ศ. ย่อ + เวลา
function bkkNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {}; parts.forEach(x => p[x.type] = x.value);
  const beShort = String((Number(p.year) + 543) % 100).padStart(2, '0'); // 2026 → 69
  return { d: p.day, m: p.month, yBE: beShort, hm: `${p.hour}${p.minute}`, iso: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` };
}

(async () => {
  const pass = process.env.BACKUP_PASSWORD;
  if (!pass) { console.error('❌ ต้องตั้ง BACKUP_PASSWORD ใน .env (รหัสถอดรหัส backup — เก็บไว้นอกเครื่องด้วย!)'); process.exit(1); }

  // 1) รวมไฟล์เป็น bundle { relPath: base64 } + เก็บรายละเอียดต่อไฟล์
  const bundle = {}; const detail = [];
  const add = (rel) => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return;
    const buf = fs.readFileSync(p);
    bundle[rel.replace(/\\/g, '/')] = buf.toString('base64');
    detail.push({ file: rel.replace(/\\/g, '/'), kb: Math.round(buf.length / 1024 * 10) / 10, mtime: fs.statSync(p).mtime.toISOString().slice(0, 16).replace('T', ' ') });
  };
  SINGLE.forEach(add);
  DIRS.forEach(d => { const dp = path.join(ROOT, d); if (fs.existsSync(dp)) fs.readdirSync(dp).forEach(f => add(path.join(d, f))); });
  DATA.forEach(add);
  if (!detail.length) { console.error('❌ ไม่พบไฟล์สำรองเลย (เช็ค BACKUP_ROOT)'); process.exit(1); }

  // 2) gzip + เข้ารหัส AES-256-CBC (iv นำหน้า)
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)));
  const key = crypto.scryptSync(pass, 'slipbot-backup-v1', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([iv, cipher.update(gz), cipher.final()]);
  const sha = crypto.createHash('sha256').update(enc).digest('hex');

  const t = bkkNow();
  const encName = `slipbot-backup_${t.d}-${t.m}-${t.yBE}_${t.hm}.enc`;

  // 3) manifest รายละเอียด (อ่านได้เลย ไม่เข้ารหัส — ไม่มี secret ข้างใน)
  const manifest = [
    `📦 SlipBot Backup — ${t.iso} (เวลาไทย)`,
    `เครื่อง: ${os.hostname()} · โฟลเดอร์: ${ROOT}`,
    `ไฟล์เข้ารหัส: ${encName} (${(enc.length / 1024).toFixed(0)} KB)`,
    `SHA-256: ${sha}`,
    '',
    `ไฟล์ข้างใน (${detail.length}):`,
    ...detail.map(x => `  - ${x.file}  ${x.kb} KB  (แก้ล่าสุด ${x.mtime})`),
    '',
    'วิธี restore (บนเครื่องใหม่):',
    '  1. clone https://github.com/adminfizz/telegram-slip-bot → npm install',
    '  2. ดาวน์โหลดไฟล์ .enc นี้ไปวางในโฟลเดอร์โปรเจค',
    '  3. ตั้ง BACKUP_PASSWORD (รหัสเดียวกับตอนสำรอง) แล้วรัน:',
    '     node src/restore.js <ไฟล์.enc>          ← ดูรายการก่อน (dry-run)',
    '     node src/restore.js <ไฟล์.enc> --apply  ← คืนไฟล์จริง',
    '  4. pm2 start (slip-bot + group-scanner) → pm2 save',
  ].join('\n');
  const manifestName = `รายละเอียด_${t.d}-${t.m}-${t.yBE}_${t.hm}.txt`;

  // 4) อัปโหลด Drive: TelegramSlipBot-Backup / MM/YY / DD/MM/YY / (ไฟล์ private — ไม่ตั้ง permission anyone)
  const { authorize } = require('./auth');
  const { getOrCreateFolder } = require('./drive');
  const { google } = require('googleapis');
  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });
  const rootId = await getOrCreateFolder(drive, DRIVE_BACKUP_ROOT);
  const monthId = await getOrCreateFolder(drive, `${t.m}/${t.yBE}`, rootId);
  const dayId = await getOrCreateFolder(drive, `${t.d}/${t.m}/${t.yBE}`, monthId);
  const up = async (name, buf, mime) => (await drive.files.create({
    resource: { name, parents: [dayId] },
    media: { mimeType: mime, body: Readable.from(buf) },
    fields: 'id',
  })).data.id;
  await up(encName, enc, 'application/octet-stream');
  await up(manifestName, Buffer.from(manifest), 'text/plain');
  console.log(`✅ Drive: ${DRIVE_BACKUP_ROOT}/${t.m}⁄${t.yBE}/${t.d}⁄${t.m}⁄${t.yBE}/ → ${encName} + manifest (${detail.length} ไฟล์, ${(enc.length / 1024).toFixed(0)} KB)`);

  // 5) เสริม: ส่งเข้า Telegram ด้วย (ถ้าตั้ง chat ไว้) — สำรอง 2 ที่
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.BACKUP_CHAT_ID || process.env.SUMMARY_CHAT_ID;
  if (token && chat) {
    try {
      const fd = new FormData();
      fd.append('chat_id', String(chat));
      fd.append('caption', `🔐 Backup ${t.iso}\n${detail.length} ไฟล์ · ${(enc.length / 1024).toFixed(0)} KB · SHA ${sha.slice(0, 12)}…\nDrive: ${DRIVE_BACKUP_ROOT}/${t.m}⁄${t.yBE}/${t.d}⁄${t.m}⁄${t.yBE}`);
      fd.append('document', new Blob([enc]), encName);
      const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      console.log(j.ok ? '✅ Telegram: ส่งสำเนาสำรองแล้ว' : `⚠️ Telegram ไม่สำเร็จ: ${j.description || r.status} (Drive สำเร็จแล้ว ไม่กระทบ)`);
    } catch (e) { console.log(`⚠️ Telegram ไม่สำเร็จ: ${e.message} (Drive สำเร็จแล้ว)`); }
  }
  process.exit(0);
})().catch(e => { console.error('❌ backup ล้ม:', e.message); process.exit(1); });
