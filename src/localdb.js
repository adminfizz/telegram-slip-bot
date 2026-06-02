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

module.exports = { mirrorSlip, mirrorMany, clearLocalDb, localDbStats, getDb };
