const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

function getBangkokToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = {};
  parts.forEach(part => (p[part.type] = part.value));
  return { date: `${p.year}-${p.month}-${p.day}`, year: Number(p.year) };
}

// โมเดลให้เลือกใน dropdown ตั้งค่า (โมเดลหลัก) — Gemini ใช้ 2.5 ขึ้นไปเท่านั้น
const SUPPORTED_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (แนะนำ — เร็ว/แม่น)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (แม่นสุด ช้ากว่า)' },
  { id: 'gpt-4o', label: 'GPT-4o (OpenAI)' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini (OpenAI ประหยัด)' },
  { id: 'typhoon-ocr', label: 'Typhoon OCR 1.5 (เชี่ยวชาญสลิปไทย)' },
];

const OPENAI_COMPAT_BASE = {
  openai: 'https://api.openai.com/v1',
  typhoon: 'https://api.opentyphoon.ai/v1',
};

function providerOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('typhoon')) return 'typhoon';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
  return 'gemini';
}

const SLIP_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    account_last4: { type: SchemaType.STRING, description: 'เลขท้ายบัญชีต้นทาง (2-6 หลัก) ถ้าไม่พบให้เป็น "null"' },
    amount: { type: SchemaType.NUMBER, description: 'ยอดเงิน' },
    fee: { type: SchemaType.NUMBER, description: 'ค่าธรรมเนียม ถ้าไม่มีให้เป็น 0' },
    tx_type: { type: SchemaType.STRING, description: 'ประเภทรายการ ลอกคำตามภาษาต้นฉบับบนสลิป' },
    counterparty: { type: SchemaType.STRING, description: 'ชื่อคู่สัญญา/ผู้รับปลายทาง ถ้าไม่มีให้เป็น "-"' },
    recipient_last4: { type: SchemaType.STRING, description: 'เลขท้ายบัญชีปลายทาง/ผู้รับ (TO A/C, 2-6 หลัก) ถ้าไม่พบให้เป็น "null"' },
    bank: { type: SchemaType.STRING, description: 'ชื่อย่อธนาคาร' },
    date: { type: SchemaType.STRING, description: 'วันเวลา รูปแบบ YYYY-MM-DD HH:mm' },
    slip_type: { type: SchemaType.STRING, description: '"digital" หรือ "atm"' },
  },
  required: ['account_last4', 'amount', 'fee', 'tx_type', 'bank', 'date', 'slip_type'],
};

// เวอร์ชัน JSON Schema ปกติ (สำหรับ OpenAI structured outputs แบบ strict — บังคับ field เป๊ะเท่า Gemini)
const SLIP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account_last4: { type: 'string', description: 'เลขท้ายบัญชีต้นทาง (2-6 หลัก) ถ้าไม่พบให้เป็น "null"' },
    amount: { type: 'number', description: 'ยอดเงิน' },
    fee: { type: 'number', description: 'ค่าธรรมเนียม ถ้าไม่มีให้เป็น 0' },
    tx_type: { type: 'string', description: 'ประเภทรายการ ลอกคำตามภาษาต้นฉบับบนสลิป' },
    counterparty: { type: 'string', description: 'ชื่อคู่สัญญา/ผู้รับปลายทาง ถ้าไม่มีให้เป็น "-"' },
    recipient_last4: { type: 'string', description: 'เลขท้ายบัญชีปลายทาง/ผู้รับ (TO A/C, 2-6 หลัก) ถ้าไม่พบให้เป็น "null"' },
    bank: { type: 'string', description: 'ชื่อย่อธนาคาร' },
    date: { type: 'string', description: 'วันเวลา รูปแบบ YYYY-MM-DD HH:mm' },
    slip_type: { type: 'string', description: '"digital" หรือ "atm"' },
  },
  required: ['account_last4', 'amount', 'fee', 'tx_type', 'counterparty', 'recipient_last4', 'bank', 'date', 'slip_type'],
};

function buildPrompt() {
  const today = getBangkokToday();
  return `
    วิเคราะห์รูปสลิปนี้ (อาจเป็นสลิปดิจิทัลหรือสลิป ATM กระดาษ) แล้วตอบเป็น JSON object เท่านั้น:
    - account_last4: เลขท้ายของบัญชีต้นทาง (ผู้โอน/ผู้ถอน) ตามจำนวนหลักที่ปรากฏจริง (2-6 หลัก) เก็บเฉพาะตัวเลข ถ้าไม่พบให้เป็น "null"
    - amount: ยอดเงิน (ตัวเลข ไม่มีลูกน้ำ)
    - fee: ค่าธรรมเนียมตามที่พิมพ์บนสลิป (ตัวเลข) ถ้าไม่มีให้เป็น 0
    - tx_type: ประเภทรายการ ลอกข้อความตามภาษาต้นฉบับบนสลิป (เช่น "Transfer","Withdrawal","Fast Cash","Bill Payment","Deposit","โอนเงิน","ถอนเงินสด") ห้ามแปล
    - counterparty: ชื่อคู่สัญญา/ผู้รับปลายทาง ถ้าไม่มีให้เป็น "-"
    - recipient_last4: เลขท้ายบัญชี "ปลายทาง/ผู้รับ" (TO A/C, ผู้รับ, To) ตามจำนวนหลักที่ปรากฏ (2-6 หลัก) เก็บเฉพาะตัวเลข ถ้าไม่พบให้เป็น "null"
    - bank: ชื่อย่อธนาคาร (เช่น SCB, KBANK, KTB, BBL)
    - date: วันเวลา รูปแบบ YYYY-MM-DD HH:mm
    - slip_type: "digital" หรือ "atm"

    Date/year rules:
    - วันนี้ประมาณ ${today.date} (ปี ค.ศ. ${today.year}) วันที่บนสลิปควรใกล้เคียงวันนี้
    - ตอบปีเป็น ค.ศ. (AD) เสมอ ถ้าสลิปเป็น พ.ศ. ให้ลบ 543
    - ถ้าได้ปีห่างจาก ${today.year} เกิน 1 ปี แปลว่าอ่านผิด ให้พิจารณาใหม่
    - ไม่ต้องเก็บข้อมูลสถานที่/สาขา
  `;
}

// คำเน้นเฉพาะ GPT/Typhoon (Gemini ใช้ buildPrompt เดิม ไม่แตะ) — แก้จุดที่ 2 ค่ายนี้พลาดบ่อย
const ACCOUNT_HINT = `

    *** สำคัญมาก ***
    - account_last4 = บัญชี "ต้นทาง/ผู้โอน" (FROM A/C, ผู้โอน, From) เท่านั้น
      ห้ามเอาบัญชีปลายทาง (TO A/C, To, ผู้รับ) มาเด็ดขาด — สลิปมักมี 2 บัญชี ระวังหยิบผิด
    - amount/fee: คงทศนิยมให้ครบเป๊ะตามสลิป (เช่น 24,464.26 ต้องเป็น 24464.26 ห้ามตัดเป็น 246426 หรือ 24464)
`;

// retry สำหรับ error ชั่วคราว (429/5xx/timeout) — ลองซ้ำสั้นๆ ก่อนตกไปค่ายถัดไป
async function withRetry(fn, label, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      const transient = !status || status === 429 || (status >= 500 && status < 600) || /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(e.message || '');
      if (!transient || i === tries - 1) break;
      const wait = 1500 * (i + 1);
      console.warn(`OCR ${label}: error ชั่วคราว (${status || e.message}) ลองใหม่ใน ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function extractWithGemini(model, prompt, base64) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: 'application/json', responseSchema: SLIP_SCHEMA },
  });
  const result = await m.generateContent([prompt, { inlineData: { data: base64, mimeType: 'image/jpeg' } }]);
  const text = result.response.text();
  const usage = result.response.usageMetadata || {};
  return { data: JSON.parse(text.replace(/```json\n?|```/g, '').trim()), tokens: usage.totalTokenCount || 0 };
}

// OpenAI (GPT) — ใช้ json_schema strict บังคับ field เป๊ะเท่า Gemini + เพิ่มคำเน้น FROM/ทศนิยม
async function extractWithOpenAI(model, prompt, base64) {
  return withRetry(async () => {
    const resp = await axios.post(`${OPENAI_COMPAT_BASE.openai}/chat/completions`, {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt + ACCOUNT_HINT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      }],
      response_format: { type: 'json_schema', json_schema: { name: 'slip', strict: true, schema: SLIP_JSON_SCHEMA } },
      max_tokens: 1200,
    }, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });
    const text = resp.data.choices[0].message.content;
    const tokens = (resp.data.usage && resp.data.usage.total_tokens) || 0;
    return { data: JSON.parse(text.replace(/```json\n?|```/g, '').trim()), tokens };
  }, `openai/${model}`);
}

// Typhoon OCR — 2 สเต็ป: (1) /v1/ocr ถอดเป็น markdown ที่แม่นยำ → (2) สกัด field ด้วย LLM
async function typhoonOcrText(filePath) {
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath) || 'slip.jpg';
  const resp = await withRetry(() => {
    const form = new FormData(); // สร้างใหม่ทุก attempt (multipart ใช้ซ้ำไม่ได้)
    form.append('file', buf, { filename: name, contentType: 'image/jpeg' });
    form.append('model', 'typhoon-ocr');
    form.append('task_type', 'default');
    form.append('max_tokens', '16384');
    form.append('temperature', '0.1');
    form.append('top_p', '0.6');
    form.append('repetition_penalty', '1.2');
    return axios.post(`${OPENAI_COMPAT_BASE.typhoon}/ocr`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.TYPHOON_API_KEY}` },
      timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity,
    });
  }, 'typhoon/ocr');
  const texts = [];
  let tokens = 0;
  for (const page of (resp.data.results || [])) {
    if (page.success && page.message) {
      const content = page.message.choices[0].message.content;
      tokens += (page.message.usage && page.message.usage.total_tokens) || 0;
      try { const parsed = JSON.parse(content); texts.push(parsed.natural_text || content); }
      catch (_) { texts.push(content); }
    } else if (!page.success) {
      throw new Error(page.error || 'typhoon ocr page failed');
    }
  }
  return { text: texts.join('\n').trim(), tokens };
}

// สกัด field จากข้อความ OCR (ใช้ Gemini โหมด text — เร็ว/แม่น สำหรับขั้นจัดระเบียบ)
async function extractFieldsFromText(ocrText) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const m = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json', responseSchema: SLIP_SCHEMA },
  });
  const prompt = `${buildPrompt()}${ACCOUNT_HINT}\n\nนี่คือข้อความที่ OCR ได้จากสลิป (markdown) ให้สกัดข้อมูลตาม field ข้างบน:\n"""\n${ocrText}\n"""`;
  const result = await m.generateContent(prompt);
  const text = result.response.text();
  const usage = result.response.usageMetadata || {};
  return { data: JSON.parse(text.replace(/```json\n?|```/g, '').trim()), tokens: usage.totalTokenCount || 0 };
}

async function extractWithTyphoon(filePath) {
  const ocr = await typhoonOcrText(filePath);
  if (!ocr.text) throw new Error('typhoon ocr returned empty text');
  const parsed = await extractFieldsFromText(ocr.text);
  return { data: parsed.data, tokens: ocr.tokens + parsed.tokens, ocrText: ocr.text };
}

// ถือว่า "จับครบ" เมื่อมียอดเงิน > 0 และมีเลขบัญชี
function isComplete(data) {
  if (!data) return false;
  const amount = Number(data.amount) || 0;
  const last4 = data.account_last4 ? String(data.account_last4).trim().toLowerCase() : '';
  return amount > 0 && last4 && last4 !== 'null';
}

// สร้าง chain ตามที่ตั้งค่าบนเว็บ: โมเดลหลัก → สำรอง1 → สำรอง2
// (ข้ามตัวที่เป็น 'none'/ซ้ำ/ไม่มี API key ของค่ายนั้น)
function buildChain() {
  const keyOf = {
    gemini: process.env.GEMINI_API_KEY,
    typhoon: process.env.TYPHOON_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  const picks = [
    process.env.OCR_MODEL || 'gemini-2.5-flash',
    process.env.OCR_FALLBACK_1 || 'typhoon-ocr',
    process.env.OCR_FALLBACK_2 || 'gpt-4o-mini',
  ];
  const seen = new Set();
  const chain = [];
  for (const model of picks) {
    const m = String(model || '').trim();
    if (!m || m.toLowerCase() === 'none' || seen.has(m)) continue;
    seen.add(m);
    const provider = providerOf(m);
    if (!keyOf[provider]) continue; // ไม่มี API key ค่ายนั้น → ข้าม
    chain.push({ provider, model: m, key: keyOf[provider] });
  }
  return chain;
}

// รันโมเดลเดียว (สำหรับทดสอบเทียบความแม่นยำ — ไม่ใช้ fallback)
async function extractWithModel(model, filePath) {
  const provider = providerOf(model);
  if (provider === 'typhoon') return extractWithTyphoon(filePath);
  const base64 = Buffer.from(fs.readFileSync(filePath)).toString('base64');
  const prompt = buildPrompt();
  if (provider === 'gemini') return extractWithGemini(model, prompt, base64);
  return extractWithOpenAI(model, prompt, base64);
}

async function runStep(step, prompt, base64, filePath) {
  if (step.provider === 'typhoon') return extractWithTyphoon(filePath);
  if (step.provider === 'gemini') return extractWithGemini(step.model, prompt, base64);
  return extractWithOpenAI(step.model, prompt, base64);
}

// ให้คะแนนผลที่ไม่ครบ เพื่อเก็บ "ตัวที่ดีที่สุด" ไว้ prefill คิวรอตรวจ
function partialScore(r) {
  if (!r || !r.data) return r && r.ocrText ? 1 : 0;
  const d = r.data;
  let s = 0;
  if (Number(d.amount) > 0) s += 4;
  const last4 = d.account_last4 ? String(d.account_last4).trim().toLowerCase() : '';
  if (last4 && last4 !== 'null') s += 3;
  if (d.date) s += 1;
  if (r.ocrText) s += 1;
  return s;
}

// ลองตามลำดับ → คืน object เสมอ พร้อม status:
//   'auto'   = ตัวหลัก (Gemini) จับครบ → caller บันทึกอัตโนมัติ
//   'review' = ใช้ตัวสำรองแล้วจับครบ → caller ส่งเข้าคิวรอตรวจ (ไม่เชื่อทันที)
//   'manual' = ทุกตัวจับไม่ครบ → caller ไม่บันทึก + แจ้งกรอกเอง (มี data/ocrText บางส่วนไว้ prefill)
async function extractSlipData(filePath) {
  const base64 = Buffer.from(fs.readFileSync(filePath)).toString('base64');
  const prompt = buildPrompt();
  const chain = buildChain();
  if (chain.length === 0) {
    console.error('OCR: ยังไม่ได้ตั้งค่า API key ของค่ายใดเลย');
    return { status: 'manual', data: null, ocrText: null, provider: null, model: null, usedFallback: false };
  }
  let best = null;
  const attempts = []; // เก็บผลทุกค่ายที่ลอง (ไว้ทำสถิติต่อ provider บนแดชบอร์ด)
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    try {
      const r = await runStep(step, prompt, base64, filePath);
      const tagged = { ...r, model: step.model, provider: step.provider, usedFallback: i > 0 };
      const ok = isComplete(r.data);
      attempts.push({ provider: step.provider, model: step.model, ok, error: false, tokens: r.tokens || 0 });
      if (ok) {
        return { ...tagged, status: i === 0 ? 'auto' : 'review', attempts };
      }
      if (!best || partialScore(tagged) > partialScore(best)) best = tagged;
      console.warn(`OCR ${step.provider}/${step.model}: ผลไม่ครบ (ลองค่ายถัดไป)`);
    } catch (e) {
      attempts.push({ provider: step.provider, model: step.model, ok: false, error: true, tokens: 0 });
      const detail = e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      console.error(`OCR ${step.provider}/${step.model} ล้มเหลว: ${detail}`);
    }
  }
  // ทุกค่ายจับไม่ครบ → ส่งผลบางส่วนที่ดีที่สุดกลับไว้ prefill
  return best
    ? { ...best, status: 'manual', attempts }
    : { status: 'manual', data: null, ocrText: null, provider: null, model: null, usedFallback: true, attempts };
}

module.exports = { extractSlipData, extractWithModel, isComplete, SUPPORTED_MODELS, providerOf };
