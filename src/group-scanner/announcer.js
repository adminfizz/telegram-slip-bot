// announcer.js — ส่งข้อความแจ้งเตือนลงกลุ่มตามรอบวันที่ (เวลาไทย) + แท็คแอดมิน + pin แบบแจ้งเตือน
// รอบส่ง: ก่อนวันที่ 1 สามวัน (สิ้นเดือน-2) / ก่อนวันที่ 1 หนึ่งวัน (สิ้นเดือน) / วันที่ 1 / 7 / 9 / 10
// กติกา pin: ทุกชุดใหม่จะลบ pin ของชุดก่อนแล้ว pin ตัวเอง · วันหลัก (1, 10) pin ค้าง 24 ชม. แล้วลบอัตโนมัติ
//            เคาท์ดาวน์ (สิ้นเดือน-2/สิ้นเดือน/7/9) pin ค้างไว้จนชุดถัดไปมาแทน
// ข้อความ+รายชื่อแท็คตั้งใน announce.json (root repo) — แก้ไฟล์ได้เลย ไม่ต้อง restart (อ่านใหม่ทุกรอบเช็ค)
// slot ที่ข้อความว่าง = ยังไม่ส่ง (รอเปอร์ใส่ข้อความ) — เติมระหว่างวันแล้วส่งให้ในรอบเช็คถัดไป
//
// ใช้ใน process สแกนเดิม (scan.js --live เรียก start(client, entity)) — client เดียว ไม่เปิด session ซ้อน
// ทดสอบเดี่ยว:  node src/group-scanner/announcer.js --dry            (คำนวณ slot วันนี้ + ข้อความที่จะส่ง ไม่ส่งจริง)
//              node src/group-scanner/announcer.js --resolve        (เช็คว่าแท็คหาตัวคนในกลุ่มเจอไหม)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'announce.json');
const STATE_PATH = path.join(ROOT, '.announce-state.json');
const CHECK_MS = 30 * 1000; // เช็คทุก 30 วิ — ส่งจริงเมื่อถึงเวลา + ยังไม่เคยส่งของวัน:slot นั้น

// เวลาไทย (Asia/Bangkok = UTC+7 คงที่ ไม่มี DST) — ใช้ UTC getter บนเวลาที่เลื่อน +7 ชม. (แบบเดียวกับ scan.js)
function bkkNow() { return new Date(Date.now() + 7 * 3600 * 1000); }
function daysInMonth(y, m1to12) { return new Date(Date.UTC(y, m1to12, 0)).getUTCDate(); }

// วันนี้ตรง slot ไหน (หรือ null) — สิ้นเดือน-2/สิ้นเดือน ไม่มีทางชนกับ 1/7/9/10 (สิ้นเดือน ≥ 28)
function slotForDate(bkk) {
  const d = bkk.getUTCDate();
  const last = daysInMonth(bkk.getUTCFullYear(), bkk.getUTCMonth() + 1);
  if (d === 1) return 'day1';
  if (d === 7) return 'day7';
  if (d === 9) return 'day9';
  if (d === 10) return 'day10';
  if (d === last) return 'before1';
  if (d === last - 2) return 'before3';
  return null;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return null; }
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (_) { return {}; }
}
function saveState(st) { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2)); }

// หาตัวคนในกลุ่มจาก label ("H2", "Admin 1", ...) หรือ config ระบุ username/id ตรงๆ
// เทียบ (ไม่สนตัวพิมพ์): username / ชื่อที่แสดง (firstName, firstName+lastName)
async function resolveMentions(client, entity, mentionCfg) {
  const participants = await client.getParticipants(entity);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const out = [];
  for (const m of mentionCfg || []) {
    const label = typeof m === 'string' ? m : (m.label || m.username || String(m.id || ''));
    const wantUser = norm(typeof m === 'object' ? m.username : '');
    const wantId = typeof m === 'object' && m.id ? String(m.id) : '';
    const wantName = norm(label);
    let found = null;
    for (const p of participants) {
      if (wantId && String(p.id) === wantId) { found = p; break; }
      if (wantUser && norm(p.username) === wantUser) { found = p; break; }
      const full = norm([p.firstName, p.lastName].filter(Boolean).join(' '));
      if (!wantUser && !wantId && (norm(p.firstName) === wantName || full === wantName || norm(p.username) === wantName)) { found = p; break; }
    }
    out.push({ label, user: found });
  }
  return out;
}

// ประกอบข้อความ: เนื้อหา + เว้นบรรทัด + แถวแท็ค — mention คนไม่มี username ใช้ entity MentionName (ต้องมี offset UTF-16)
function buildMessage(text, resolved, blankLines) {
  const gap = '\n'.repeat(Math.max(1, Number(blankLines) || 2) + 1); // 2 บรรทัดว่าง = ขึ้นบรรทัดใหม่ 3 ครั้ง
  let msg = String(text).trim() + gap;
  const entities = [];
  resolved.forEach((r, i) => {
    if (i > 0) msg += ' ';
    if (r.user && r.user.username) {
      msg += '@' + r.user.username;                    // @username เด้งเองไม่ต้องมี entity
    } else if (r.user) {
      const offset = msg.length;                        // .length ของ JS = UTF-16 units ตรงสเปก Telegram
      msg += r.label;
      entities.push({ offset, length: r.label.length, userId: r.user.id });
    } else {
      msg += r.label;                                   // หาตัวไม่เจอ — ใส่ชื่อเฉยๆ (log เตือนแล้ว)
    }
  });
  return { msg, entities };
}

async function unpinMessage(client, entity, msgId) {
  try { await client.unpinMessage(entity, msgId); return true; }
  catch (_) {
    try { // fallback API ตรง เผื่อ helper ของ gramjs รุ่นที่ลงไว้ไม่มี unpinMessage
      const { Api } = require('telegram');
      await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: entity, id: msgId, unpin: true }));
      return true;
    } catch (e2) {
      console.error(`⚠️ announcer: ลบ pin เก่า (msg ${msgId}) ไม่ได้: ${(e2 && e2.message) || e2}`);
      return false;
    }
  }
}

const MAIN_SLOTS = ['day1', 'day10'];        // วันหลัก — pin 24 ชม. แล้วลบ
const MAIN_PIN_HOURS = 24;

// ตัวแปรในเทมเพลต — บอทเติมวันที่จริงของเดือนนั้นให้เองทุกเดือน (พ.ศ.)
//   {TODAY} = วันนี้ · {DUE_DATE} = วันครบกำหนดของชุดนั้น · {DUE_MONTH} = เดือนของรอบบิล
const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_WDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
function thaiDate(d) { return `วัน${TH_WDAYS[d.getUTCDay()]}ที่ ${d.getUTCDate()} ${TH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`; }
function dueDateFor(slot, now) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (slot === 'day1') return now;                                          // ชุด Premium ID ครบกำหนดวันนี้
  if (slot === 'before3' || slot === 'before1') return new Date(Date.UTC(y, m + 1, 1)); // นับถอยหลังเข้าวันที่ 1 เดือนถัดไป
  return slot === 'day10' ? now : new Date(Date.UTC(y, m, 10));             // ชุด Broadcast ครบกำหนดวันที่ 10 เดือนนี้
}
function fillVars(text, slot, now) {
  const due = dueDateFor(slot, now);
  return String(text)
    .replace(/\{TODAY\}/g, thaiDate(now))
    .replace(/\{DUE_DATE\}/g, thaiDate(due))
    .replace(/\{DUE_MONTH\}/g, `${TH_MONTHS[due.getUTCMonth()]} ${due.getUTCFullYear() + 543}`);
}

async function sendAnnouncement(client, entity, slot, cfg, state) {
  const { Api } = require('telegram');
  const resolved = await resolveMentions(client, entity, cfg.mentions);
  resolved.filter(r => !r.user).forEach(r => console.log(`⚠️ announcer: หา "${r.label}" ในกลุ่มไม่เจอ — แท็คไม่เด้ง (ใส่ username/id ใน announce.json ช่วยได้)`));
  const { msg, entities } = buildMessage(fillVars(cfg.messages[slot], slot, bkkNow()), resolved, cfg.blankLines);
  const formattingEntities = entities.map(e => new Api.InputMessageEntityMentionName({
    offset: e.offset, length: e.length,
    userId: new Api.InputUser({ userId: e.userId, accessHash: resolved.find(r => r.user && r.user.id === e.userId).user.accessHash }),
  }));
  const sent = await client.sendMessage(entity, { message: msg, formattingEntities: formattingEntities.length ? formattingEntities : undefined });
  // ชุดใหม่มา → ลบ pin ชุดก่อน (เคาท์ดาวน์ pin ค้างจนถึงตรงนี้)
  if (state.pin && state.pin.msgId) await unpinMessage(client, entity, state.pin.msgId);
  try {
    await client.pinMessage(entity, sent.id, { notify: true }); // pin แบบเด้งแจ้งเตือนทุกคน (แทน @all ที่ Telegram ไม่มี)
    state.pin = {
      msgId: sent.id, slot,
      // วันหลักลบ pin หลัง 24 ชม. · เคาท์ดาวน์ไม่มีเวลาหมด (null = รอชุดถัดไปมาแทน)
      unpinAt: MAIN_SLOTS.includes(slot) ? new Date(Date.now() + MAIN_PIN_HOURS * 3600 * 1000).toISOString() : null,
    };
  } catch (e) {
    console.error(`⚠️ announcer: ส่งแล้วแต่ pin ไม่ได้ (บัญชีอาจไม่มีสิทธิ์ pin): ${(e && e.message) || e}`);
  }
  return sent;
}

// วนเช็ค: ถึงเวลา + วันนี้เป็นวันส่ง + ยังไม่ส่ง + มีข้อความ → ส่ง (ถ้า process ดับช่วง 00:01 กลับมาแล้วยังส่งชดเชยภายในวันเดียวกัน)
function start(client, entity) {
  const warnedEmpty = new Set(); // log "ข้อความว่าง" วันละครั้งต่อ slot พอ
  async function tick() {
    const cfg = loadConfig();
    if (!cfg || cfg.enabled === false) return;
    // pin วันหลักครบ 24 ชม. → ลบ pin (persist ใน state — restart แล้วยังลบตรงเวลา)
    const st0 = loadState();
    if (st0.pin && st0.pin.unpinAt && new Date().toISOString() >= st0.pin.unpinAt) {
      await unpinMessage(client, entity, st0.pin.msgId);
      console.log(`📌 announcer: ครบ ${MAIN_PIN_HOURS} ชม. — ลบ pin "${st0.pin.slot}" (msg ${st0.pin.msgId})`);
      delete st0.pin;
      saveState(st0);
    }
    const now = bkkNow();
    const slot = slotForDate(now);
    if (!slot) return;
    const timeStr = now.toISOString().slice(11, 16);
    if (timeStr < (cfg.sendTime || '00:01')) return;
    const dateStr = now.toISOString().slice(0, 10);
    const key = `${dateStr}:${slot}`;
    const state = loadState();
    if (state[key]) return;
    const text = (cfg.messages && cfg.messages[slot]) ? String(cfg.messages[slot]).trim() : '';
    if (!text) {
      if (!warnedEmpty.has(key)) { warnedEmpty.add(key); console.log(`📭 announcer: วันนี้ครบรอบ "${slot}" แต่ยังไม่ได้ตั้งข้อความใน announce.json — เติมข้อความแล้วจะส่งให้อัตโนมัติ`); }
      return;
    }
    const sent = await sendAnnouncement(client, entity, slot, cfg, state);
    state[key] = { sentAt: new Date().toISOString(), msgId: sent.id };
    saveState(state);
    console.log(`📣 announcer: ส่ง+pin แจ้งเตือน "${slot}" แล้ว (msg ${sent.id})`);
  }
  setInterval(() => { tick().catch(e => console.error('⚠️ announcer ล้ม:', (e && e.message) || e)); }, CHECK_MS);
  console.log(`📅 announcer: พร้อมส่งแจ้งเตือน (สิ้นเดือน-2 / สิ้นเดือน / 1 / 7 / 9 / 10 เวลา ${((loadConfig() || {}).sendTime) || '00:01'} น.)`);
}

module.exports = { start, slotForDate, buildMessage, resolveMentions, daysInMonth, fillVars, sendAnnouncement, unpinMessage, CONFIG_PATH };

// ── โหมดรันเดี่ยว (ทดสอบ) ──
// --test <slot>: ยิงเทมเพลต slot นั้นเข้ากลุ่มจริง 1 ข้อความ (แท็คจริง, ไม่ pin, ไม่แตะ state)
//                ใช้ดูหน้าตาจริงก่อนรอบส่งอัตโนมัติ — ลบทิ้งจากกลุ่มทีหลังได้
if (require.main === module) {
  (async () => {
    const dry = process.argv.includes('--dry');
    const doResolve = process.argv.includes('--resolve');
    const ti = process.argv.indexOf('--test');
    const testSlot = ti !== -1 ? (process.argv[ti + 1] || 'before3') : null;
    const delTest = process.argv.includes('--del-test');
    const cfg = loadConfig();
    if (!cfg) { console.error(`❌ อ่าน ${CONFIG_PATH} ไม่ได้`); process.exit(1); }
    const now = bkkNow();
    const slot = slotForDate(now);
    console.log(`วันนี้ (ไทย): ${now.toISOString().slice(0, 10)} → slot: ${slot || 'ไม่ใช่วันส่ง'}`);
    if (dry && !doResolve) {
      // dry ล้วน: ไม่ต่อ Telegram — โชว์ข้อความที่จะส่งของทุก slot
      for (const [k, v] of Object.entries(cfg.messages || {})) {
        const { msg } = buildMessage(v || '(ยังไม่ตั้งข้อความ)', (cfg.mentions || []).map(m => ({ label: typeof m === 'string' ? m : m.label, user: null })), cfg.blankLines);
        console.log(`\n── ${k} ──\n${msg}`);
      }
      process.exit(0);
    }
    if (doResolve || testSlot || delTest) {
      require('dotenv').config({ path: path.join(ROOT, '.env') });
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');
      const client = new TelegramClient(new StringSession(process.env.TG_SESSION || ''), Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 3 });
      await client.connect();
      let entity = null;
      try { entity = await client.getEntity('withdraw atm'); } catch (_) {}
      if (!entity) {
        // ชื่อกลุ่มจริงมีอิโมจิต่อท้าย ("Withdraw Atm 💳") — match แบบ includes เหมือน resolveGroup ของ scan.js
        for await (const d of client.iterDialogs({ limit: 500 })) {
          if (String(d.title || '').trim().toLowerCase().includes('withdraw atm')) { entity = d.entity; break; }
        }
      }
      if (!entity) { console.error('❌ หากลุ่ม withdraw atm ไม่เจอ'); process.exit(1); }
      const resolved = await resolveMentions(client, entity, cfg.mentions);
      resolved.forEach(r => console.log(r.user
        ? `✓ "${r.label}" → ${[r.user.firstName, r.user.lastName].filter(Boolean).join(' ')}${r.user.username ? ' @' + r.user.username : ''} (id ${r.user.id})`
        : `✗ "${r.label}" — หาไม่เจอในกลุ่ม`));
      if (testSlot) {
        const { Api } = require('telegram');
        const text = (cfg.messages && cfg.messages[testSlot]) ? String(cfg.messages[testSlot]).trim() : '';
        if (!text) { console.error(`❌ slot "${testSlot}" ไม่มีข้อความ (มี: before3 before1 day1 day7 day9 day10)`); process.exit(1); }
        // แปะหัวกำกับให้คนในกลุ่มรู้ว่าเป็นการทดสอบ — เฉพาะโหมด --test (รอบส่งจริงไม่มีบรรทัดนี้)
        const testText = '🧪 [ ข้อความทดสอบระบบแจ้งเตือน — ไม่ต้องดำเนินการใดๆ ]\n\n' + text;
        const { msg, entities } = buildMessage(fillVars(testText, testSlot, bkkNow()), resolved, cfg.blankLines);
        const formattingEntities = entities.map(e => new Api.InputMessageEntityMentionName({
          offset: e.offset, length: e.length,
          userId: new Api.InputUser({ userId: e.userId, accessHash: resolved.find(r => r.user && r.user.id === e.userId).user.accessHash }),
        }));
        const sent = await client.sendMessage(entity, { message: msg, formattingEntities: formattingEntities.length ? formattingEntities : undefined });
        console.log(`📨 ยิงทดสอบ "${testSlot}" เข้ากลุ่มแล้ว (msg ${sent.id}) — ไม่ pin, ไม่แตะ state · ลบ: --del-test ${sent.id}`);
      }
      const di = process.argv.indexOf('--del-test');
      if (di !== -1 && process.argv[di + 1]) {
        await client.deleteMessages(entity, [Number(process.argv[di + 1])], { revoke: true }); // revoke = ลบฝั่งทุกคน
        console.log(`🗑️ ลบข้อความทดสอบ ${process.argv[di + 1]} ออกจากกลุ่มแล้ว`);
      }
      process.exit(0);
    }
  })().catch(e => { console.error('❌', (e && e.message) || e); process.exit(1); });
}
