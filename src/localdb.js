// สำรองข้อมูลสลิปลง SQLite ในเครื่อง (ฐานข้อมูลจริง คิวรี/สำรองได้) — ใช้ node:sqlite (built-in Node 24+)
// เป็น "กระจกเงา" ของชีต: ทุกสลิปที่บอทบันทึก จะ mirror ลงที่นี่ด้วย (idempotent ตาม hash)
const path = require('path');
const fs = require('fs');

let db = null;
let disabled = false;

function getDb() {
  if (db) return db;
  if (disabled) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(path.join(dir, 'slipbot.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS slips (
      hash TEXT PRIMARY KEY,
      date TEXT, last4 TEXT, amount REAL, fee REAL,
      tx_type TEXT, counterparty TEXT, recipient_last4 TEXT,
      bank TEXT, sender_tg TEXT, drive_link TEXT, created_at TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_slips_last4 ON slips(last4)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_slips_date ON slips(date)');
    // ประวัติข้อความ Telegram ทั้งหมด (ทุกข้อความที่ส่งเข้า รวมที่ไม่ใช่สลิป/fail) — ไว้ติดตามย้อนหลัง
    db.exec(`CREATE TABLE IF NOT EXISTS tg_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT,        -- เวลาเซิร์ฟเวอร์รับ (ISO UTC)
      tg_date INTEGER,         -- เวลาส่งจริงจาก Telegram (unix วินาที)
      tg_time_th TEXT,         -- เวลาส่งจริงแบบไทย (Asia/Bangkok) อ่านง่าย
      chat_id TEXT,
      message_id INTEGER,
      from_id TEXT,
      username TEXT,
      first_name TEXT,
      msg_type TEXT,           -- photo/text/document/sticker/voice/...
      text TEXT,               -- msg.text หรือ caption
      file_id TEXT,            -- สำหรับ photo/document/ฯลฯ
      status TEXT,             -- received/slip_success/slip_fail/slip_duplicate/ignored
      slip_hash TEXT,          -- ผูกกับสลิปถ้ากลายเป็นสลิป
      note TEXT,               -- เหตุผล/ข้อความ error
      raw TEXT,                -- JSON ย่อของ msg เผื่อดูละเอียด
      image_path TEXT          -- path ไฟล์รูปที่เซฟถาวรลงเครื่อง (data/tg_images/)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tg_chat ON tg_messages(chat_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tg_msgid ON tg_messages(message_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tg_date ON tg_messages(tg_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tg_from ON tg_messages(from_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tg_status ON tg_messages(status)');
    // migration: เพิ่มคอลัมน์ image_path ให้ตารางเดิมที่สร้างไว้ก่อนมีฟีเจอร์นี้ (no-op ถ้ามีแล้ว)
    try { db.exec('ALTER TABLE tg_messages ADD COLUMN image_path TEXT'); } catch (_) { /* มีอยู่แล้ว */ }
    return db;
  } catch (e) {
    console.error('localdb: เปิด SQLite ไม่ได้ (ปิดการ mirror):', e.message);
    disabled = true;
    return null;
  }
}

// บันทึก/อัปเดตสลิป 1 รายการ (idempotent ตาม hash) — ถ้า hash ซ้ำจะอัปเดตค่าให้ล่าสุด
function mirrorSlip(d) {
  const conn = getDb();
  if (!conn || !d || !d.hash) return;
  try {
    conn.prepare(`INSERT INTO slips (hash,date,last4,amount,fee,tx_type,counterparty,recipient_last4,bank,sender_tg,drive_link,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(hash) DO UPDATE SET date=excluded.date,last4=excluded.last4,amount=excluded.amount,fee=excluded.fee,
        tx_type=excluded.tx_type,counterparty=excluded.counterparty,recipient_last4=excluded.recipient_last4,bank=excluded.bank,drive_link=excluded.drive_link`)
      .run(String(d.hash), String(d.date || ''), String(d.last4 || ''), Number(d.amount) || 0, Number(d.fee) || 0,
        String(d.tx_type || ''), String(d.counterparty || ''), String(d.recipient_last4 || ''), String(d.bank || ''),
        String(d.senderTG || ''), String(d.driveLink || ''), new Date().toISOString());
  } catch (e) { console.error('localdb mirror failed:', e.message); }
}

// บันทึกหลายรายการรวดเดียว (ใช้ backfill/reconcile จากชีต) — คืนจำนวนที่เขียน
function mirrorMany(rows) {
  const conn = getDb();
  if (!conn || !Array.isArray(rows)) return 0;
  let n = 0;
  try {
    conn.exec('BEGIN');
    for (const d of rows) { if (d && d.hash) { mirrorSlip(d); n++; } }
    conn.exec('COMMIT');
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch (_) {}
    console.error('localdb mirrorMany failed:', e.message);
  }
  return n;
}

function clearLocalDb() {
  const conn = getDb();
  if (!conn) return;
  try { conn.exec('DELETE FROM slips'); } catch (e) { console.error('localdb clear failed:', e.message); }
}

function localDbStats() {
  const conn = getDb();
  if (!conn) return { available: false, count: 0, total: 0 };
  try {
    const r = conn.prepare('SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM slips').get();
    return { available: true, count: Number(r.c) || 0, total: Number(r.s) || 0 };
  } catch (e) { return { available: false, count: 0, total: 0 }; }
}

// ── ประวัติข้อความ Telegram ──────────────────────────────────────────────
// บันทึก 1 ข้อความที่ส่งเข้ามา (เรียกจาก catch-all bot.on('message')) — ห้าม throw เด็ดขาด กัน bot ล่ม
function logTgMessage(m) {
  const conn = getDb();
  if (!conn || !m) return;
  try {
    const tgDate = Number(m.tgDate) || 0;
    let tgTimeTh = '';
    if (tgDate > 0) {
      try { tgTimeTh = new Date(tgDate * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }); } catch (_) {}
    }
    conn.prepare(`INSERT INTO tg_messages
      (received_at,tg_date,tg_time_th,chat_id,message_id,from_id,username,first_name,msg_type,text,file_id,status,slip_hash,note,raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(new Date().toISOString(), tgDate, tgTimeTh,
        String(m.chatId != null ? m.chatId : ''), Number(m.messageId) || 0, String(m.fromId != null ? m.fromId : ''),
        String(m.username || ''), String(m.firstName || ''), String(m.type || ''),
        String(m.text || ''), String(m.fileId || ''), String(m.status || 'received'),
        String(m.slipHash || ''), String(m.note || ''), m.raw ? String(m.raw) : '');
  } catch (e) { console.error('localdb logTgMessage failed:', e.message); }
}

// อัปเดตสถานะของข้อความ (ผูกผลสลิปกลับเข้า row เดิม) — เลือก row ล่าสุดที่ตรง chat+message
function updateTgMessageStatus(chatId, messageId, patch = {}) {
  const conn = getDb();
  if (!conn) return;
  try {
    const sets = [], vals = [];
    if (patch.status !== undefined) { sets.push('status=?'); vals.push(String(patch.status)); }
    if (patch.slipHash !== undefined) { sets.push('slip_hash=?'); vals.push(String(patch.slipHash)); }
    if (patch.note !== undefined) { sets.push('note=?'); vals.push(String(patch.note)); }
    if (patch.imagePath !== undefined) { sets.push('image_path=?'); vals.push(String(patch.imagePath)); }
    if (!sets.length) return;
    const cid = String(chatId != null ? chatId : ''), mid = Number(messageId) || 0;
    conn.prepare(`UPDATE tg_messages SET ${sets.join(',')}
      WHERE id = (SELECT id FROM tg_messages WHERE chat_id=? AND message_id=? ORDER BY id DESC LIMIT 1)`)
      .run(...vals, cid, mid);
  } catch (e) { console.error('localdb updateTgMessageStatus failed:', e.message); }
}

// ดึงประวัติย้อนหลัง (ใหม่สุดก่อน) — กรองตาม chat/from/status/type/since ได้
function queryTgMessages(opts = {}) {
  const conn = getDb();
  if (!conn) return [];
  try {
    const where = [], vals = [];
    if (opts.chatId)  { where.push('chat_id=?');  vals.push(String(opts.chatId)); }
    if (opts.fromId)  { where.push('from_id=?');  vals.push(String(opts.fromId)); }
    if (opts.status)  { where.push('status=?');   vals.push(String(opts.status)); }
    if (opts.msgType) { where.push('msg_type=?'); vals.push(String(opts.msgType)); }
    if (opts.since)   { where.push('tg_date>=?'); vals.push(Number(opts.since) || 0); }
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 1000);
    const sql = `SELECT * FROM tg_messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return conn.prepare(sql).all(...vals, limit);
  } catch (e) { console.error('localdb queryTgMessages failed:', e.message); return []; }
}

function tgMessageStats() {
  const conn = getDb();
  if (!conn) return { available: false, count: 0 };
  try {
    const r = conn.prepare('SELECT COUNT(*) c FROM tg_messages').get();
    return { available: true, count: Number(r.c) || 0 };
  } catch (e) { return { available: false, count: 0 }; }
}

// ดึง 1 ข้อความตาม id (ใช้กับ /img และ /api/tg-image)
function getTgMessageById(id) {
  const conn = getDb();
  if (!conn) return null;
  try {
    return conn.prepare('SELECT * FROM tg_messages WHERE id=?').get(Number(id) || 0) || null;
  } catch (e) { console.error('localdb getTgMessageById failed:', e.message); return null; }
}

module.exports = {
  mirrorSlip, mirrorMany, clearLocalDb, localDbStats, getDb,
  logTgMessage, updateTgMessageStatus, queryTgMessages, tgMessageStats, getTgMessageById,
};
