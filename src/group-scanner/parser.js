// parser.js — แยกข้อความ "ประกาศรายการ" ในกลุ่ม Telegram เป็น record ที่จับคู่กับสลิปได้
// tolerant: label หลายแบบ, separator หลายแบบ (: ： เว้นวรรค), ข้าม emoji/อักขระแปลก
// 1 ข้อความ → หลาย record ได้ (flush เมื่อเจอ field ที่เริ่ม record ใหม่ซ้ำ)

// ── ตาราง label → field (เพิ่มได้เมื่อเจอรูปแบบใหม่) ──
// เรียงจากเฉพาะเจาะจงไปกว้าง กัน "เลขบัญชี" ชนกับ "บัญชี"/"ยอด" ชนกับ "จำนวนเงิน"
const LABELS = [
  { field: 'company', re: /^(?:บริษัท|บ\.|company)\s*/i },
  { field: 'user',    re: /^(?:ยูสเซอร์|ยูส(?:เซอร์)?|user(?:name)?|ไอดี|id)\s*/i },
  { field: 'name',    re: /^(?:ชื่อ(?:บัญชี|ลูกค้า)?|name|acc(?:ount)?\s*name)\s*/i },
  { field: 'bank',    re: /^(?:ธนาคาร|แบงค์|bank)\s*/i },
  { field: 'account', re: /^(?:เลข(?:ที่)?บัญชี|เลขบช\.?|บัญชี(?:เลขที่)?|acc(?:ount)?(?:\s*(?:no|number))?|a\/c)\s*/i },
  { field: 'amount',  re: /^(?:จำนวน(?:เงิน)?|ยอด(?:เงิน|โอน|ฝาก)?|เงิน|amount|amt)\s*/i },
];

// ธนาคารไทย → รหัสมาตรฐาน (ใช้ตอน match; เติมตามที่เจอจริง)
const BANK_MAP = [
  { code: 'KBANK', kw: ['กสิกร', 'kbank', 'kasikorn', 'k-bank', 'กสิกรไทย'] },
  { code: 'SCB',   kw: ['ไทยพาณิชย์', 'scb', 'siam commercial'] },
  { code: 'BBL',   kw: ['กรุงเทพ', 'bbl', 'bangkok bank'] },
  { code: 'KTB',   kw: ['กรุงไทย', 'ktb', 'krung thai'] },
  { code: 'BAY',   kw: ['กรุงศรี', 'bay', 'ayudhya', 'krungsri'] },
  { code: 'TTB',   kw: ['ทหารไทย', 'ธนชาต', 'ttb', 'tmb', 'thanachart'] },
  { code: 'GSB',   kw: ['ออมสิน', 'gsb', 'government savings'] },
  { code: 'BAAC',  kw: ['ธกส', 'ธ.ก.ส', 'baac'] },
  { code: 'UOB',   kw: ['ยูโอบี', 'uob'] },
  { code: 'CIMB',  kw: ['ซีไอเอ็มบี', 'cimb'] },
  { code: 'KKP',   kw: ['เกียรตินาคิน', 'kkp', 'kiatnakin'] },
  { code: 'TISCO', kw: ['ทิสโก้', 'tisco'] },
  { code: 'LHB',   kw: ['แลนด์', 'lh bank', 'lhbank', 'land and houses'] },
];

// ลบ emoji / zero-width / อักขระควบคุม แล้ว trim
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[​-‏﻿⁠]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}←-⇿⬀-⯿️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// แยก label ออกจากค่า — คืน { field, value } ถ้าบรรทัดขึ้นต้นด้วย label ที่รู้จัก
function matchLabel(line) {
  // ตัด separator นำหน้าค่าออก (: ： = - หรือเว้นวรรคยาว) หลังจับ label
  for (const { field, re } of LABELS) {
    const m = line.match(re);
    if (m) {
      let val = line.slice(m[0].length).replace(/^[\s:：=\-–—]+/, '').trim();
      return { field, value: val };
    }
  }
  return null;
}

// amount: "10,000" / "10000 บาท" / "1,234.50฿" → number
function parseAmount(v) {
  if (!v) return null;
  const m = clean(v).replace(/[,\s]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// account: เก็บเฉพาะตัวเลข → { full, last4 }
function parseAccount(v) {
  const digits = clean(v).replace(/\D/g, '');
  if (!digits) return { full: '', last4: '' };
  return { full: digits, last4: digits.slice(-4) };
}

// bank → รหัสมาตรฐาน (null ถ้าไม่รู้จัก แต่คง raw ไว้)
function normBank(v) {
  const s = clean(v).toLowerCase();
  if (!s) return null;
  for (const { code, kw } of BANK_MAP) {
    if (kw.some(k => s.includes(k))) return code;
  }
  return null;
}

// record ครบพอจะจับคู่ไหม (ต้องมีอย่างน้อย amount + (account หรือ name))
function isUsable(r) {
  return r.amount != null && !!(r.last4 || r.name);
}

// ── main: text → [records] ──
function parseGroupMessage(text) {
  const rawLines = String(text || '').split(/\r?\n/);
  const records = [];
  let cur = null;

  const flush = () => {
    if (cur && (cur.amount != null || cur.last4 || cur.name || cur.user)) {
      cur.usable = isUsable(cur);
      records.push(cur);
    }
    cur = null;
  };
  const fresh = () => ({
    company: '', user: '', name: '', bankRaw: '', bank: null,
    accountFull: '', last4: '', amount: null, amountRaw: '',
    raw: [], usable: false,
  });

  for (const rawLine of rawLines) {
    const line = clean(rawLine);
    if (!line) continue;
    const hit = matchLabel(line);
    if (!hit) {
      // บรรทัดต่อเนื่อง (ค่าล้นบรรทัด) — ผนวกเข้า field ล่าสุดที่เป็นข้อความ ถ้ามี
      if (cur) cur.raw.push(rawLine);
      continue;
    }
    if (!cur) cur = fresh();
    // ถ้า field นี้ถูกเซ็ตแล้วใน record ปัจจุบัน = เริ่มรายการใหม่
    const already =
      (hit.field === 'name' && cur.name) ||
      (hit.field === 'account' && cur.accountFull) ||
      (hit.field === 'amount' && cur.amount != null) ||
      (hit.field === 'bank' && cur.bankRaw) ||
      (hit.field === 'user' && cur.user);
    if (already) { flush(); cur = fresh(); }

    cur.raw.push(rawLine);
    switch (hit.field) {
      case 'company': cur.company = hit.value; break;
      case 'user':    cur.user = hit.value; break;
      case 'name':    cur.name = hit.value; break;
      case 'bank':    cur.bankRaw = hit.value; cur.bank = normBank(hit.value); break;
      case 'account': { const a = parseAccount(hit.value); cur.accountFull = a.full; cur.last4 = a.last4; break; }
      case 'amount':  cur.amountRaw = hit.value; cur.amount = parseAmount(hit.value); break;
    }
  }
  flush();

  // สรุป raw เป็นสตริงเดียว + คีย์จับคู่
  return records.map(r => ({
    company: r.company,
    user: r.user,
    name: r.name,
    bank: r.bank,
    bankRaw: r.bankRaw,
    account: r.accountFull,
    last4: r.last4,
    amount: r.amount,
    raw: r.raw.join('\n').trim(),
    usable: r.usable,
    // คีย์จับคู่กับสลิป: amount|last4|bank (bank ใช้รหัสมาตรฐาน; ว่างถ้าไม่รู้จัก)
    matchKey: r.amount != null ? `${r.amount}|${r.last4}|${r.bank || ''}` : null,
  }));
}

module.exports = { parseGroupMessage, normBank, parseAmount, parseAccount, BANK_MAP, LABELS };
