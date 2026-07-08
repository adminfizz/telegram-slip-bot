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
  const when = new Date(msg.date * 1000);
  return recs.map((r, idx) => ({
    ...r,
    msg_id: msg.id,
    rec_idx: idx,          // กันซ้ำเมื่อ 1 ข้อความมีหลาย record
    date: when.toISOString().slice(0, 10),
    time: when.toISOString().slice(11, 16),
    ts: msg.date,
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
  for await (const d of client.iterDialogs({ limit: 500 })) {
    const title = String(d.title || d.name || '').trim().toLowerCase();
    if (title === want || (want.length >= 4 && title.includes(want))) return d.entity;
  }
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
  const sinceStr = arg('since'); // YYYY-MM-DD
  const sinceTs = sinceStr ? Math.floor(new Date(sinceStr + 'T00:00:00+07:00').getTime() / 1000) : 0;

  if (!live) {
    // ── backfill: ไล่ย้อนจากใหม่ไปเก่า หยุดเมื่อถึง since ──
    let total = 0, used = 0;
    for await (const msg of client.iterMessages(entity, { limit: undefined })) {
      if (sinceTs && msg.date < sinceTs) break;
      const recs = toRecords(msg);
      if (!recs.length) continue;
      total += recs.length;
      used += recs.filter(r => r.usable).length;
      recs.forEach(printRec);
    }
    console.log(`\n📊 backfill เสร็จ: ${total} record (จับคู่ได้ ${used}, รอตรวจ ${total - used}) ตั้งแต่ ${sinceStr || 'ทั้งหมด'}`);
    process.exit(0);
  } else {
    // ── real-time: ฟังข้อความใหม่ ──
    console.log('👂 real-time: รอข้อความใหม่... (Ctrl+C เพื่อหยุด)');
    client.addEventHandler((event) => {
      const msg = event.message;
      const recs = toRecords(msg);
      if (recs.length) { console.log(`\n📥 ข้อความใหม่ ${new Date().toLocaleString('th-TH')}`); recs.forEach(printRec); }
    }, new NewMessage({ chats: [entity.id] }));
  }
})();
