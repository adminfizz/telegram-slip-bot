const { google } = require('googleapis');
const md5 = require('md5');

// ─── Rate limiter (คุมจังหวะเรียก Google Sheets ไม่ให้ชน quota 60/นาที/user) ──────
// token-bucket แบบ sliding window แยก read/write — ถ้าใกล้เต็มจะ "หน่วง" ให้เอง
// (ไม่ลดจำนวน call แค่กระจายจังหวะ) เผื่อ margin ไว้ที่ 50 (ต่ำกว่า 60 จริง)
class RateBucket {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.times = []; }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter(t => now - t < this.windowMs);
      if (this.times.length < this.max) { this.times.push(now); return; }
      const wait = this.windowMs - (now - this.times[0]) + 25;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
// เผื่อ margin มาก เพราะบอท + แดชบอร์ด (คนละโปรเซส) ใช้ quota ก้อนเดียวกัน (60/นาที/user)
const READ_BUCKET = new RateBucket(40, 60000);
const WRITE_BUCKET = new RateBucket(45, 60000);

// usage ปัจจุบันของ rate limiter (ในโปรเซสนี้) — ไว้โชว์ quota meter บนแดชบอร์ด
function getQuotaUsage() {
  const now = Date.now();
  const live = (b) => b.times.filter(t => now - t < b.windowMs).length;
  return {
    read: { used: live(READ_BUCKET), limit: READ_BUCKET.max },
    write: { used: live(WRITE_BUCKET), limit: WRITE_BUCKET.max },
    hardLimit: 60,
  };
}

// ครอบ google.sheets() ให้ทุกเมธอด await token ก่อนยิงจริง (จุดเรียกในไฟล์นี้ไม่ต้องแก้)
function sheetsClient(auth) {
  const real = google.sheets({ version: 'v4', auth });
  const ss = real.spreadsheets;
  const v = ss.values;
  const R = (fn, ctx) => async (...a) => { await READ_BUCKET.acquire(); return fn.apply(ctx, a); };
  const W = (fn, ctx) => async (...a) => { await WRITE_BUCKET.acquire(); return fn.apply(ctx, a); };
  return {
    spreadsheets: {
      get: R(ss.get, ss),
      batchUpdate: W(ss.batchUpdate, ss),
      create: ss.create ? W(ss.create, ss) : undefined,
      values: {
        get: R(v.get, v),
        batchGet: R(v.batchGet, v),
        update: W(v.update, v),
        append: W(v.append, v),
        clear: W(v.clear, v),
        batchUpdate: W(v.batchUpdate, v),
      },
    },
  };
}

// ─── Color Palette ───────────────────────────────────────────────────────────
// Colors are in {red, green, blue} format (0.0–1.0)
const COLORS = {
  // Account tab header: deep indigo
  headerBg:    { red: 0.165, green: 0.192, blue: 0.459 },
  headerText:  { red: 1,     green: 1,     blue: 1     },
  // Even rows
  rowEven:     { red: 0.929, green: 0.945, blue: 1.0   },
  // Odd rows (white-ish)
  rowOdd:      { red: 1,     green: 1,     blue: 1     },
  // Amount column highlight
  amountBg:    { red: 0.851, green: 0.918, blue: 0.827 },
  amountText:  { red: 0.063, green: 0.290, blue: 0.063 },
  // Transfer type colors
  typeTransfer:{ red: 0.788, green: 0.902, blue: 1.0   },
  typeWithdraw:{ red: 1.0,   green: 0.878, blue: 0.788 },
  typeDeposit: { red: 0.788, green: 0.965, blue: 0.824 },
  typeBill:    { red: 1.0,   green: 0.953, blue: 0.788 },
  // Summary tab header: deep teal
  summaryHeader: { red: 0.063, green: 0.369, blue: 0.369 },
};

const SYSTEM_TAB_NAME = '_system';
const JOBS_TAB_NAME = '_jobs';
const REVIEW_TAB_NAME = '_review';
const CONFIG_TAB_NAME = '_config';
const AUDIT_TAB_NAME = '_audit';
const auditTabReady = new Set();
const configTabReady = new Set();
const reviewTabReady = new Set();
const jobsTabReady = new Set();
const systemTabReady = new Set();
const systemStateCache = new Map();
const systemRowCount = new Map(); // จำนวนแถวที่เขียน _system ล่าสุด (ใช้ตัดสินใจว่าต้อง clear ไหม)

function getLast4FromTabName(tabName) {
  // รองรับเลขท้ายบัญชี 2-6 หลัก (ไม่ใช่แค่ 4) — แท็บชื่อ บัญชี_<digits>
  const match = String(tabName || '').match(/_(\d{2,6})$/);
  return match ? match[1] : null;
}

function isAccountTab(tabName) {
  return Boolean(getLast4FromTabName(tabName)) && String(tabName || '').includes('_');
}

function isSystemTab(tabName) {
  const t = String(tabName || '');
  return t === SYSTEM_TAB_NAME || t === JOBS_TAB_NAME || t === REVIEW_TAB_NAME || t === CONFIG_TAB_NAME || t === AUDIT_TAB_NAME;
}

function getAccountTabNamesFromMeta(meta) {
  return meta.data.sheets
    .map(s => s.properties.title)
    .filter(title => isAccountTab(title) && !isSystemTab(title));
}

async function ensureSystemTab(sheets, spreadsheetId) {
  if (systemTabReady.has(spreadsheetId)) {
    return { title: SYSTEM_TAB_NAME };
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === SYSTEM_TAB_NAME);
  if (existing) {
    systemTabReady.add(spreadsheetId);
    return existing.properties;
  }

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: SYSTEM_TAB_NAME,
            hidden: true,
            gridProperties: { frozenRowCount: 1 },
          },
        },
      }],
    },
  });

  const sheetId = response.data.replies?.[0]?.addSheet?.properties?.sheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SYSTEM_TAB_NAME}!A1:C1`,
    valueInputOption: 'RAW',
    resource: { values: [['key', 'value', 'updated_at']] },
  });

  systemTabReady.add(spreadsheetId);
  return { title: SYSTEM_TAB_NAME, sheetId };
}

function parseSystemRows(rows = []) {
  const state = {};
  rows.slice(1).forEach(row => {
    if (!row[0]) return;
    state[row[0]] = {
      value: row[1] || '',
      updatedAt: row[2] || '',
    };
  });
  return state;
}

async function getSystemState(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  await ensureSystemTab(sheets, spreadsheetId);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SYSTEM_TAB_NAME}!A:C`,
  });

  const parsed = parseSystemRows(response.data.values || []);
  systemStateCache.set(spreadsheetId, parsed);
  return parsed;
}

async function updateSystemState(auth, spreadsheetId, updates) {
  const sheets = sheetsClient(auth);
  await ensureSystemTab(sheets, spreadsheetId);

  const current = systemStateCache.get(spreadsheetId) || {};
  const now = new Date().toISOString();
  Object.entries(updates).forEach(([key, value]) => {
    current[key] = { value: String(value ?? ''), updatedAt: now };
  });
  systemStateCache.set(spreadsheetId, current);

  const rows = Object.entries(current)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, item.value, item.updatedAt || now]);

  // clear เฉพาะตอนจำนวน key "ลดลง" (กันแถวเก่าค้าง) — ปกติ key คงที่/เพิ่มขึ้น
  // จึงข้าม clear ได้ ประหยัด 1 write ต่อครั้ง (ลดการเขียน _system ลงครึ่งหนึ่ง)
  const prevCount = systemRowCount.get(spreadsheetId);
  if (prevCount === undefined || rows.length < prevCount) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${SYSTEM_TAB_NAME}!A2:C`,
    });
  }

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SYSTEM_TAB_NAME}!A2:C${rows.length + 1}`,
      valueInputOption: 'RAW',
      resource: { values: rows },
    });
  }
  systemRowCount.set(spreadsheetId, rows.length);

  return current;
}

async function updateBotHeartbeat(auth, spreadsheetId, extra = {}) {
  return updateSystemState(auth, spreadsheetId, {
    bot_status: extra.status || 'online',
    bot_last_seen: new Date().toISOString(),
    bot_pid: process.pid,
    bot_host: require('os').hostname(),
    ...extra,
  });
}

async function recordTokenUsage(auth, spreadsheetId, tokens = 0, count = 1, provider = '') {
  const state = systemStateCache.get(spreadsheetId) || await getSystemState(auth, spreadsheetId);
  const totalTokens = Number(state.usage_total_tokens?.value || 0) + Number(tokens || 0);
  const totalCount = Number(state.usage_count?.value || 0) + Number(count || 0);
  const updates = { usage_total_tokens: totalTokens, usage_count: totalCount };
  // นับแยกตามค่าย (gemini/openai/typhoon) เพื่อแสดงบนแดชบอร์ด
  const prov = String(provider || '').toLowerCase().replace(/[^a-z]/g, '');
  if (prov) {
    updates[`usage_tokens_${prov}`] = Number(state[`usage_tokens_${prov}`]?.value || 0) + Number(tokens || 0);
    updates[`usage_count_${prov}`] = Number(state[`usage_count_${prov}`]?.value || 0) + Number(count || 0);
  }
  await updateSystemState(auth, spreadsheetId, updates);
  return { totalTokens, count: totalCount };
}

// บันทึกสถิติต่อ provider จาก attempts ของ OCR (1 write ต่อสลิป)
// นับ: tokens, calls (ครั้งที่ลอง), ok (จับครบ), err (error/exception) แยกตามค่าย
async function recordProviderUsage(auth, spreadsheetId, attempts = [], slipDone = true, status = '') {
  const state = systemStateCache.get(spreadsheetId) || await getSystemState(auth, spreadsheetId);
  const cur = (k) => Number(state[k]?.value || 0);
  const updates = {};
  const bump = (k, n) => { updates[k] = (updates[k] != null ? updates[k] : cur(k)) + n; };
  let totalTok = 0;
  (attempts || []).forEach(a => {
    const prov = String(a.provider || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!prov) return;
    const tok = Number(a.tokens || 0);
    totalTok += tok;
    bump(`usage_tokens_${prov}`, tok);
    bump(`usage_calls_${prov}`, 1);
    if (a.ok) bump(`usage_ok_${prov}`, 1);
    if (a.error) bump(`usage_err_${prov}`, 1);
  });
  bump('usage_total_tokens', totalTok);
  if (slipDone) bump('usage_count', 1);
  // นับผลรวมระดับสลิป: auto(จับเองด้วยตัวหลัก) / review(ใช้สำรอง) / manual(อ่านไม่ครบ)
  const st = ['auto', 'review', 'manual'].includes(status) ? status : null;
  if (st) bump(`usage_status_${st}`, 1);
  await updateSystemState(auth, spreadsheetId, updates);
}

// ─── Audit log (ใครทำอะไร: ยืนยันคิว/แก้/ล้าง) — JSON array ใน _audit!A1 (เก็บ 300 ล่าสุด) ──
async function ensureAuditTab(sheets, spreadsheetId) {
  if (auditTabReady.has(spreadsheetId)) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  if (!meta.data.sheets.find(s => s.properties.title === AUDIT_TAB_NAME)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: AUDIT_TAB_NAME, hidden: true } } }] } });
  }
  auditTabReady.add(spreadsheetId);
}
async function getAuditLog(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${AUDIT_TAB_NAME}!A1` });
    const raw = r.data.values && r.data.values[0] && r.data.values[0][0];
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
async function appendAudit(auth, spreadsheetId, entry) {
  const sheets = sheetsClient(auth);
  try {
    await ensureAuditTab(sheets, spreadsheetId);
    const arr = await getAuditLog(auth, spreadsheetId);
    arr.unshift({ at: new Date().toISOString(), user: entry.user || '-', action: entry.action || '', detail: entry.detail || '' });
    const trimmed = arr.slice(0, 300);
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${AUDIT_TAB_NAME}!A1`, valueInputOption: 'RAW', resource: { values: [[JSON.stringify(trimmed)]] } });
  } catch (e) { console.error('appendAudit failed:', e.message); }
}

async function setTokenUsage(auth, spreadsheetId, totalTokens = 0, count = 0) {
  await updateSystemState(auth, spreadsheetId, {
    usage_total_tokens: Number(totalTokens || 0),
    usage_count: Number(count || 0),
  });
  return { totalTokens: Number(totalTokens || 0), count: Number(count || 0) };
}

// ─── Jobs snapshot (สำหรับให้ Vercel อ่านหน้าคิวแบบ near-realtime) ──────────────
async function ensureJobsTab(sheets, spreadsheetId) {
  if (jobsTabReady.has(spreadsheetId)) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === JOBS_TAB_NAME);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: JOBS_TAB_NAME, hidden: true } } }] },
    });
  }
  jobsTabReady.add(spreadsheetId);
}

// บอท local เขียน snapshot รายการงาน (jobs + stats) เป็น JSON ก้อนเดียวลง _jobs!A1
async function setJobsSnapshot(auth, spreadsheetId, payload) {
  const sheets = sheetsClient(auth);
  await ensureJobsTab(sheets, spreadsheetId);
  let jobs = payload.jobs || [];
  let json = JSON.stringify({ ...payload, jobs });
  // กันเกินลิมิตเซลล์ (~50k chars) → ตัดงานเก่าออก (เก็บงานใหม่ๆ ไว้)
  while (json.length > 48000 && jobs.length > 1) {
    jobs = jobs.slice(0, Math.ceil(jobs.length / 2));
    json = JSON.stringify({ ...payload, jobs });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${JOBS_TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [[json]] },
  });
}

async function getJobsSnapshot(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${JOBS_TAB_NAME}!A1` });
    const raw = r.data.values && r.data.values[0] && r.data.values[0][0];
    return raw ? JSON.parse(raw) : { jobs: [], stats: {} };
  } catch (_) {
    return { jobs: [], stats: {} };
  }
}

// ─── Review queue (คิวรอตรวจ — เก็บเป็น JSON array ก้อนเดียวใน _review!A1) ──────────
// สลิปที่ใช้ "ตัวสำรอง" จับได้ หรือจับไม่ครบ → เข้าคิวนี้ ให้คนยืนยัน/แก้บนเว็บก่อนบันทึก
async function ensureReviewTab(sheets, spreadsheetId) {
  if (reviewTabReady.has(spreadsheetId)) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === REVIEW_TAB_NAME);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: REVIEW_TAB_NAME, hidden: true } } }] },
    });
  }
  reviewTabReady.add(spreadsheetId);
}

async function getReviewQueue(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${REVIEW_TAB_NAME}!A1` });
    const raw = r.data.values && r.data.values[0] && r.data.values[0][0];
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

async function setReviewQueue(auth, spreadsheetId, items) {
  const sheets = sheetsClient(auth);
  await ensureReviewTab(sheets, spreadsheetId);
  let arr = Array.isArray(items) ? items : [];
  let json = JSON.stringify(arr);
  while (json.length > 48000 && arr.length > 1) { arr = arr.slice(-Math.ceil(arr.length / 2)); json = JSON.stringify(arr); }
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${REVIEW_TAB_NAME}!A1`, valueInputOption: 'RAW', resource: { values: [[json]] },
  });
}

async function addReviewItem(auth, spreadsheetId, item) {
  const arr = await getReviewQueue(auth, spreadsheetId);
  if (item.fileHash && arr.some(x => x.fileHash && x.fileHash === item.fileHash)) return arr; // กันซ้ำ
  arr.push(item);
  await setReviewQueue(auth, spreadsheetId, arr);
  return arr;
}

async function removeReviewItem(auth, spreadsheetId, id) {
  const arr = await getReviewQueue(auth, spreadsheetId);
  const next = arr.filter(x => x.id !== id);
  await setReviewQueue(auth, spreadsheetId, next);
  return next;
}

// ─── OCR config (โมเดลหลัก/สำรอง — ตั้งบนเว็บ, บอทอ่านอย่างเดียว) ─────────────────
// เก็บแยกใน _config!A1 (JSON) เพื่อไม่ให้ชนกับ _system ที่บอทเขียน heartbeat ทับ
async function ensureConfigTab(sheets, spreadsheetId) {
  if (configTabReady.has(spreadsheetId)) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(s => s.properties.title === CONFIG_TAB_NAME);
  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: CONFIG_TAB_NAME, hidden: true } } }] },
    });
  }
  configTabReady.add(spreadsheetId);
}

// ข้อความแจ้ง "ล้างข้อมูลทั้งหมดสำเร็จ" — ใช้ร่วมกันทั้งล้างผ่านเว็บและผ่าน Telegram (ให้เหมือนกัน)
function buildWipeSummaryText({ rows = 0, driveCount = 0 } = {}) {
  return [
    '🧹 ล้างข้อมูลทั้งหมดสำเร็จแล้ว',
    '━━━━━━━━━━━━━━',
    `📊 รายการในชีต: ${Number(rows || 0)}`,
    `🗂️ ไฟล์ใน Drive: ${Number(driveCount || 0)}`,
    '🔢 token / จำนวนรูป: รีเซ็ตเป็น 0',
    '📋 คิวงาน + คิวรอตรวจ: ล้างแล้ว',
    '',
    'เริ่มต้นใหม่พร้อมใช้งานค่ะ ✨',
  ].join('\n');
}

async function getOcrConfig(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${CONFIG_TAB_NAME}!A1` });
    const raw = r.data.values && r.data.values[0] && r.data.values[0][0];
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

async function setOcrConfig(auth, spreadsheetId, partial) {
  const sheets = sheetsClient(auth);
  await ensureConfigTab(sheets, spreadsheetId);
  const current = await getOcrConfig(auth, spreadsheetId);
  const next = { ...current, ...partial };
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${CONFIG_TAB_NAME}!A1`, valueInputOption: 'RAW', resource: { values: [[JSON.stringify(next)]] },
  });
  return next;
}

function formatDashboardSystemState(state = {}) {
  const totalTokens = Number(state.usage_total_tokens?.value || 0);
  const count = Number(state.usage_count?.value || 0);
  // สถิติต่อค่าย: token/ครั้ง/สำเร็จ/error/อัตราสำเร็จ
  const PROVIDERS = [
    { key: 'gemini', label: 'Gemini' },
    { key: 'typhoon', label: 'Typhoon' },
    { key: 'openai', label: 'GPT (OpenAI)' },
  ];
  const byProvider = PROVIDERS.map(p => {
    const tokens = Number(state[`usage_tokens_${p.key}`]?.value || 0);
    const calls = Number(state[`usage_calls_${p.key}`]?.value || 0);
    const ok = Number(state[`usage_ok_${p.key}`]?.value || 0);
    const err = Number(state[`usage_err_${p.key}`]?.value || 0);
    const successRate = calls > 0 ? Math.round((ok / calls) * 100) : null;
    return { key: p.key, label: p.label, tokens, calls, ok, err, successRate };
  }).filter(p => p.calls > 0 || p.tokens > 0);
  const lastSeen = state.bot_last_seen?.value || '';
  const lastSeenMs = lastSeen ? Date.parse(lastSeen) : 0;
  const heartbeatAgeMs = lastSeenMs ? Date.now() - lastSeenMs : null;
  const botOnline = heartbeatAgeMs !== null && heartbeatAgeMs >= 0 && heartbeatAgeMs <= 90000;

  return {
    botOnline,
    botStatus: state.bot_status?.value || (botOnline ? 'online' : 'unknown'),
    botLastSeen: lastSeen,
    botLastSeenAgeMs: heartbeatAgeMs,
    botHost: state.bot_host?.value || '',
    botPid: state.bot_pid?.value || '',
    usage: { totalTokens, count, byProvider, health: {
      auto: Number(state.usage_status_auto?.value || 0),
      review: Number(state.usage_status_review?.value || 0),
      manual: Number(state.usage_status_manual?.value || 0),
    } },
    quota: getQuotaUsage(),
    queue: {
      waiting: Number(state.queue_waiting?.value || 0),
      active: Number(state.queue_active?.value || 0),
      concurrency: Number(state.queue_concurrency?.value || 1),
      persistedTotal: Number(state.queue_persisted_total?.value || 0),
      persistedRecoverable: Number(state.queue_persisted_recoverable?.value || 0),
      persistedFailed: Number(state.queue_persisted_failed?.value || 0),
      persistedDone: Number(state.queue_persisted_done?.value || 0),
      currentTaskId: state.queue_current_task_id?.value || '',
      currentChatId: state.queue_current_chat_id?.value || '',
      currentStep: state.queue_current_step?.value || '',
      currentStartedAt: state.queue_current_started_at?.value || '',
      processedCount: Number(state.queue_processed_count?.value || 0),
      failedCount: Number(state.queue_failed_count?.value || 0),
      lastSuccessAt: state.queue_last_success_at?.value || '',
      lastSuccessTaskId: state.queue_last_success_task_id?.value || '',
      lastErrorAt: state.queue_last_error_at?.value || '',
      lastError: state.queue_last_error?.value || '',
      lastErrorTaskId: state.queue_last_error_task_id?.value || '',
      lastRetryAt: state.queue_last_retry_at?.value || '',
      lastRetry: state.queue_last_retry?.value || '',
      lastRetryTaskId: state.queue_last_retry_task_id?.value || '',
      updatedAt: state.queue_updated_at?.value || '',
    },
  };
}

function getTabTheme(tabName) {
  let hash = 0;
  for (let i = 0; i < tabName.length; i++) hash = tabName.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash % 360);
  
  // HSL to RGB helper
  const hslToRgb = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r=0, g=0, b=0;
    if(h<60){ r=c; g=x; } else if(h<120){ r=x; g=c; } else if(h<180){ g=c; b=x; }
    else if(h<240){ g=x; b=c; } else if(h<300){ r=x; b=c; } else { r=c; b=x; }
    return { red: r+m, green: g+m, blue: b+m };
  };

  const tabColor = hslToRgb(hue, 0.8, 0.85); // bright pastel
  const headerBg = hslToRgb(hue, 0.6, 0.25); // dark deep color
  const rowEven = hslToRgb(hue, 0.3, 0.96);  // very light tint
  
  return { tabColor, headerBg, rowEven };
}

// ─── Build formatting requests for an account tab ────────────────────────────
function buildAccountTabFormatRequests(sheetId, tabName) {
  const requests = [];
  const theme = getTabTheme(tabName);

  // Set the sheet's tab color
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId: sheetId,
        tabColor: theme.tabColor
      },
      fields: 'tabColor'
    }
  });

  // 1. Header row background (row 0)
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: theme.headerBg,
          textFormat: {
            foregroundColor: COLORS.headerText,
            bold: true,
            fontSize: 11,
            fontFamily: 'Sarabun',
          },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'CLIP',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  });

  // 2. Freeze header row
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: { frozenRowCount: 1 },
      },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // 3. ระบายสีสลับแถว (data rows) ด้วย banding request เดียว
  //    เดิมวน push ทีละแถว ~500 requests → กิน write quota มหาศาล
  requests.push({
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 0, endColumnIndex: 9 },
        rowProperties: {
          firstBandColor: theme.rowEven,
          secondBandColor: COLORS.rowOdd,
        },
      },
    },
  });

  // 4. ฟอนต์ของ data rows ทั้งช่วง (request เดียว ไม่วนทีละแถว)
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 500 },
      cell: {
        userEnteredFormat: {
          textFormat: { fontSize: 10, fontFamily: 'Sarabun' },
          verticalAlignment: 'MIDDLE',
        },
      },
      fields: 'userEnteredFormat(textFormat,verticalAlignment)',
    },
  });

  // 5. Columns B–C (ยอดเงิน + ค่าธรรมเนียม) – right-aligned number format for data rows
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 1, endColumnIndex: 3 },
      cell: {
        userEnteredFormat: {
          textFormat: {
            bold: true,
            fontSize: 10,
            fontFamily: 'Sarabun',
            foregroundColor: COLORS.amountText,
          },
          horizontalAlignment: 'RIGHT',
          numberFormat: { type: 'NUMBER', pattern: '#,##0.00' },
        },
      },
      fields: 'userEnteredFormat(textFormat,horizontalAlignment,numberFormat)',
    },
  });

  // 6. Column A (date) – center aligned
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 500, startColumnIndex: 0, endColumnIndex: 1 },
      cell: {
        userEnteredFormat: {
          horizontalAlignment: 'CENTER',
          textFormat: { fontSize: 10, fontFamily: 'Sarabun' },
        },
      },
      fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
    },
  });

  // (ตัด autoResizeDimensions ออก — ซ้ำซ้อนกับการตั้งความกว้างคงที่ด้านล่าง + ลด request)

  // 8. Set row height for header
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 40 },
      fields: 'pixelSize',
    },
  });

  // 9. Set row height for data rows
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 500 },
      properties: { pixelSize: 28 },
      fields: 'pixelSize',
    },
  });

  // 10. Set fixed column widths (pixels)
  // A=วัน-เดือนเวลา B=ยอด C=ค่าธรรมเนียม D=ประเภท E=ผู้โอน/ผู้รับ F=ธนาคาร G=ผู้ส่ง H=ลิงก์ I=Hash
  const colWidths = [140, 100, 90, 90, 160, 70, 100, 220, 80];
  colWidths.forEach((pixelSize, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    });
  });

  // 11. Add border to header
  requests.push({
    updateBorders: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 },
      bottom: { style: 'SOLID_MEDIUM', color: { red: 0.1, green: 0.1, blue: 0.4 } },
    },
  });

  return requests;
}

// ─── Build formatting requests for the summary tab ───────────────────────────
function buildSummaryTabFormatRequests(sheetId) {
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: COLORS.summaryHeader,
            textFormat: {
              foregroundColor: COLORS.headerText,
              bold: true,
              fontSize: 11,
              fontFamily: 'Sarabun',
            },
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 200 },
        cell: {
          userEnteredFormat: {
            textFormat: { fontSize: 10, fontFamily: 'Sarabun' },
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(textFormat,verticalAlignment)',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 40 },
        fields: 'pixelSize',
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 200 },
        properties: { pixelSize: 28 },
        fields: 'pixelSize',
      },
    },
  ];
}

// ─── Apply formatting to a specific tab by name ──────────────────────────────
async function applySheetFormatting(sheetsApi, spreadsheetId, tabName, isSummary = false) {
  try {
    const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
    const sheet = meta.data.sheets.find(s => s.properties.title === tabName);
    if (!sheet) return;
    const sheetId = sheet.properties.sheetId;
    const requests = isSummary
      ? buildSummaryTabFormatRequests(sheetId)
      : buildAccountTabFormatRequests(sheetId, tabName);

    // ยิง batchUpdate "ครั้งเดียว" (1 write quota) — เดิมแบ่งทีละ 20 ทำให้กิน write quota หลายเท่า
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests },
    });
  } catch (err) {
    console.error(`⚠️ Format error on tab "${tabName}":`, err.message);
  }
}

// ─── Apply formatting to ALL existing tabs ───────────────────────────────────
async function formatAllTabs(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const allSheets = meta.data.sheets;

  for (const sheet of allSheets) {
    const title = sheet.properties.title;
    const sheetId = sheet.properties.sheetId;
    const isSummary = title === 'สรุปรวม';
    const isAccount = title.startsWith('บัญชี_');
    if (!isSummary && !isAccount) continue;

    try {
      const requests = isSummary
        ? buildSummaryTabFormatRequests(sheetId)
        : buildAccountTabFormatRequests(sheetId, title);

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
      console.log(`🎨 ตกแต่ง tab "${title}" สำเร็จ และลง log เรียบร้อย`);
    } catch (err) {
      console.error(`⚠️ Format error on tab "${title}":`, err.message);
    }
  }
}

// ─── Core functions ───────────────────────────────────────────────────────────

async function initSpreadsheet(auth) {
  const sheets = sheetsClient(auth);

  let spreadsheetId = process.env.SPREADSHEET_ID;

  if (!spreadsheetId) {
    console.log('No SPREADSHEET_ID found in .env. Creating a new Spreadsheet...');
    const resource = {
      properties: { title: 'Telegram Slip Bot Database' },
      sheets: [{
        properties: {
          title: 'สรุปรวม',
          gridProperties: { frozenRowCount: 1 },
        },
      }],
    };
    const response = await sheets.spreadsheets.create({ resource, fields: 'spreadsheetId' });
    spreadsheetId = response.data.spreadsheetId;
    console.log(`✅ New Spreadsheet created with ID: ${spreadsheetId}`);
    console.log(`📋 Spreadsheet URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(process.cwd(), '.env');
    fs.appendFileSync(envPath, `\nSPREADSHEET_ID="${spreadsheetId}"\n`);
    console.log(`✅ Auto-saved SPREADSHEET_ID to .env!`);

    // Write summary header
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'สรุปรวม!A1:F1',
      valueInputOption: 'RAW',
      resource: { values: [['เลข 4 ตัวท้าย', 'ชื่อบัญชี', 'ธนาคาร', 'ยอดโอนวันนี้', 'ยอดกดเงินวันนี้', 'ยอดรวมทั้งหมด']] },
    });

    // Format the summary tab
    await applySheetFormatting(sheets, spreadsheetId, 'สรุปรวม', true);
  } else {
    // Existing tabs are already formatted. Re-formatting every restart can exhaust
    // Google Sheets quota and delay live dashboard status updates.
    try {
      if (String(process.env.FORMAT_SHEETS_ON_STARTUP || '').toLowerCase() === 'true') {
        await formatAllTabs(auth, spreadsheetId);
      }
    } catch (e) {
      console.warn('⚠️ Could not format existing tabs:', e.message);
    }
  }

  return spreadsheetId;
}

async function getOrCreateAccountTab(auth, spreadsheetId, last4, bank) {
  const sheets = sheetsClient(auth);
  const tabName = `บัญชี_${last4}`;

  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const existingSheets = response.data.sheets.map(s => s.properties.title);

  if (existingSheets.includes(tabName)) {
    return tabName;
  }

  // Create new tab
  console.log(`📋 Creating new tab: ${tabName}`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [{
        addSheet: {
          properties: {
            title: tabName,
            gridProperties: { frozenRowCount: 1 },
          },
        },
      }],
    },
  });

  // Write header row
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1:K1`,
    valueInputOption: 'RAW',
    resource: { values: [['วัน-เดือน เวลา', 'ยอดเงิน', 'ค่าธรรมเนียม', 'ประเภท', 'ผู้โอน/ผู้รับ', 'ธนาคาร', 'ผู้ส่ง TG', 'ลิงก์รูป', 'Hash', 'เลขบัญชีผู้รับ', 'หมายเหตุ']] },
  });

  // Apply beautiful formatting
  await applySheetFormatting(sheets, spreadsheetId, tabName, false);
  console.log(`🎨 ตกแต่ง tab "${tabName}" สำเร็จ`);

  // Add to summary tab
  const summaryResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'สรุปรวม!A:A',
  });
  const accounts = summaryResponse.data.values ? summaryResponse.data.values.flat() : [];
  if (!accounts.includes(last4)) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'สรุปรวม!A:A',
      valueInputOption: 'RAW',
      resource: { values: [[last4, `บัญชี ${last4}`, bank || '-', '0', '0', '0']] },
    });
  }

  return tabName;
}

async function checkDuplicate(auth, spreadsheetId, hash, last4 = null) {
  const sheets = sheetsClient(auth);

  // รู้เลขบัญชีแล้ว → อ่านเฉพาะแท็บนั้น (1 read) ไม่ต้องวนทุกแท็บ
  if (last4) {
    const tabName = `บัญชี_${last4}`;
    try {
      const data = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!I:I` });
      const hashes = data.data.values ? data.data.values.flat() : [];
      if (hashes.includes(hash)) return { duplicate: true, tabName };
    } catch (_) {}
    return { duplicate: false };
  }

  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetNames = getAccountTabNamesFromMeta(response);

  for (const tabName of sheetNames) {
    try {
      const data = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!I:I`,
      });
      const hashes = data.data.values ? data.data.values.flat() : [];
      if (hashes.includes(hash)) return { duplicate: true, tabName };
    } catch (_) {}
  }
  return { duplicate: false };
}

async function appendSlip(auth, spreadsheetId, last4, data) {
  const sheets = sheetsClient(auth);
  const tabName = `บัญชี_${last4}`;

  // idempotent: ถ้า hash นี้อยู่ในแท็บแล้ว (เช่น append สำเร็จรอบก่อนแต่ขั้นถัดไป fail แล้วโดน retry)
  // ให้ "ข้ามการเขียน" เพื่อกันแถวซ้ำเด็ดขาด
  if (data.hash) {
    try {
      const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!I:I` });
      const hashes = existing.data.values ? existing.data.values.flat() : [];
      if (hashes.includes(data.hash)) {
        scheduleSummarySync(auth, spreadsheetId);
        return;
      }
    } catch (_) { /* อ่านไม่ได้ก็เขียนต่อ พึ่ง dedup ชั้นอื่น */ }
  }

  // Append the row. ใช้ RAW เพื่อให้วันที่ "YYYY-MM-DD HH:mm" เก็บเป็นข้อความตรงๆ
  // (กัน Google Sheets แปลงเป็น date serial แล้วอ่านกลับมาคนละรูปแบบจนกรอง "วันนี้" พลาด)
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A:J`,
    valueInputOption: 'RAW',
    resource: {
      values: [[
        data.date,
        data.amount,
        Number(data.fee || 0),
        data.tx_type,
        data.counterparty || '-',
        data.bank,
        data.senderTG,
        data.driveLink,
        data.hash,
        data.recipient_last4 || '', // J = เลขบัญชีผู้รับ
      ]],
    },
  });

  // sync แบบ debounce + best-effort (ไม่ throw) → appendSlip จะไม่ล้มเพราะ sync จน retry เขียนซ้ำ
  scheduleSummarySync(auth, spreadsheetId);
}

function getTodayStr(targetDate = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(targetDate);
  const p = {};
  parts.forEach(pt => (p[pt.type] = pt.value));
  return `${p.year}-${p.month}-${p.day}`;
}

// จัดหมวดประเภทรายการจากคำดิบบนสลิป (ไทย/อังกฤษ/โค้ดย่อธนาคาร)
// ลำดับเช็คสำคัญ: ถอน → ชำระบิล → ฝาก/รับ → โอน (กัน "รับโอน"=ฝาก, "โอน"=โอน ไม่ปนกัน)
function categorizeTxType(type) {
  const s = String(type || '');
  const t = s.toLowerCase();
  // คำไทยเช็คกับข้อความเดิม, คำอังกฤษเช็คกับ lowercase
  const has = (...kw) => kw.some(k => (/[ก-๙]/.test(k) ? s.includes(k) : t.includes(k)));

  if (has('ถอน', 'กดเงิน', 'กดสด', 'withdraw', 'fast cash', 'cash wd', 'cardless', 'atm cash')) return 'withdraw';
  if (has('ชำระ', 'จ่ายบิล', 'จ่ายค่า', 'bill payment', 'bill pay', 'billpay', 'pay bill', 'payment')) return 'bill';
  if (has('ฝาก', 'รับโอน', 'รับเงิน', 'เงินเข้า', 'เงินรับ', 'deposit', 'received', 'money in')) return 'deposit';
  if (has('โอน', 'พร้อมเพย์', 'transfer', 'trf', 'orf', 'promptpay', 'prompt pay', 'ift', 'bahtnet')) return 'transfer';
  return 'other';
}

async function getReport(auth, spreadsheetId, targetLast4 = null, targetDate = null) {
  const sheets = sheetsClient(auth);
  const response = await sheets.spreadsheets.get({ spreadsheetId });
  let sheetNames = getAccountTabNamesFromMeta(response);
  if (targetLast4) sheetNames = sheetNames.filter(t => getLast4FromTabName(t) === targetLast4);

  const report = {};
  // ตัวกรองวันที่: 'all'=ทุกวัน, 'YYYY-MM-DD~YYYY-MM-DD'=ช่วงวัน, 'YYYY-MM-DD'=วันเดียว, null=วันนี้
  let matchDate;
  if (targetDate === 'all') {
    matchDate = () => true;
  } else if (typeof targetDate === 'string' && targetDate.includes('~')) {
    const [from, to] = targetDate.split('~');
    matchDate = (d) => d >= from && d <= to; // ISO date string เทียบช่วงได้ตรงๆ
  } else {
    const day = targetDate || getTodayStr();
    matchDate = (d) => d === day;
  }
  if (sheetNames.length === 0) return report;

  // สะสมยอดต่อ "ผู้รับ" — จับกลุ่มด้วย "เลขบัญชีปลายทาง" เป็นหลัก (3 ตัวท้าย กัน OCR 3/4 หลัก)
  // เลขตรง = คนเดียวกัน แม้ชื่อ OCR เพี้ยน; ถ้าไม่มีเลขค่อย fallback ชื่อ (ลบช่องว่าง+คำนำหน้า)
  const allRecRecords = []; // เก็บ record ผู้รับทุกใบ (global) ไว้จับกลุ่มแบบ union-find
  const feesByBank = {}; // ค่าธรรมเนียมรวมแยกตามธนาคาร
  // ลบคำนำหน้า — เรียง "ยาวก่อนสั้น" + ใช้ \b กันแมตช์บางส่วน (เช่น MR ไปตัด MRS)
  const stripHonor = (name) => String(name || '').trim().replace(/\s+/g, ' ')
    .replace(/^(นางสาว|นาง|นาย|น\.?ส\.?|ด\.?ช\.?|ด\.?ญ\.?)\s*/i, '')
    .replace(/^(mister|mrs|miss|mr|ms)\b\.?\s*/i, '')
    .trim();
  const nameKey = (name) => stripHonor(name).toLowerCase().replace(/[\s.\-_]/g, '');
  const last3 = (s) => { const d = String(s || '').replace(/\D/g, ''); return d ? d.slice(-3) : ''; };
  const pushRec = (records, name, amount, rlast4, fee) => {
    const nk = nameKey(name);
    const dk = last3(rlast4);
    if (!nk && !dk) return; // ไม่มีทั้งชื่อและเลข → ข้าม
    records.push({ nk, dk, amount, fee: Number(fee) || 0, disp: stripHonor(name) || String(name).trim() || '-', rlast4: String(rlast4 || '').replace(/\D/g, '') });
  };
  // จับกลุ่มผู้รับด้วย union-find: รวมเป็นคนเดียวกันถ้า "ชื่อตรง" หรือ "เลข 3 ตัวท้ายตรง"
  // (กันทั้งเคสชื่อ OCR เพี้ยน-เลขตรง และเคสบางใบไม่มีเลข-ชื่อตรง ที่เคยแตกเป็น 2 ก้อน)
  const groupRecipients = (records) => {
    const parent = {};
    const ensure = (k) => { if (!(k in parent)) parent[k] = k; };
    const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
    const union = (a, b) => { ensure(a); ensure(b); const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    records.forEach(r => {
      const keys = [];
      if (r.nk) keys.push('n:' + r.nk);
      if (r.dk) keys.push('d:' + r.dk);
      keys.forEach(ensure);
      for (let i = 1; i < keys.length; i++) union(keys[0], keys[i]);
    });
    const groups = {};
    records.forEach(r => {
      const k0 = r.nk ? 'n:' + r.nk : 'd:' + r.dk;
      const root = find(k0);
      if (!groups[root]) groups[root] = { total: 0, count: 0, fee: 0, last4: '', _v: {} };
      const g = groups[root];
      g.total += r.amount; g.count += 1; g.fee += r.fee;
      g._v[r.disp] = (g._v[r.disp] || 0) + 1;
      if (r.rlast4 && r.rlast4 !== 'null' && r.rlast4.length > (g.last4 || '').length) g.last4 = r.rlast4;
    });
    // เลือกชื่อแสดง: variant พบบ่อยสุด → ช่องว่างน้อยสุด → ยาวสุด
    return Object.values(groups).map(r => {
      const best = Object.entries(r._v).sort((a, b) =>
        b[1] - a[1] || (a[0].split(' ').length - b[0].split(' ').length) || (b[0].length - a[0].length))[0];
      return { name: best ? best[0] : '-', last4: r.last4 || '', total: r.total, fee: r.fee || 0, count: r.count };
    }).sort((a, b) => b.total - a.total);
  };

  // อ่านทุกแท็บใน request เดียว (batchGet) แทนการวนอ่านทีละแท็บ → ลด read quota จาก N เหลือ 1
  let valueRanges = [];
  try {
    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: sheetNames.map(t => `'${t}'!A:J`),
    });
    valueRanges = resp.data.valueRanges || [];
  } catch (err) {
    console.error('getReport batchGet error:', err.message);
    return report;
  }

  sheetNames.forEach((tabName, idx) => {
    const last4 = getLast4FromTabName(tabName);
    const values = valueRanges[idx]?.values || [];

    let transferSum = 0, withdrawSum = 0, billSum = 0, depositSum = 0, otherSum = 0;
    let transferCount = 0, withdrawCount = 0, billCount = 0, depositCount = 0, otherCount = 0;
    let bank = '';
    let feeSum = 0;
    const details = [];
    const acctRecRecords = []; // ผู้รับเฉพาะบัญชีนี้

    values.slice(1).forEach(row => {
      if (!row[0]) return;
      const rowDate = row[0].split(' ')[0];
      if (!matchDate(rowDate)) return;

      // คอลัมน์: A=วันที่ B=ยอด C=ค่าธรรมเนียม D=ประเภท E=ผู้รับ F=ธนาคาร … J=เลขบัญชีผู้รับ
      const amount = parseFloat(String(row[1] || '0').replace(/,/g, '')) || 0;
      const rowFee = parseFloat(String(row[2] || '0').replace(/,/g, '')) || 0;
      feeSum += rowFee;
      const rowBank = String(row[5] || '-').trim() || '-';
      if (rowFee > 0) feesByBank[rowBank] = (feesByBank[rowBank] || 0) + rowFee;
      const type = String(row[3] || '');
      const counterparty = row[4] || '-';
      const recipientLast4 = row[9] || ''; // คอลัมน์ J
      if (!bank && row[5]) bank = String(row[5]).trim();
      pushRec(allRecRecords, counterparty, amount, recipientLast4, rowFee);
      pushRec(acctRecRecords, counterparty, amount, recipientLast4, rowFee);
      const time = row[0].split(' ')[1] || '';

      // จัดหมวดด้วยฟังก์ชันรวม (ครอบคลุมไทย/อังกฤษ/โค้ดย่อธนาคาร)
      const cat = categorizeTxType(type);
      if (cat === 'withdraw') {
        withdrawSum += amount; withdrawCount++;
        details.push({ time, amount, type: 'กดเงิน', counterparty });
      } else if (cat === 'bill') {
        billSum += amount; billCount++;
        details.push({ time, amount, type: 'ชำระบิล', counterparty });
      } else if (cat === 'deposit') {
        depositSum += amount; depositCount++;
        details.push({ time, amount, type: 'ฝาก/รับเงิน', counterparty });
      } else if (cat === 'transfer') {
        transferSum += amount; transferCount++;
        details.push({ time, amount, type: 'โอน', counterparty });
      } else {
        otherSum += amount; otherCount++;
        details.push({ time, amount, type: type || 'อื่นๆ', counterparty });
      }
    });

    report[last4] = {
      bank,
      feeSum,
      transferSum, transferCount,
      withdrawSum, withdrawCount,
      billSum, billCount,
      depositSum, depositCount,
      otherSum, otherCount,
      total: transferSum + withdrawSum + billSum + depositSum + otherSum,
      details,
      recipients: groupRecipients(acctRecRecords), // ผู้รับย่อยของบัญชีนี้
    };
  });

  // แนบสรุปผู้รับ (เรียงยอดมาก→น้อย) — ใช้ key ขึ้นต้น _ เพื่อให้ผู้บริโภคแยกออกจากบัญชีได้
  report._recipients = groupRecipients(allRecRecords);
  // สรุปค่าธรรมเนียม: รวม + แยกตามธนาคาร
  report._fees = {
    total: Object.values(feesByBank).reduce((s, v) => s + v, 0),
    byBank: Object.entries(feesByBank).map(([bank, amount]) => ({ bank, amount })).sort((a, b) => b.amount - a.amount),
  };

  return report;
}

// แนวโน้มรายวัน N วันล่าสุด: จำนวนสลิป + ยอดรวม ต่อวัน (อ่าน 1 batchGet)
async function getTrends(auth, spreadsheetId, days = 7) {
  const sheets = sheetsClient(auth);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetNames = getAccountTabNamesFromMeta(meta);
  // เตรียม bucket ของ N วันล่าสุด (ตามเวลาไทย)
  const buckets = {};
  const order = [];
  const today = new Date(getTodayStr() + 'T00:00:00+07:00');
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = getTodayStr(d);
    buckets[key] = { date: key, count: 0, amount: 0 };
    order.push(key);
  }
  if (sheetNames.length === 0) return order.map(k => buckets[k]);
  let valueRanges = [];
  try {
    const resp = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: sheetNames.map(t => `'${t}'!A:B`) });
    valueRanges = resp.data.valueRanges || [];
  } catch (e) { return order.map(k => buckets[k]); }
  valueRanges.forEach(vr => {
    (vr.values || []).slice(1).forEach(row => {
      if (!row[0]) return;
      const d = String(row[0]).split(' ')[0];
      if (buckets[d]) {
        buckets[d].count += 1;
        buckets[d].amount += parseFloat(String(row[1] || '0').replace(/,/g, '')) || 0;
      }
    });
  });
  return order.map(k => buckets[k]);
}

function formatReport(report, targetDate = null, targetLast4 = null) {
  const displayDate = targetDate || getTodayStr();

  const accountKeys = Object.keys(report).filter(k => !k.startsWith('_'));
  if (accountKeys.length === 0) {
    return `📭 ไม่พบข้อมูลสำหรับวันที่ ${displayDate}`;
  }

  let reply = `📊 รายงานประจำวันที่ ${displayDate}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  let totalTransfer = 0, totalWithdraw = 0, totalBill = 0, totalDeposit = 0, totalOther = 0, overallTotal = 0;

  for (const [last4, data] of Object.entries(report)) {
    if (String(last4).startsWith('_')) continue; // ข้าม _recipients ฯลฯ
    if (targetLast4) {
      reply += `💳 บัญชี ****${last4}\n`;
      const transfers = data.details.filter(d => d.type === 'โอน');
      const withdraws = data.details.filter(d => d.type === 'กดเงิน');
      const bills = data.details.filter(d => d.type === 'ชำระบิล');
      const deposits = data.details.filter(d => d.type === 'ฝาก/รับเงิน');
      const others = data.details.filter(d => !['โอน','กดเงิน','ชำระบิล','ฝาก/รับเงิน'].includes(d.type));

      if (transfers.length > 0) {
        reply += `\n🔄 รายการโอนเงิน:\n`;
        transfers.forEach(t => reply += `   ${t.time} | ${t.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} | → ${t.counterparty}\n`);
      }
      if (withdraws.length > 0) {
        reply += `\n🏧 รายการกดเงิน:\n`;
        withdraws.forEach(t => reply += `   ${t.time} | ${t.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} | ATM\n`);
      }
      if (bills.length > 0) {
        reply += `\n💳 ชำระบิล:\n`;
        bills.forEach(t => reply += `   ${t.time} | ${t.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} | ${t.counterparty}\n`);
      }
      if (deposits.length > 0) {
        reply += `\n📥 ฝาก/รับเงิน:\n`;
        deposits.forEach(t => reply += `   ${t.time} | ${t.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} | ← ${t.counterparty}\n`);
      }
      if (others.length > 0) {
        reply += `\n📝 อื่นๆ:\n`;
        others.forEach(t => reply += `   ${t.time} | ${t.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} | ${t.type} (${t.counterparty})\n`);
      }
      reply += `\n━━━━━━━━━━━━━━━━━━━━\n`;
      reply += `🔄 รวมโอน: ${data.transferSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.transferCount})\n`;
      reply += `🏧 รวมกดเงิน: ${data.withdrawSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.withdrawCount})\n`;
      if (data.billCount > 0) reply += `💳 รวมชำระบิล: ${data.billSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.billCount})\n`;
      if (data.depositCount > 0) reply += `📥 รวมฝาก/รับเงิน: ${data.depositSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.depositCount})\n`;
      if (data.otherCount > 0) reply += `📝 รวมอื่นๆ: ${data.otherSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.otherCount})\n`;
      reply += `💰 ยอดหมุนเวียนรวม: ${data.total.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n`;
    } else {
      reply += `💳 บัญชี ****${last4}\n`;
      if (data.transferCount > 0) reply += `   🔄 โอน: ${data.transferSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.transferCount})\n`;
      if (data.withdrawCount > 0) reply += `   🏧 กดเงิน: ${data.withdrawSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.withdrawCount})\n`;
      if (data.billCount > 0) reply += `   💳 ชำระบิล: ${data.billSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.billCount})\n`;
      if (data.depositCount > 0) reply += `   📥 ฝาก/รับ: ${data.depositSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.depositCount})\n`;
      if (data.otherCount > 0) reply += `   📝 อื่นๆ: ${data.otherSum.toLocaleString('en-US', { minimumFractionDigits: 2 })} (${data.otherCount})\n`;
      reply += `   📊 รวม: ${data.total.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n\n`;

      totalTransfer += data.transferSum;
      totalWithdraw += data.withdrawSum;
      totalBill += data.billSum;
      totalDeposit += data.depositSum;
      totalOther += data.otherSum;
      overallTotal += data.total;
    }
  }

  if (!targetLast4 && accountKeys.length > 1) {
    reply += `━━━━━━━━━━━━━━━━━━━━\n📊 รวมทุกบัญชี:\n`;
    if (totalTransfer > 0) reply += `   🔄 โอนเงิน: ${totalTransfer.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n`;
    if (totalWithdraw > 0) reply += `   🏧 กดเงิน: ${totalWithdraw.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n`;
    if (totalBill > 0) reply += `   💳 ชำระบิล: ${totalBill.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n`;
    if (totalDeposit > 0) reply += `   📥 ฝาก/รับเงิน: ${totalDeposit.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n`;
    if (totalOther > 0) reply += `   📝 อื่นๆ: ${totalOther.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n`;
    reply += `   💰 ยอดหมุนเวียนรวม: ${overallTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท\n`;
  }

  // สรุปยอดรวมต่อผู้รับ (ข้ามทุกบัญชี) — เฉพาะตอนดูภาพรวม
  if (!targetLast4 && Array.isArray(report._recipients) && report._recipients.length > 0) {
    reply += `\n━━━━━━━━━━━━━━━━━━━━\n👤 ยอดรวมต่อผู้รับ:\n`;
    report._recipients.slice(0, 15).forEach(r => {
      const acct = r.last4 ? ` (****${r.last4})` : '';
      reply += `   • ${r.name}${acct}: ${r.total.toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท (${r.count})\n`;
    });
    if (report._recipients.length > 15) reply += `   …และอีก ${report._recipients.length - 15} ราย\n`;
  }

  return reply;
}

async function deleteLastRow(auth, spreadsheetId, targetLast4) {
  const sheets = sheetsClient(auth);
  const tabName = `บัญชี_${targetLast4}`;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A:E`,
    });
    const rows = response.data.values;
    if (!rows || rows.length <= 1) return false;

    const lastRowIndex = rows.length;
    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = sheetMeta.data.sheets.find(s => s.properties.title === tabName);
    if (!sheet) return false;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: lastRowIndex - 1,
              endIndex: lastRowIndex,
            },
          },
        }],
      },
    });
    return true;
  } catch (err) {
    console.error('deleteLastRow error:', err);
    return false;
  }
}

// รายการรายตัวทุกบัญชี (flat) — ไว้แสดงในหน้า "รายการ" + ลบ/แก้
async function listTransactions(auth, spreadsheetId, { targetLast4 = null, limit = 500 } = {}) {
  const sheets = sheetsClient(auth);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  let tabs = getAccountTabNamesFromMeta(meta);
  if (targetLast4) tabs = tabs.filter(t => getLast4FromTabName(t) === targetLast4);
  if (tabs.length === 0) return [];
  const resp = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges: tabs.map(t => `'${t}'!A:K`) });
  const out = [];
  (resp.data.valueRanges || []).forEach((vr, idx) => {
    const last4 = getLast4FromTabName(tabs[idx]);
    (vr.values || []).slice(1).forEach(row => {
      if (!row[0]) return;
      out.push({
        hash: row[8] || '', last4, date: row[0] || '',
        amount: parseFloat(String(row[1] || '0').replace(/,/g, '')) || 0,
        fee: parseFloat(String(row[2] || '0').replace(/,/g, '')) || 0,
        tx_type: row[3] || '', counterparty: row[4] || '-', bank: row[5] || '',
        recipient_last4: row[9] || '', driveLink: row[7] || '', note: row[10] || '',
      });
    });
  });
  out.sort((a, b) => String(b.date).localeCompare(String(a.date))); // ใหม่ → เก่า
  return out.slice(0, limit);
}

// ลบรายการ 1 แถวตาม hash (ในบัญชีที่ระบุ) — ใช้ลบรายการผิด/ซ้ำ
async function deleteSlipByHash(auth, spreadsheetId, targetLast4, hash) {
  const sheets = sheetsClient(auth);
  const tabName = `บัญชี_${targetLast4}`;
  if (!hash) return { ok: false, error: 'ไม่มี hash' };
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!I:I` });
  const col = (r.data.values || []).map(x => x[0]);
  const idx = col.findIndex((h, i) => i > 0 && h === hash); // ข้าม header
  if (idx < 0) return { ok: false, error: 'ไม่พบรายการ (อาจถูกลบไปแล้ว)' };
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets.find(s => s.properties.title === tabName);
  if (!sheet) return { ok: false, error: 'ไม่พบแท็บบัญชี' };
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 } } }] },
  });
  scheduleSummarySync(auth, spreadsheetId);
  return { ok: true };
}

// แก้ไขรายการตาม hash — แก้ยอด/ค่าธรรม/ประเภท/ผู้รับ/ธนาคาร/วันที่/หมายเหตุ (เก็บ G,H,I เดิม)
async function updateSlipByHash(auth, spreadsheetId, targetLast4, hash, fields = {}) {
  const sheets = sheetsClient(auth);
  const tabName = `บัญชี_${targetLast4}`;
  if (!hash) return { ok: false, error: 'ไม่มี hash' };
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A:K` });
  const rows = r.data.values || [];
  let idx = -1;
  for (let i = 1; i < rows.length; i++) { if ((rows[i][8] || '') === hash) { idx = i; break; } }
  if (idx < 0) return { ok: false, error: 'ไม่พบรายการ (อาจถูกลบไปแล้ว)' };
  const cur = rows[idx];
  const pick = (k, i, isNum) => (fields[k] != null && String(fields[k]) !== '' ? (isNum ? Number(fields[k]) : fields[k]) : (cur[i] != null ? cur[i] : ''));
  const newRow = [
    pick('date', 0), pick('amount', 1, true), pick('fee', 2, true), pick('tx_type', 3),
    pick('counterparty', 4), pick('bank', 5),
    cur[6] || '-', cur[7] || '', cur[8] || hash, // G senderTG, H driveLink, I hash (คงเดิม)
    fields.recipient_last4 != null ? String(fields.recipient_last4).replace(/\D/g, '') : (cur[9] || ''),
    fields.note != null ? fields.note : (cur[10] || ''),
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${tabName}'!A${idx + 1}:K${idx + 1}`, valueInputOption: 'RAW', resource: { values: [newRow] },
  });
  scheduleSummarySync(auth, spreadsheetId);
  return { ok: true };
}

async function clearTodayData(auth, spreadsheetId, targetLast4, { skipSync = false, sheetId = null } = {}) {
  const sheets = sheetsClient(auth);
  const tabName = `บัญชี_${targetLast4}`;
  const today = getTodayStr();

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A:E`,
    });
    const rows = response.data.values;
    if (!rows || rows.length <= 1) return 0;

    let startIndex = -1, endIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].startsWith(today)) {
        if (startIndex === -1) startIndex = i;
        endIndex = i;
      }
    }
    if (startIndex === -1) return 0;

    let resolvedSheetId = sheetId;
    if (resolvedSheetId == null) {
      const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
      const sheet = sheetMeta.data.sheets.find(s => s.properties.title === tabName);
      if (!sheet) return 0;
      resolvedSheetId = sheet.properties.sheetId;
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: resolvedSheetId,
              dimension: 'ROWS',
              startIndex,
              endIndex: endIndex + 1,
            },
          },
        }],
      },
    });
    const deleted = endIndex - startIndex + 1;
    if (!skipSync) await syncSummaryTab(auth, spreadsheetId);
    return deleted;
  } catch (err) {
    console.error('clearTodayData error:', err);
    return -1;
  }
}

async function clearAllTodayData(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const accountTabs = getAccountTabNamesFromMeta(meta);
  const sheetIdByTitle = {};
  meta.data.sheets.forEach(s => { sheetIdByTitle[s.properties.title] = s.properties.sheetId; });

  let totalDeleted = 0;
  const results = [];

  for (const tabName of accountTabs) {
    const last4 = getLast4FromTabName(tabName);
    const count = await clearTodayData(auth, spreadsheetId, last4, { skipSync: true, sheetId: sheetIdByTitle[tabName] });
    if (count > 0) {
      results.push({ last4, count });
      totalDeleted += count;
    }
  }

  // sync ครั้งเดียวตอนจบ (best-effort) — แทนการ sync ทุกแท็บที่ทำให้ quota แตก
  try { await syncSummaryTab(auth, spreadsheetId); } catch (e) { console.error('summary sync (clear-all) failed:', e.message); }
  return { totalDeleted, results };
}

// ─── Wipe ALL rows from one tab (keep header row + formatting) ───────────────
async function wipeTabData(auth, spreadsheetId, targetLast4, { skipSync = false, sheetId = null } = {}) {
  const sheets = sheetsClient(auth);
  const tabName = `บัญชี_${targetLast4}`;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A:I`,
    });
    const rows = response.data.values;
    if (!rows || rows.length <= 1) return 0; // nothing to wipe

    let resolvedSheetId = sheetId;
    if (resolvedSheetId == null) {
      const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
      const sheet = sheetMeta.data.sheets.find(s => s.properties.title === tabName);
      if (!sheet) return 0;
      resolvedSheetId = sheet.properties.sheetId;
    }

    const totalRows = rows.length;
    // Delete rows 1..end (keep row 0 = header)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: resolvedSheetId,
              dimension: 'ROWS',
              startIndex: 1,
              endIndex: totalRows,
            },
          },
        }],
      },
    });
    const deleted = totalRows - 1;
    if (!skipSync) await syncSummaryTab(auth, spreadsheetId);
    return deleted;
  } catch (err) {
    console.error('wipeTabData error:', err.message);
    return -1;
  }
}

// ─── Wipe ALL rows from EVERY account tab ────────────────────────────────────
async function wipeAllTabsData(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const accountTabs = getAccountTabNamesFromMeta(meta);
  const sheetIdByTitle = {};
  meta.data.sheets.forEach(s => { sheetIdByTitle[s.properties.title] = s.properties.sheetId; });

  let totalDeleted = 0;
  const results = [];

  for (const tabName of accountTabs) {
    const last4 = getLast4FromTabName(tabName);
    const count = await wipeTabData(auth, spreadsheetId, last4, { skipSync: true, sheetId: sheetIdByTitle[tabName] });
    if (count > 0) {
      results.push({ last4, count });
      totalDeleted += count;
    }
  }

  // sync ครั้งเดียวตอนจบ (best-effort) — แทนการ sync ทุกแท็บที่ทำให้ quota แตก
  try { await syncSummaryTab(auth, spreadsheetId); } catch (e) { console.error('summary sync (wipe-all) failed:', e.message); }
  return { totalDeleted, results };
}

// ── Debounced + best-effort summary sync ───────────────────────────────────
// รวมการ sync จากหลายสลิปที่เข้ามารัวๆ ให้เหลือครั้งเดียว (ลด read quota)
// และไม่ throw ออกไป (กันไม่ให้ appendSlip ล้มจน retry เขียนแถวซ้ำ)
let _summarySyncTimer = null;
let _summarySyncArgs = null;
function scheduleSummarySync(auth, spreadsheetId, delayMs = 30000) {
  _summarySyncArgs = { auth, spreadsheetId };
  if (_summarySyncTimer) return;
  _summarySyncTimer = setTimeout(async () => {
    _summarySyncTimer = null;
    const args = _summarySyncArgs;
    _summarySyncArgs = null;
    if (!args) return;
    try {
      await syncSummaryTab(args.auth, args.spreadsheetId);
    } catch (e) {
      console.error('Summary sync (debounced) failed:', e.message);
    }
  }, delayMs);
  if (_summarySyncTimer.unref) _summarySyncTimer.unref();
}

async function syncSummaryTab(auth, spreadsheetId) {
  const sheets = sheetsClient(auth);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const summarySheet = meta.data.sheets.find(s => !isAccountTab(s.properties.title) && !isSystemTab(s.properties.title));
  if (!summarySheet) return;

  const summaryTitle = summarySheet.properties.title;
  const accountTabs = getAccountTabNamesFromMeta(meta);
  const todayReport = await getReport(auth, spreadsheetId);
  const allReport = await getReport(auth, spreadsheetId, null, 'all');
  const rows = [];

  // อ่านธนาคารของทุกแท็บใน request เดียว (batchGet) แทนวนอ่านทีละแท็บ
  const bankByTitle = {};
  if (accountTabs.length > 0) {
    try {
      const bankResp = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: accountTabs.map(t => `'${t}'!F2:F2`),
      });
      (bankResp.data.valueRanges || []).forEach((vr, i) => {
        bankByTitle[accountTabs[i]] = vr.values?.[0]?.[0] || '-';
      });
    } catch (_) {}
  }

  for (const tabName of accountTabs) {
    const last4 = getLast4FromTabName(tabName);
    const today = todayReport[last4] || {};
    const all = allReport[last4] || {};
    rows.push([
      last4,
      `บัญชี ${last4}`,
      bankByTitle[tabName] || '-',
      today.transferSum || 0,
      today.withdrawSum || 0,
      all.total || 0,
    ]);
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${summaryTitle}'!A2:F`,
  });

  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${summaryTitle}'!A2:F${rows.length + 1}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows },
    });
  }
}

module.exports = {
  initSpreadsheet,
  getOrCreateAccountTab,
  checkDuplicate,
  appendSlip,
  getReport,
  getTrends,
  listTransactions,
  deleteSlipByHash,
  updateSlipByHash,
  formatReport,
  categorizeTxType,
  getTodayStr,
  deleteLastRow,
  clearTodayData,
  clearAllTodayData,
  wipeTabData,
  wipeAllTabsData,
  syncSummaryTab,
  formatAllTabs,
  getSystemState,
  updateSystemState,
  updateBotHeartbeat,
  recordTokenUsage,
  recordProviderUsage,
  getQuotaUsage,
  setTokenUsage,
  setJobsSnapshot,
  getJobsSnapshot,
  getReviewQueue,
  setReviewQueue,
  addReviewItem,
  removeReviewItem,
  getOcrConfig,
  setOcrConfig,
  getAuditLog,
  appendAudit,
  buildWipeSummaryText,
  formatDashboardSystemState,
};
