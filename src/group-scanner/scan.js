// scan.js — สแกนกลุ่ม Telegram: backfill (ย้อนหลัง) + real-time แล้ว parse เป็น record
// P0: แค่ดึง+parse+พิมพ์ผล (ยังไม่เขียน Sheets) เพื่อให้เปอร์ดูว่าจับ pattern ถูกไหม
// รัน:
//   backfill เดือนนี้:  node src/group-scanner/scan.js --group "<ชื่อ/username กลุ่ม>" --since 2026-07-01
//   real-time:         node src/group-scanner/scan.js --group "<...>" --live
// ต้องมี: npm i telegram   + .env: TG_API_ID / TG_API_HASH / TG_SESSION (จาก login.js)
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { parseGroupMessage } = require('./parser');

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const session = process.env.TG_SESSION || '';

// แปลงข้อความ 1 อัน → record[] พร้อม metadata ของข้อความ (เวลา, id, ผู้ส่ง)
function toRecords(msg) {
  const text = msg.message || '';
  if (!text.trim()) return [];
  const recs = parseGroupMessage(text);
  // เก็บ date/time เป็นเวลาไทย (Asia/Bangkok, +7) ให้ตรงกับที่บอท OCR เก็บสลิป — กัน dayDiff/ขอบเดือนเพี้ยน
  const bkk = new Date((msg.date + 7 * 3600) * 1000);
  // reaction ของข้อความ (ติดทั้งข้อความ — ทุก record ในลิสต์เดียวกันได้ค่าเดียวกัน)
  // 🔥 = รูปแบบที่ต้องจับคู่กับสลิป OCR; custom emoji เก็บเป็น custom:<id>
  const rx = (msg.reactions && msg.reactions.results) ? msg.reactions.results : [];
  const reacts = rx.map(r => {
    const emo = r.reaction && r.reaction.emoticon ? r.reaction.emoticon : (r.reaction && r.reaction.documentId ? 'custom:' + r.reaction.documentId : '?');
    return emo + 'x' + (r.count || 1);
  }).join(' ');
  const fire = rx.some(r => r.reaction && r.reaction.emoticon === '🔥');
  return recs.map((r, idx) => ({
    ...r,
    msg_id: msg.id,
    rec_idx: idx,          // กันซ้ำเมื่อ 1 ข้อความมีหลาย record
    date: bkk.toISOString().slice(0, 10),
    time: bkk.toISOString().slice(11, 16),
    ts: msg.date,
    reacts, fire,
  }));
}

function printRec(r) {
  const flag = r.usable ? '✓' : '⚠️ รอตรวจ';
  console.log(`  ${flag} [${r.msg_id}.${r.rec_idx}] ${r.date} ${r.time} · ยอด ${r.amount} · ${r.last4 || '----'} · ${r.bank || r.bankRaw || '-'} · "${r.name || '-'}" · key=${r.matchKey || '-'}`);
}

// หากลุ่มจาก username/id ตรงๆ ก่อน ถ้าไม่ได้ค่อยไล่ dialog list เทียบชื่อ (title มีเว้นวรรคได้)
async function resolveGroup(client, ref) {
  try { return await client.getEntity(ref); } catch (_) {}
  const want = String(ref).trim().toLowerCase();
  const exact = [], partial = [];
  for await (const d of client.iterDialogs({ limit: 500 })) {
    const title = String(d.title || d.name || '').trim().toLowerCase();
    if (!title) continue;
    if (title === want) exact.push(d);
    else if (want.length >= 4 && title.includes(want)) partial.push(d);
  }
  if (exact.length === 1) return exact[0].entity;
  if (exact.length > 1) throw new Error(`มีหลายกลุ่มชื่อตรงกับ "${ref}" — ระบุ username/id ให้ชัด`);
  if (partial.length === 1) return partial[0].entity;
  if (partial.length > 1) throw new Error(`มีหลายกลุ่มชื่อคล้าย "${ref}" (${partial.map(d => d.title).join(', ')}) — ระบุ username/id ให้ชัด`);
  return null;
}

(async () => {
  if (!apiId || !apiHash || !session) {
    console.error('❌ ต้องมี TG_API_ID / TG_API_HASH / TG_SESSION ใน .env (รัน login.js ก่อน)');
    process.exit(1);
  }
  // --list: โชว์กลุ่ม/แชททั้งหมดที่ account อยู่ (ช่วยหา ref ที่ถูก)
  if (arg('list')) {
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    for await (const d of client.iterDialogs({ limit: 500 })) {
      if (d.isGroup || d.isChannel) console.log(`${d.id}\t${d.title || d.name || ''}`);
    }
    process.exit(0);
  }
  const groupRef = arg('group');
  if (!groupRef) { console.error('❌ ระบุกลุ่ม: --group "<ชื่อหรือ username>"'); process.exit(1); }

  const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  const entity = await resolveGroup(client, groupRef);
  if (!entity) { console.error(`❌ หากลุ่ม "${groupRef}" ไม่เจอ (ลอง --list เพื่อดูรายชื่อกลุ่มทั้งหมด)`); process.exit(1); }
  console.log(`📡 กลุ่ม: ${entity.title || groupRef} (id ${entity.id})`);

  const live = arg('live');
  const write = arg('write');
  const sinceRaw = arg('since'); // YYYY-MM-DD
  const sinceStr = (sinceRaw && sinceRaw !== true) ? String(sinceRaw) : null;
  // validate: กัน --since ไม่มีค่า/รูปแบบผิด → NaN → backfill ทั้งกลุ่มโดยไม่ตั้งใจ
  if (sinceRaw && !/^\d{4}-\d{2}-\d{2}$/.test(sinceStr || '')) {
    console.error(`❌ --since ต้องเป็น YYYY-MM-DD (ได้: ${sinceRaw})`); process.exit(1);
  }
  const sinceTs = sinceStr ? Math.floor(new Date(sinceStr + 'T00:00:00+07:00').getTime() / 1000) : 0;
  if (sinceStr && !Number.isFinite(sinceTs)) { console.error('❌ --since แปลงเป็นวันที่ไม่ได้'); process.exit(1); }

  // --write: เขียนลง Sheets (reuse auth บอท + spreadsheet เดิม)
  let auth = null, spreadsheetId = null, sg = null;
  if (write) {
    const { authorize } = require('../auth');
    auth = await authorize();
    spreadsheetId = process.env.SPREADSHEET_ID;
    if (!spreadsheetId) { console.error('❌ ไม่มี SPREADSHEET_ID ใน .env'); process.exit(1); }
    sg = require('./sheets-group');
  }

  // ── ไม่ใช่ real-time: สแกนเป็นรอบ + เขียนทับ (รองรับประกาศ แก้ไข/ลบ) ──
  const GRACE_MIN = Number(process.env.GROUP_GRACE_MIN || 10);       // ข้ามข้อความที่เพิ่งโพสต์/แก้ (ยังไม่นิ่ง)
  const SCAN_INTERVAL_MIN = Number(process.env.GROUP_SCAN_MIN || 30); // สแกนซ้ำทุกกี่นาที
  const graceSec = Math.max(0, GRACE_MIN) * 60;

  // สแกน 1 รอบ: ดึงข้อความในเดือน (ตั้งแต่ since) ที่ "นิ่งแล้ว" (อายุเกิน grace) → เขียนทับเฉพาะช่วงนั้น
  //   เขียนทับด้วยสถานะปัจจุบันของกลุ่ม → แก้ไข = ยอดใหม่ทับ, ลบ = หายจากชีต (เดือนก่อนไม่แตะ)
  async function scanCycle(reason) {
    const nowSec = Math.floor(Date.now() / 1000);
    const collected = [];
    let total = 0, used = 0, young = 0;
    for await (const msg of client.iterMessages(entity, { limit: undefined })) {
      if (sinceTs && msg.date < sinceTs) break;
      // grace: ใช้ editDate ถ้าถูกแก้ — ข้ามถ้ายังไม่เกิน grace (เผื่อยังแก้อีก)
      const finalTs = msg.editDate || msg.date;
      if (nowSec - finalTs < graceSec) { young++; continue; }
      const recs = toRecords(msg);
      if (!recs.length) continue;
      total += recs.length;
      used += recs.filter(r => r.usable).length;
      if (write) collected.push(...recs); else recs.forEach(printRec);
    }
    if (write) {
      const r = await sg.replaceGroupRecordsInRange(auth, spreadsheetId, collected, sinceStr);
      if (r.skipped) console.log(`⚠️ ${reason}: ${r.reason}`);
      else console.log(`💾 ${reason}: เขียนทับ ${r.replaced} · คงเดือนก่อน ${r.kept} · ลบ/หาย ${r.removed} · รอนิ่ง ${young} ข้อความ`);
    }
    console.log(`📊 ${reason}: ${total} record (จับคู่ได้ ${used}) ตั้งแต่ ${sinceStr || 'ทั้งหมด'} · grace ${GRACE_MIN} นาที`);
  }

  await scanCycle('สแกนรอบแรก');
  if (!live) { process.exit(0); }

  console.log(`⏰ สแกนอัตโนมัติทุก ${SCAN_INTERVAL_MIN} นาที (ไม่ใช่ real-time — ให้ประกาศแก้ไข/ลบ นิ่งก่อนค่อยจับ)`);
  setInterval(() => { scanCycle('สแกนรอบใหม่').catch(e => console.error('⚠️ สแกนล้ม:', (e && e.message) || e)); }, SCAN_INTERVAL_MIN * 60 * 1000);
})();
