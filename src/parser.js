const { categorizeTxType } = require('./sheets');

// แปลงคำดิบบนสลิป → "ชื่อหมวด" ที่จะบันทึกลงชีต/แสดงในเทเล
// (หมวดที่รู้จัก → ชื่อหมวด, ไม่รู้จัก → คงคำดิบไว้ให้เห็นว่าต้องเพิ่มคีย์เวิร์ด)
const CATEGORY_LABEL = { transfer: 'โอน', withdraw: 'ถอน', deposit: 'ฝาก/รับ', bill: 'ชำระบิล' };
function categoryLabel(rawType) {
  const raw = String(rawType || '').trim();
  const cat = categorizeTxType(raw);
  return CATEGORY_LABEL[cat] || raw || 'อื่นๆ';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getBangkokNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const p = {};
  parts.forEach(part => (p[part.type] = part.value));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function normalizeYear(year) {
  const currentYear = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
  }).format(new Date()));

  if (year >= 2400) {
    return year - 543;
  }

  if (year < 100) {
    const buddhistYear = year + 2500 - 543;
    if (buddhistYear >= currentYear - 10 && buddhistYear <= currentYear + 1) {
      return buddhistYear;
    }
    return 2000 + year;
  }

  // Some OCR/AI outputs "2069" when a Thai slip shows BE short year "69".
  if (year > currentYear + 1) {
    const correctedShortBuddhistYear = year - 43;
    if (correctedShortBuddhistYear >= currentYear - 10 && correctedShortBuddhistYear <= currentYear + 1) {
      return correctedShortBuddhistYear;
    }
  }

  return year;
}

function getBangkokYear() {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
  }).format(new Date()));
}

// บันทึกเป็น "YYYY-MM-DD HH:mm" โดย "ปี" ใช้ปีปัจจุบันตาม local time เสมอ
// ส่วน วัน/เดือน/เวลา อ้างอิงตามสลิป (ไม่สนใจปีที่อ่านได้จากสลิป เพราะมักอ่านผิด)
function normalizeSlipDate(value) {
  const year = getBangkokYear();
  if (!value) return getBangkokNow();

  const text = String(value).trim();
  const timeMatch = text.match(/(\d{1,2})[:.](\d{2})/);
  const hour = timeMatch ? pad2(timeMatch[1]) : '00';
  const minute = timeMatch ? pad2(timeMatch[2]) : '00';

  const dateMatch = text.match(/(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
  if (dateMatch) {
    const first = Number(dateMatch[1]);
    const second = Number(dateMatch[2]);
    const third = Number(dateMatch[3]);
    const firstLen = dateMatch[1].length;

    let month;
    let day;

    if (firstLen === 4 || first > 31) {
      // รูปแบบ YYYY-MM-DD (จากสลิป) → ใช้แค่เดือน/วัน
      month = second;
      day = third;
    } else {
      // รูปแบบ DD-MM-YYYY หรือ DD-MM → ใช้แค่วัน/เดือน
      day = first;
      month = second;
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${pad2(month)}-${pad2(day)} ${hour}:${minute}`;
    }
  }

  return text;
}

function parseSlipData(jsonData) {
  if (!jsonData) return null;

  try {
    const last4 = jsonData.account_last4 ? String(jsonData.account_last4).trim() : 'UNKNOWN';
    const amount = Number(jsonData.amount) || 0;
    const fee = Number(jsonData.fee) || 0;
    const tx_type = categoryLabel(jsonData.tx_type); // บันทึกเป็นชื่อหมวด ไม่ใช่คำดิบ
    const counterparty = jsonData.counterparty || '-';
    // เลขบัญชีปลายทาง/ผู้รับ (เก็บเฉพาะตัวเลข) — ใช้จับกลุ่มผู้รับในสรุป
    const rRaw = jsonData.recipient_last4 ? String(jsonData.recipient_last4).replace(/\D/g, '') : '';
    const recipient_last4 = (rRaw && rRaw.toLowerCase() !== 'null') ? rRaw : '';
    const bank = jsonData.bank || '-';
    const date = normalizeSlipDate(jsonData.date);
    const slip_type = jsonData.slip_type || 'digital';

    return {
      last4,
      amount,
      fee,
      tx_type,
      counterparty,
      recipient_last4,
      bank,
      date,
      slip_type
    };
  } catch (error) {
    console.error('Error parsing slip data:', error);
    return null;
  }
}

// ตรวจว่าวันที่ที่ OCR อ่านได้ "น่าสงสัย" ไหม (อนาคต หรือเก่ากว่าวันรับมากผิดปกติ)
// ใช้กันกรณี OCR อ่านเดือน/วันผิด แล้วสลิปหายจากหน้าเว็บที่กรองตามเดือน
// refIso = เวลาที่รับสลิป (job.createdAt) ถ้าไม่มีใช้เวลาปัจจุบัน; maxAgeDays = อายุย้อนหลังที่ยอมรับ
// คืนค่า: ข้อความเตือน (string) ถ้าน่าสงสัย, หรือ null ถ้าปกติ
function slipDateWarning(dateStr, refIso, maxAgeDays = 14) {
  const m = String(dateStr || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const slip = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(slip.getTime())) return null;
  // วันอ้างอิงตามเวลาไทย (เที่ยงคืน) จาก refIso หรือ now
  const ref = refIso ? new Date(refIso) : new Date();
  const bkk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(isNaN(ref.getTime()) ? new Date() : ref);
  const [ry, rm, rd] = bkk.split('-').map(Number);
  const refMidnight = new Date(ry, rm - 1, rd);
  const days = Math.round((refMidnight - slip) / 86400000); // บวก = อดีต, ลบ = อนาคต
  if (days < -1) return `วันที่บนสลิปเป็นอนาคต (${m[0]}) — อาจอ่านวัน/เดือนผิด`;
  if (days > maxAgeDays) return `วันที่บนสลิปเก่ากว่าวันรับ ${days} วัน (${m[0]}) — อาจอ่านเดือนผิด`;
  return null;
}

module.exports = { parseSlipData, normalizeSlipDate, slipDateWarning };
