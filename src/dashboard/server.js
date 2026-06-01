const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const axios = require('axios');
const { google } = require('googleapis');
const { resolvePendingOAuth, rejectPendingOAuth } = require('../auth');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const PORT = process.env.DASHBOARD_PORT || 3000;
const CRED_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'tokens', 'google_token.json');
const LOG_FILE = path.join(process.cwd(), 'app.log');
const SECRET_KEYS = new Set(['TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'TYPHOON_API_KEY', 'DASHBOARD_PASS', 'DASHBOARD_PIN']);
const SETTINGS_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'TYPHOON_API_KEY',
  'OCR_MODEL',
  'OCR_FALLBACK_1',
  'OCR_FALLBACK_2',
  'SPREADSHEET_ID',
  'SUMMARY_CHAT_ID',
  'DASHBOARD_USER',
  'DASHBOARD_PASS',
  'DASHBOARD_PIN',
  'ALLOWED_CHAT_IDS',
];
const MASK_VALUE = '********';

let logBuffer = [];
function pushLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('th-TH');
  const logEntry = `[${timestamp}] ${message}`;
  
  // Keep in memory for dashboard
  logBuffer.push({ time: Date.now(), message, type });
  if (logBuffer.length > 200) logBuffer.shift();

  // Write to file for persistence
  try {
    fs.appendFileSync(LOG_FILE, `${logEntry}\n`);
  } catch (err) {}
}

// === Global Crash Handlers ===
process.on('uncaughtException', (err) => {
  pushLog('🔴 คริติคอลเออเร่อ (ระบบล่ม): ' + err.message, 'error');
  console.error(err);
});
process.on('unhandledRejection', (reason, promise) => {
  pushLog('🔴 ข้อผิดพลาดที่ไม่คาดคิด: ' + reason, 'error');
});

// Override console methods to capture logs
const origLog = console.log;
const origErr = console.error;
const origWarn = console.warn;
console.log = (...args) => { origLog(...args); pushLog(args.join(' '), 'info'); };
console.error = (...args) => { origErr(...args); pushLog(args.join(' '), 'error'); };
console.warn = (...args) => { origWarn(...args); pushLog(args.join(' '), 'warn'); };

// ── multer for file upload ──
const uploadTempDir = process.env.VERCEL ? os.tmpdir() : path.join(__dirname, '..', '..', 'temp');
const upload = multer({ dest: uploadTempDir });

// ── Bot state ──
let botInstance = null;
let authClient = null;
let botRunning = false;
let spreadsheetId = null;
let statusSnapshotCache = { at: 0, data: null };
const STATUS_CACHE_MS = 15000;
const REPORT_CACHE_MS = 45000;
const REVIEW_CACHE_MS = 15000;
let reviewCache = null;
const TODAY_CACHE_MS = 60000;
let todayCache = null;
// login rate-limit (กัน brute-force) — ต่อ IP
const loginAttempts = new Map();
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const TRENDS_CACHE_MS = 120000;
let trendsCache = null;
const reportCache = new Map();
const JOBS_SNAPSHOT_CACHE_MS = 15000; // cache อ่าน snapshot งานบน Vercel (กันชน read quota)
let jobsSnapshotCache = null;

function isAuthDisabled() {
  return String(process.env.DISABLE_DASHBOARD_AUTH || '').toLowerCase() === 'true';
}

// ── Session token (stateless, ใช้ได้บน Vercel) — แยกตาม role: viewer / admin ──
const crypto = require('crypto');
function roleToken(role, env) {
  const u = env.DASHBOARD_USER || 'admin';
  const p = env.DASHBOARD_PASS || 'admin';
  const pin = env.DASHBOARD_PIN || '';
  return crypto.createHmac('sha256', `slipbot-session:${role}:${u}:${p}:${pin}`).update('v2').digest('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

// บล็อกการแก้ไขเมื่อไม่ใช่ admin (โหมดดูอย่างเดียว) — อ่าน role จาก res.req ที่ middleware ตั้งไว้
function publicAdminBlocked(res) {
  if (isAuthDisabled()) return false;
  if (res.req && res.req.dashRole === 'admin') return false;
  res.status(403).json({ ok: false, error: 'โหมดดูอย่างเดียว — ต้องใส่ PIN เพื่อแก้ไข', viewerOnly: true });
  return true;
}

// ส่งข้อความแจ้งเตือนเข้า Telegram (ใช้ HTTP API ตรง — ทำงานได้ทั้ง local และ Vercel)
// ส่งไป SUMMARY_CHAT_ID + ALLOWED_CHAT_IDS (กันซ้ำ) คืน true ถ้าส่งได้อย่างน้อย 1 ปลายทาง
async function sendTelegramNotice(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const chats = new Set();
  if (env.SUMMARY_CHAT_ID) chats.add(String(env.SUMMARY_CHAT_ID).trim());
  String(env.ALLOWED_CHAT_IDS || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean).forEach(id => chats.add(id));
  if (chats.size === 0) return false;
  const axios = require('axios');
  let sent = 0;
  for (const chatId of chats) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text }, { timeout: 15000 });
      sent++;
    } catch (e) { pushLog(`Telegram notice to ${chatId} failed: ${e.message}`, 'error'); }
  }
  return sent > 0;
}

function stripInlineComment(value) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (ch === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trim();
}

function unquoteEnvValue(rawValue = '') {
  let value = stripInlineComment(String(rawValue).trim());
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
}

function parseEnvContent(content) {
  const env = {};
  content.split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = unquoteEnvValue(match[2]);
  });
  return env;
}

function quoteEnvValue(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/"/g, '\\"')}"`;
}

function readEnvFile() {
  // env รวม process.env ด้วย เพื่อให้บน Vercel (ไม่มีไฟล์ .env) ยังเห็นค่า เช่น DASHBOARD_PASS
  // ส่วน content ใช้เฉพาะตอนเขียนไฟล์ (local) — บน Vercel จะข้ามการเขียน
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    return { content, env: { ...process.env, ...parseEnvContent(content) }, exists: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { content: '', env: { ...process.env }, exists: false };
    throw e;
  }
}

function isMaskValue(value) {
  return String(value || '').trim() === MASK_VALUE;
}

function normalizeAllowedChatIds(value) {
  const raw = String(value || '').trim();
  if (!raw) return { value: '', count: 0 };
  const parts = raw.split(/[,\s]+/).map(v => v.trim()).filter(Boolean);
  const invalid = parts.find(v => !/^-?\d{5,20}$/.test(v));
  if (invalid) {
    throw new Error(`ALLOWED_CHAT_IDS contains an invalid chat id: ${invalid}`);
  }
  const unique = Array.from(new Set(parts));
  return { value: unique.join(','), count: unique.length };
}

function isPlaceholder(value, placeholders) {
  const normalized = String(value || '').trim();
  return !normalized || placeholders.includes(normalized);
}

function validateSettings(values) {
  const errors = [];

  if (!isPlaceholder(values.TELEGRAM_BOT_TOKEN, ['YOUR_TELEGRAM_BOT_TOKEN_HERE']) &&
      !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(values.TELEGRAM_BOT_TOKEN)) {
    errors.push('TELEGRAM_BOT_TOKEN must look like a Telegram bot token.');
  }

  if (!isPlaceholder(values.GEMINI_API_KEY, ['YOUR_GEMINI_API_KEY_HERE']) &&
      !/^AIza[A-Za-z0-9_-]{20,}$/.test(values.GEMINI_API_KEY)) {
    errors.push('GEMINI_API_KEY must look like a Google AI API key.');
  }

  if (values.SPREADSHEET_ID && !/^[A-Za-z0-9_-]{20,128}$/.test(values.SPREADSHEET_ID)) {
    errors.push('SPREADSHEET_ID must look like a Google spreadsheet id.');
  }

  if (values.SUMMARY_CHAT_ID && !/^-?\d{5,20}$/.test(values.SUMMARY_CHAT_ID)) {
    errors.push('SUMMARY_CHAT_ID must be a numeric Telegram chat id.');
  }

  if (values.DASHBOARD_PIN && !/^\d{6}$/.test(values.DASHBOARD_PIN)) {
    errors.push('DASHBOARD_PIN ต้องเป็นตัวเลข 6 หลัก');
  }

  // โมเดล OCR หลัก/สำรอง — ต้องเป็นรุ่นที่รองรับ หรือ 'none' (สำหรับช่องสำรอง)
  try {
    const { SUPPORTED_MODELS } = require('../ocr');
    const valid = new Set(SUPPORTED_MODELS.map(m => m.id));
    if (values.OCR_MODEL && !valid.has(values.OCR_MODEL)) {
      errors.push('OCR_MODEL ต้องเป็นรุ่นที่รองรับ');
    }
    ['OCR_FALLBACK_1', 'OCR_FALLBACK_2'].forEach(k => {
      if (values[k] && values[k] !== 'none' && !valid.has(values[k])) {
        errors.push(`${k} ต้องเป็นรุ่นที่รองรับ หรือ "none"`);
      }
    });
  } catch (_) { /* ocr module โหลดไม่ได้ ข้ามการตรวจ */ }

  if (!values.DASHBOARD_USER || values.DASHBOARD_USER.length > 64 || /[:\r\n]/.test(values.DASHBOARD_USER)) {
    errors.push('DASHBOARD_USER is required and cannot contain colon or newlines.');
  }

  if (!values.DASHBOARD_PASS || values.DASHBOARD_PASS.length < 8 || /[\r\n]/.test(values.DASHBOARD_PASS)) {
    errors.push('DASHBOARD_PASS is required and must be at least 8 characters.');
  }

  if (values.DASHBOARD_USER === 'admin' && values.DASHBOARD_PASS === 'admin') {
    errors.push('DASHBOARD_USER and DASHBOARD_PASS cannot both be the default admin/admin.');
  }

  try {
    normalizeAllowedChatIds(values.ALLOWED_CHAT_IDS);
  } catch (e) {
    errors.push(e.message);
  }

  return errors;
}

function buildSanitizedSettings(body, currentEnv) {
  const next = {};
  const preservedSecrets = [];

  SETTINGS_KEYS.forEach(key => {
    const current = currentEnv[key] || '';
    // ช่องที่ "ไม่ได้ส่งมา" = ผู้ใช้ไม่ได้แก้ → คงค่าเดิมไว้ (รองรับบันทึกเฉพาะช่องที่เปลี่ยน)
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      next[key] = current;
      return;
    }
    let value = body[key] == null ? '' : String(body[key]).trim();

    if (SECRET_KEYS.has(key) && current && (!value || isMaskValue(value))) {
      value = current;
      preservedSecrets.push(key);
    }

    next[key] = value;
  });

  if (!next.DASHBOARD_USER) next.DASHBOARD_USER = currentEnv.DASHBOARD_USER || '';
  if (!next.DASHBOARD_PASS && currentEnv.DASHBOARD_PASS) next.DASHBOARD_PASS = currentEnv.DASHBOARD_PASS;
  next.ALLOWED_CHAT_IDS = normalizeAllowedChatIds(next.ALLOWED_CHAT_IDS).value;

  return { next, preservedSecrets };
}

function updateEnvContent(originalContent, updates) {
  const seen = new Set();
  const output = [];
  const lines = originalContent ? originalContent.split(/\r?\n/) : [];

  lines.forEach(line => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[2])) {
      output.push(line);
      return;
    }

    const key = match[2];
    if (seen.has(key)) return;
    seen.add(key);
    output.push(`${match[1]}${key}${match[3]}${quoteEnvValue(updates[key])}`);
  });

  SETTINGS_KEYS.forEach(key => {
    if (!seen.has(key)) {
      if (output.length && output[output.length - 1] !== '') output.push('');
      output.push(`${key}=${quoteEnvValue(updates[key])}`);
      seen.add(key);
    }
  });

  while (output.length > 1 && output[output.length - 1] === '' && output[output.length - 2] === '') {
    output.pop();
  }

  return output.join('\n').replace(/\s*$/, '\n');
}

function createEnvBackup() {
  if (!fs.existsSync(ENV_PATH)) return null;
  const bakPath = path.join(path.dirname(ENV_PATH), '.env.bak');
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const timestampPath = path.join(path.dirname(ENV_PATH), `.env.backup.${timestamp}`);

  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(ENV_PATH, bakPath);
    return bakPath;
  }

  fs.copyFileSync(ENV_PATH, timestampPath);
  return timestampPath;
}

function getLastEnvBackup() {
  const dir = path.dirname(ENV_PATH);
  try {
    const backups = fs.readdirSync(dir)
      .filter(name => name === '.env.bak' || /^\.env\.backup\./.test(name))
      .map(name => {
        const fullPath = path.join(dir, name);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return backups[0] || null;
  } catch (e) {
    return null;
  }
}

function hasUsableTelegramToken(env) {
  return !!env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
}

function hasUsableGeminiKey(env) {
  return !!env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE';
}

function getGoogleCredentialSource(env) {
  const hasEnv = !!env.GOOGLE_CREDENTIALS_JSON;
  const hasFile = fs.existsSync(CRED_PATH);
  if (hasEnv && hasFile) return 'env+file';
  if (hasEnv) return 'env';
  if (hasFile) return 'file';
  return 'missing';
}

function hasGoogleToken(env) {
  return !!env.GOOGLE_TOKEN_JSON || fs.existsSync(TOKEN_PATH);
}

function getConfigStatus() {
  const env = parseEnv();
  const credentialSource = getGoogleCredentialSource(env);
  let allowedChatCount = 0;
  try {
    allowedChatCount = normalizeAllowedChatIds(env.ALLOWED_CHAT_IDS || '').count;
  } catch (e) {
    allowedChatCount = 0;
  }
  const lastBackup = getLastEnvBackup();
  return {
    publicDashboard: isAuthDisabled(),
    canEditSettings: !isAuthDisabled(),
    hasTelegramToken: hasUsableTelegramToken(env),
    hasGeminiKey: hasUsableGeminiKey(env),
    hasSpreadsheetId: !!env.SPREADSHEET_ID,
    hasCredentials: credentialSource !== 'missing',
    hasGoogleToken: hasGoogleToken(env),
    allowedChatCount,
    envPath: ENV_PATH,
    credentialSource,
    lastBackup: lastBackup ? { path: lastBackup.path, mtime: new Date(lastBackup.mtimeMs).toISOString() } : null,
  };
}

function readLocalUsageSnapshot() {
  try {
    const usageFile = path.join(process.cwd(), 'ai_usage.json');
    if (!fs.existsSync(usageFile)) return { totalTokens: 0, count: 0 };
    const usage = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
    return {
      totalTokens: Number(usage.totalTokens || 0),
      count: Number(usage.count || 0),
    };
  } catch (_) {
    return { totalTokens: 0, count: 0 };
  }
}

function maskChatId(chatId) {
  const value = String(chatId || '');
  if (value.length <= 4) return value ? '****' : '';
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function sanitizeJobForDashboard(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    step: job.step,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    chatId: maskChatId(job.chatId),
    senderTG: job.senderTG || '',
    senderUsername: job.senderUsername || '',
    last4: job.last4 || job.parsedData?.last4 || '',
    amount: job.parsedData?.amount || '',
    txType: job.parsedData?.tx_type || '',
    bank: job.parsedData?.bank || '',
    counterparty: job.parsedData?.counterparty || '',
    ocrProvider: job.ocrProvider || '',
    ocrStatus: job.ocrStatus || '',
    duplicateOfJobId: job.duplicateOfJobId || '',
    duplicateOfDate: job.duplicateOfDate || '',
    duplicateOfThumb: (() => {
      const m = String(job.duplicateOfDriveLink || '').match(/\/d\/([^/]+)/);
      return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w200` : '';
    })(),
    duplicateOfDriveLink: job.duplicateOfDriveLink || '',
    fileHash: job.fileHash ? `${String(job.fileHash).slice(0, 8)}...` : '',
    driveLink: job.driveLink || '',
    thumbUrl: (() => {
      const m = String(job.driveLink || '').match(/\/d\/([^/]+)/);
      return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w300` : '';
    })(),
    tabName: job.tabName || '',
    duplicateTabName: job.duplicateTabName || '',
    lastError: job.lastError || '',
    attempts: job.attempts || [],
    leaseOwner: job.leaseOwner || '',
    leaseUntil: job.leaseUntil || '',
    leaseExpired: !job.leaseUntil || Date.parse(job.leaseUntil) <= Date.now(),
  };
}

async function buildStatusSnapshot() {
  const now = Date.now();
  if (statusSnapshotCache.data && now - statusSnapshotCache.at < STATUS_CACHE_MS) {
    return statusSnapshotCache.data;
  }

  const env = parseEnv();
  const hasToken = !!env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
  const hasGemini = !!env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE';
  const hasCred = fs.existsSync(CRED_PATH) || !!env.GOOGLE_CREDENTIALS_JSON;
  const configuredSpreadsheetId = spreadsheetId || env.SPREADSHEET_ID || process.env.SPREADSHEET_ID || null;
  let system = {
    botOnline: botRunning,
    botStatus: botRunning ? 'online' : 'unknown',
    botLastSeen: '',
    botLastSeenAgeMs: null,
    botHost: '',
    botPid: '',
    usage: { totalTokens: 0, count: 0 },
    queue: { waiting: 0, active: 0, concurrency: 1 },
  };

  if (hasCred && configuredSpreadsheetId) {
    try {
      const googleContext = await ensureGoogleContext();
      const { getSystemState, formatDashboardSystemState } = require('../sheets');
      system = formatDashboardSystemState(await getSystemState(googleContext.authClient, googleContext.spreadsheetId));
      system.botOnline = system.botOnline || botRunning;
    } catch (e) {
      system.error = e.message;
    }
  }

  const data = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    botRunning,
    botOnline: system.botOnline,
    botStatus: system.botStatus,
    botLastSeen: system.botLastSeen,
    botLastSeenAgeMs: system.botLastSeenAgeMs,
    botHost: system.botHost,
    botPid: system.botPid,
    // ถ้าตัวนับ local สูงกว่า sheet → ใช้ยอด token จาก local แต่ยัง merge byProvider/health จาก sheet ไว้
    usage: (!process.env.VERCEL && readLocalUsageSnapshot().totalTokens > Number(system.usage?.totalTokens || 0))
      ? { ...(system.usage || {}), ...readLocalUsageSnapshot() }
      : system.usage,
    quota: system.quota,
    queue: system.queue,
    hostedOnVercel: !!process.env.VERCEL,
    configured: hasToken && hasGemini && hasCred,
    sheetsReady: hasCred && !!configuredSpreadsheetId,
    geminiReady: hasGemini,
    driveReady: hasCred,
    spreadsheetId: configuredSpreadsheetId,
    systemError: system.error,
  };

  statusSnapshotCache = { at: now, data };
  return data;
}

function friendlyApiError(error) {
  if (error.response) {
    const status = error.response.status;
    const message = error.response.data && (error.response.data.description || error.response.data.error_description || error.response.data.error && error.response.data.error.message);
    return `API returned HTTP ${status}${message ? `: ${message}` : ''}`;
  }
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'Network/DNS is not available.';
  if (error.code === 'ECONNREFUSED') return 'Connection was refused by the remote service.';
  if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') return 'Connection timed out.';
  return error.message || 'Connection test failed.';
}

function readJsonFromEnvOrFile(envValue, filePath, missingMessage) {
  if (envValue) return JSON.parse(envValue);
  if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  throw new Error(missingMessage);
}

function getGoogleReadClient(env) {
  const credentials = readJsonFromEnvOrFile(env.GOOGLE_CREDENTIALS_JSON, CRED_PATH, 'Google credentials are not configured.');
  const token = readJsonFromEnvOrFile(env.GOOGLE_TOKEN_JSON, TOKEN_PATH, 'Google token is not configured. Complete OAuth before testing Sheets or Drive.');
  const key = credentials.installed || credentials.web;

  if (!key || !key.client_id || !key.client_secret) {
    throw new Error('Google credentials file is missing OAuth client_id/client_secret.');
  }
  if (!token.refresh_token && !token.access_token) {
    throw new Error('Google token is missing refresh_token/access_token.');
  }

  const client = new google.auth.OAuth2(key.client_id, key.client_secret);
  client.setCredentials(token);
  return client;
}

async function testTelegramConnection(env) {
  if (!hasUsableTelegramToken(env)) throw new Error('Telegram bot token is not configured.');
  const response = await axios.get(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, { timeout: 10000 });
  if (!response.data || response.data.ok !== true) throw new Error('Telegram rejected the bot token.');
  const result = response.data.result || {};
  return {
    ok: true,
    target: 'telegram',
    botUsername: result.username || null,
  };
}

async function testGeminiConnection(env) {
  if (!hasUsableGeminiKey(env)) throw new Error('Gemini API key is not configured.');
  const response = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
    params: { key: env.GEMINI_API_KEY },
    timeout: 10000,
  });
  const models = Array.isArray(response.data && response.data.models) ? response.data.models : [];
  return {
    ok: true,
    target: 'gemini',
    modelCount: models.length,
  };
}

async function testSheetsConnection(env) {
  const configuredSpreadsheetId = spreadsheetId || env.SPREADSHEET_ID || process.env.SPREADSHEET_ID || null;
  if (!configuredSpreadsheetId) throw new Error('SPREADSHEET_ID is not configured.');
  const auth = getGoogleReadClient(env);
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.get({
    spreadsheetId: configuredSpreadsheetId,
    fields: 'spreadsheetId,properties.title',
  });
  return {
    ok: true,
    target: 'sheets',
    spreadsheetFound: !!(response.data && response.data.spreadsheetId),
    spreadsheetTitle: response.data && response.data.properties ? response.data.properties.title : null,
  };
}

async function testDriveConnection(env) {
  const auth = getGoogleReadClient(env);
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.list({
    pageSize: 1,
    fields: 'files(id)',
    spaces: 'drive',
  });
  return {
    ok: true,
    target: 'drive',
    canListFiles: true,
  };
}

async function runConnectionTest(target) {
  const env = parseEnv();
  try {
    if (target === 'telegram') return await testTelegramConnection(env);
    if (target === 'gemini') return await testGeminiConnection(env);
    if (target === 'sheets') return await testSheetsConnection(env);
    if (target === 'drive') return await testDriveConnection(env);
    throw new Error('Unknown test target.');
  } catch (e) {
    return { ok: false, target, error: friendlyApiError(e) };
  }
}

async function ensureGoogleContext() {
  require('dotenv').config({ path: ENV_PATH, override: true });

  if (!authClient) {
    const { authorize } = require('../auth');
    authClient = await authorize();
  }

  if (!spreadsheetId) {
    const env = parseEnv();
    spreadsheetId = process.env.SPREADSHEET_ID || env.SPREADSHEET_ID || null;
  }

  if (!spreadsheetId) {
    throw new Error('ยังไม่มี SPREADSHEET_ID ใน .env');
  }

  return { authClient, spreadsheetId };
}

function createDashboard(port = 3000, options = {}) {
  const shouldListen = options.listen !== false;
  const shouldCreateTunnel = options.localTunnel !== false && !process.env.VERCEL;
  const shouldAutoStart = options.autoStart !== false && !process.env.VERCEL;
  const app = express();
  
  app.use(express.json());

  // ── Session login (cookie) — หน้า login อยู่ในเว็บ ไม่ใช่ popup ของ browser ──
  app.use((req, res, next) => {
    if (isAuthDisabled()) { req.dashRole = 'admin'; req.dashUser = 'admin'; return next(); }
    const p = req.path;
    // เส้นทางที่เข้าได้โดยไม่ต้องล็อกอิน
    if (p.startsWith('/oauth2callback') || p === '/login' || p === '/api/login' || p === '/api/logout' || p === '/favicon.svg') return next();

    const env = parseEnv();
    const raw = parseCookies(req).slip_session || '';
    const [role, tok] = raw.split('|');
    if ((role === 'admin' || role === 'viewer') && tok && safeEqual(tok, roleToken(role, env))) {
      req.dashRole = role;
      req.dashUser = role === 'admin' ? (env.DASHBOARD_USER || 'admin') : 'viewer';
      return next();
    }
    // ยังไม่ล็อกอิน → หน้า HTML เด้งไป /login, ส่วน API ตอบ 401
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ ok: false, error: 'unauthorized', login: true });
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    // บังคับเบราว์เซอร์ตรวจสอบไฟล์ใหม่ทุกครั้ง (กัน app.js/css/html เก่าค้าง cache)
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // ── หน้า Login (ในเว็บ) + login/logout ──
  app.get('/login', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>เข้าสู่ระบบ — Slip Bot</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',-apple-system,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 50% -10%,rgba(61,123,255,.18),transparent),#05080f;color:#e9eefb;padding:20px}
.box{width:100%;max-width:380px;background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(255,255,255,.015));border:1px solid rgba(120,150,230,.2);border-radius:18px;padding:32px 28px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.logo{font-size:42px;text-align:center;margin-bottom:6px}
h1{font-size:20px;text-align:center;margin-bottom:4px}
p.sub{text-align:center;color:#5d6b86;font-size:13px;margin-bottom:24px}
label{display:block;font-size:12px;color:#97a6c4;margin:14px 0 6px}
input{width:100%;padding:12px 14px;border-radius:10px;background:#05080f;color:#e9eefb;border:1px solid rgba(120,150,230,.22);font-size:15px}
input:focus{outline:none;border-color:#3d7bff}
button{width:100%;margin-top:22px;padding:13px;border:0;border-radius:10px;background:linear-gradient(135deg,#3d7bff,#6699ff);color:#fff;font-size:15px;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.err{margin-top:14px;color:#fca5a5;font-size:13px;text-align:center;min-height:18px}
.divider{display:flex;align-items:center;gap:10px;margin:22px 0 6px;color:#5d6b86;font-size:12px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:rgba(120,150,230,.18)}
#pin{text-align:center;letter-spacing:8px;font-size:20px}
</style></head><body>
<div class="box">
  <div class="logo">🤖</div>
  <h1>Slip Bot</h1>
  <p class="sub">เลือกวิธีเข้าใช้งาน</p>

  <button id="viewBtn" onclick="enterView()">👁️ เข้าชม (ดูอย่างเดียว)</button>

  <div class="divider"><span>หรือ ใส่ PIN เพื่อแก้ไข</span></div>

  <label>PIN 6 หลัก (โหมดแก้ไข)</label>
  <input id="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="● ● ● ● ● ●">
  <div class="err" id="e"></div>
</div>
<script>
async function enterView(){var b=document.getElementById('viewBtn');b.disabled=true;
try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'view'})});
var d=await r.json();if(d.ok)location.href='/';else{document.getElementById('e').textContent='เข้าไม่สำเร็จ';b.disabled=false;}}
catch(_){document.getElementById('e').textContent='เชื่อมต่อไม่สำเร็จ';b.disabled=false;}}
var pin=document.getElementById('pin'),e=document.getElementById('e');
pin.addEventListener('input',async function(){e.textContent='';pin.value=pin.value.replace(/[^0-9]/g,'');
if(pin.value.length===6){pin.disabled=true;
try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin.value})});
var d=await r.json();if(d.ok){location.href='/';}else{e.textContent=d.error||'PIN ไม่ถูกต้อง';pin.value='';pin.disabled=false;pin.focus();}}
catch(_){e.textContent='เชื่อมต่อไม่สำเร็จ';pin.disabled=false;}}});
pin.focus();
</script></body></html>`);
  });

  function setSessionCookie(req, res, role, env) {
    const secure = (req.headers['x-forwarded-proto'] === 'https' || req.secure) ? ' Secure;' : '';
    res.setHeader('Set-Cookie', `slip_session=${role}|${roleToken(role, env)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax;${secure}`);
  }
  app.post('/api/login', (req, res) => {
    const env = parseEnv();
    const body = req.body || {};

    // โหมดเข้าชม (ดูอย่างเดียว) — ไม่ต้องใช้ PIN
    if (body.mode === 'view') {
      setSessionCookie(req, res, 'viewer', env);
      return res.json({ ok: true, role: 'viewer' });
    }

    // โหมดแก้ไข — ใช้ PIN 6 หลัก (มี rate-limit กัน brute-force)
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (rec && rec.blockedUntil > now) {
      return res.status(429).json({ ok: false, error: `ใส่ PIN ผิดบ่อยเกินไป รอ ${Math.ceil((rec.blockedUntil - now) / 60000)} นาที` });
    }
    const pin = String(body.pin || '');
    const validPin = String(env.DASHBOARD_PIN || '');
    if (validPin && /^\d{6}$/.test(pin) && safeEqual(pin, validPin)) {
      loginAttempts.delete(ip);
      setSessionCookie(req, res, 'admin', env);
      return res.json({ ok: true, role: 'admin' });
    }
    const r = rec && now - rec.first < LOGIN_WINDOW_MS ? rec : { count: 0, first: now, blockedUntil: 0 };
    r.count += 1; r.first = r.first || now;
    if (r.count >= LOGIN_MAX_FAILS) { r.blockedUntil = now + LOGIN_BLOCK_MS; r.count = 0; r.first = now; }
    loginAttempts.set(ip, r);
    res.status(401).json({ ok: false, error: validPin ? 'PIN ไม่ถูกต้อง' : 'ยังไม่ได้ตั้ง PIN (ตั้งใน .env: DASHBOARD_PIN)' });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'slip_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    res.json({ ok: true });
  });

  // ── Google OAuth2 Callback (no auth required) ──
  app.get('/oauth2callback', (req, res) => {
    const code = req.query.code;
    const error = req.query.error;
    if (error) {
      rejectPendingOAuth(new Error('Google auth denied: ' + error));
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#e0e0e0"><h2>❌ ยกเลิกการ Authorize</h2><p>${error}</p></body></html>`);
    }
    if (code) {
      resolvePendingOAuth(code);
      return res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f3460;color:#e0e0e0">
          <div style="max-width:480px;margin:auto;background:#16213e;padding:40px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.4)">
            <div style="font-size:64px;margin-bottom:16px">✅</div>
            <h2 style="color:#4ade80;margin:0 0 12px">Authorize สำเร็จ!</h2>
            <p style="color:#94a3b8">Bot กำลังเริ่มทำงานอัตโนมัติ...</p>
            <p style="color:#64748b;font-size:13px;margin-top:24px">ปิดหน้าต่างนี้ได้เลยครับ</p>
          </div>
        </body></html>
      `);
    }
    res.status(400).send('Bad request');
  });

  // ── API: Get settings ──
  app.get('/api/settings', async (req, res) => {
    const env = parseEnv();
    const isAdmin = isAuthDisabled() || req.dashRole === 'admin';
    const hideSecrets = !isAdmin; // viewer ไม่เห็นความลับ
    let supportedModels = [];
    try { supportedModels = require('../ocr').SUPPORTED_MODELS; } catch (_) {}

    // ค่าที่ตั้งผ่านเว็บถูกเก็บใน _config (Sheet) = source of truth → อ่านมา overlay
    // เพื่อให้ทุกเครื่อง/ทุก deployment เห็นค่าตรงกัน + ตรงกับที่บอทใช้จริง
    let cfg = {};
    try {
      const ctx = await ensureGoogleContext();
      const { getOcrConfig } = require('../sheets');
      cfg = await getOcrConfig(ctx.authClient, ctx.spreadsheetId) || {};
    } catch (_) { cfg = {}; }
    const pick = (key, fallback) => (cfg[key] != null && String(cfg[key]).trim() !== '' ? String(cfg[key]) : (env[key] || fallback));
    const pickAllowEmpty = (key) => (Object.prototype.hasOwnProperty.call(cfg, key) ? String(cfg[key] == null ? '' : cfg[key]) : (env[key] || ''));

    // ความลับ "ปกปิดเสมอ" — ไม่ส่งค่าจริงออกไปฝั่ง client เด็ดขาด (กันดูจาก Network/Inspect/source)
    // แสดงเป็น ******** ถ้ามีค่าอยู่; ผู้ใช้พิมพ์ค่าใหม่ทับเพื่อเปลี่ยนได้ แต่อ่านของเดิมไม่ได้
    const maskIfSet = (v) => (v ? MASK_VALUE : '');
    res.json({
      TELEGRAM_BOT_TOKEN: maskIfSet(env.TELEGRAM_BOT_TOKEN),
      GEMINI_API_KEY: maskIfSet(env.GEMINI_API_KEY),
      OPENAI_API_KEY: maskIfSet(env.OPENAI_API_KEY),
      TYPHOON_API_KEY: maskIfSet(env.TYPHOON_API_KEY),
      OCR_MODEL: pick('OCR_MODEL', 'gemini-2.5-flash'),
      OCR_FALLBACK_1: pick('OCR_FALLBACK_1', 'typhoon-ocr'),
      OCR_FALLBACK_2: pick('OCR_FALLBACK_2', 'gpt-4o'),
      SUPPORTED_MODELS: supportedModels,
      SPREADSHEET_ID: env.SPREADSHEET_ID || '',
      SUMMARY_CHAT_ID: pickAllowEmpty('SUMMARY_CHAT_ID'),
      DASHBOARD_USER: env.DASHBOARD_USER || 'admin',
      DASHBOARD_PASS: maskIfSet(env.DASHBOARD_PASS),
      DASHBOARD_PIN: maskIfSet(env.DASHBOARD_PIN),
      ALLOWED_CHAT_IDS: pickAllowEmpty('ALLOWED_CHAT_IDS'),
      HAS_CREDENTIALS: fs.existsSync(CRED_PATH) || !!env.GOOGLE_CREDENTIALS_JSON,
      ROLE: isAuthDisabled() ? 'admin' : (req.dashRole || 'viewer'),
      READ_ONLY: !isAdmin,
      PUBLIC_DASHBOARD: hideSecrets,
    });
  });

  // ── API: Save settings ──
  // Production-safe settings save. This route intentionally appears before the
  // legacy handler below so it owns POST /api/settings.
  app.post('/api/settings', async (req, res) => {
    if (publicAdminBlocked(res)) return;

    try {
      const envFile = readEnvFile();
      const { next, preservedSecrets } = buildSanitizedSettings(req.body || {}, envFile.env);
      const validationErrors = validateSettings(next);

      if (validationErrors.length) {
        return res.status(400).json({
          ok: false,
          error: 'Invalid settings',
          details: validationErrors,
        });
      }

      // เขียน .env (best-effort — บน Vercel ระบบไฟล์อ่านอย่างเดียว จะข้ามไป)
      let backupPath = null;
      try {
        backupPath = createEnvBackup();
        const updatedContent = updateEnvContent(envFile.content, next);
        fs.writeFileSync(ENV_PATH, updatedContent, 'utf-8');
        require('dotenv').config({ path: ENV_PATH, override: true });
      } catch (fsErr) {
        if (!process.env.VERCEL) throw fsErr; // local เขียนไม่ได้ = error จริง
        pushLog(`.env write skipped on serverless: ${fsErr.message}`, 'info');
      }

      // เก็บ "config โมเดล OCR" ลง Google Sheet (_system) ให้บอท local ดึงไปใช้
      // (เฉพาะ key ที่ไม่ใช่ความลับ — API key เก็บใน .env เท่านั้น ไม่เก็บลงชีตสาธารณะ)
      try {
        const cfgWrite = {};
        // โมเดล: เขียนเฉพาะที่มีค่า (โมเดลว่าง = ไม่ถูกต้อง)
        ['OCR_MODEL', 'OCR_FALLBACK_1', 'OCR_FALLBACK_2'].forEach(k => {
          if (req.body && req.body[k] != null && String(req.body[k]).trim()) {
            cfgWrite[k] = String(req.body[k]).trim();
          }
        });
        // allow-list / summary chat: เขียนเมื่อ "ส่งมา" แม้ค่าว่าง (เพื่อให้เคลียร์/ปิด allowlist ได้)
        ['ALLOWED_CHAT_IDS', 'SUMMARY_CHAT_ID'].forEach(k => {
          if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
            cfgWrite[k] = String(req.body[k] == null ? '' : req.body[k]).trim();
          }
        });
        if (Object.keys(cfgWrite).length) {
          const ctx = await ensureGoogleContext();
          const { setOcrConfig } = require('../sheets');
          await setOcrConfig(ctx.authClient, ctx.spreadsheetId, cfgWrite);
          pushLog(`config saved to _config: ${Object.keys(cfgWrite).join(', ')}`, 'success');
        }
      } catch (sheetErr) {
        pushLog(`config sheet save failed: ${sheetErr.message}`, 'error');
      }

      pushLog('Settings saved', 'success');
      try {
        const ctx2 = await ensureGoogleContext();
        const { appendAudit } = require('../sheets');
        await appendAudit(ctx2.authClient, ctx2.spreadsheetId, { user: req.dashUser, action: 'settings-save', detail: `แก้ ${Object.keys(req.body || {}).join(', ')}` });
      } catch (_) {}
      res.json({
        ok: true,
        summary: {
          savedKeys: SETTINGS_KEYS,
          preservedSecrets,
          hasTelegramToken: hasUsableTelegramToken(next),
          hasGeminiKey: hasUsableGeminiKey(next),
          hasSpreadsheetId: !!next.SPREADSHEET_ID,
          hasDashboardCredentials: !!next.DASHBOARD_USER && !!next.DASHBOARD_PASS,
          allowedChatCount: normalizeAllowedChatIds(next.ALLOWED_CHAT_IDS).count,
          backupCreated: !!backupPath,
          backupPath,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Safe config status; never returns secret values.
  app.get('/api/config-status', (req, res) => {
    try {
      res.json({ ok: true, ...getConfigStatus() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Read-only connection tests; blocked on public dashboards.
  app.post('/api/test-connection', async (req, res) => {
    if (publicAdminBlocked(res)) return;

    const target = String((req.body && req.body.target) || '').toLowerCase();
    const allowedTargets = ['telegram', 'gemini', 'sheets', 'drive', 'all'];
    if (!allowedTargets.includes(target)) {
      return res.status(400).json({ ok: false, error: 'target must be one of telegram, gemini, sheets, drive, all' });
    }

    if (target !== 'all') {
      const result = await runConnectionTest(target);
      return res.status(result.ok ? 200 : 502).json(result);
    }

    const results = {};
    for (const item of ['telegram', 'gemini', 'sheets', 'drive']) {
      results[item] = await runConnectionTest(item);
    }
    const ok = Object.values(results).every(result => result.ok);
    return res.status(ok ? 200 : 502).json({ ok, target: 'all', results });
  });

  app.post('/api/settings-legacy-disabled', (req, res) => {
    return res.status(410).json({ ok: false, error: 'Legacy settings writer disabled' });
    if (publicAdminBlocked(res)) return;

    try {
      const { TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, SPREADSHEET_ID, SUMMARY_CHAT_ID, DASHBOARD_USER, DASHBOARD_PASS, ALLOWED_CHAT_IDS } = req.body;
      const lines = [
        '# === Required ===',
        `TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN || ''}"`,
        `GEMINI_API_KEY="${GEMINI_API_KEY || ''}"`,
        '',
        '# === Optional ===',
        `SPREADSHEET_ID="${SPREADSHEET_ID || ''}"`,
        `SUMMARY_CHAT_ID="${SUMMARY_CHAT_ID || ''}"`,
        `SUMMARY_TIME="59 23 * * *"`,
        '',
        '# === Security ===',
        `DASHBOARD_USER="${DASHBOARD_USER || 'admin'}"`,
        `DASHBOARD_PASS="${DASHBOARD_PASS || 'admin'}"`,
        `ALLOWED_CHAT_IDS="${ALLOWED_CHAT_IDS || ''}"`,
        ''
      ];
      fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');

      // Reload env into process
      require('dotenv').config({ path: ENV_PATH, override: true });

      pushLog('💾 บันทึกการตั้งค่าสำเร็จ', 'success');
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── API: Upload credentials.json ──
  app.post('/api/credentials', upload.single('credentials'), (req, res) => {
    if (publicAdminBlocked(res)) return;

    try {
      if (!req.file) return res.json({ ok: false, error: 'ไม่พบไฟล์' });

      // Validate and patch JSON
      const content = fs.readFileSync(req.file.path, 'utf-8');
      const json = JSON.parse(content);
      if (!json.installed && !json.web) {
        fs.unlinkSync(req.file.path);
        return res.json({ ok: false, error: 'ไฟล์ไม่ใช่ OAuth credentials ที่ถูกต้อง' });
      }

      // Automatically patch redirect_uris to use port 3001 (to avoid conflict with Dashboard on 3000)
      const clientType = json.web ? 'web' : 'installed';
      json[clientType].redirect_uris = ['http://localhost:3001/oauth2callback', 'http://localhost:3000/oauth2callback'];

      // Write directly to project root
      fs.writeFileSync(CRED_PATH, JSON.stringify(json, null, 2));
      fs.unlinkSync(req.file.path);
      pushLog('✅ อัปโหลด credentials.json สำเร็จ', 'success');
      res.json({ ok: true });
    } catch (e) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.json({ ok: false, error: 'ไฟล์ JSON ไม่ถูกต้อง: ' + e.message });
    }
  });

  // ── API: Start bot ──
  app.post('/api/bot/start', async (req, res) => {
    if (publicAdminBlocked(res)) return;

    if (botRunning) return res.json({ ok: false, error: 'Bot กำลังทำงานอยู่แล้ว' });

    // Reload env
    require('dotenv').config({ path: ENV_PATH, override: true });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const gemini = process.env.GEMINI_API_KEY;

    if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE' || token === '') {
      return res.json({ ok: false, error: 'กรุณาใส่ Telegram Bot Token ในหน้าตั้งค่า' });
    }
    if (!gemini || gemini === 'YOUR_GEMINI_API_KEY_HERE' || gemini === '') {
      return res.json({ ok: false, error: 'กรุณาใส่ Gemini API Key ในหน้าตั้งค่า' });
    }
    if (!fs.existsSync(CRED_PATH)) {
      return res.json({ ok: false, error: 'กรุณาอัปโหลด credentials.json ในหน้าตั้งค่า' });
    }

    try {
      pushLog('🔐 กำลัง Authenticate กับ Google...', 'info');
      const { authorize } = require('../auth');
      authClient = await authorize();
      pushLog('✅ Google Auth สำเร็จ', 'success');

      pushLog('🤖 กำลังเริ่ม Telegram Bot...', 'info');
      const { setupBot, getSpreadsheetId } = require('../bot');
      botInstance = setupBot(authClient);
      botRunning = true;

      const { setupScheduler } = require('../scheduler');
      setupScheduler(botInstance, authClient, getSpreadsheetId);

      // Track spreadsheetId
      const checkSheet = setInterval(() => {
        const sid = getSpreadsheetId();
        if (sid) { spreadsheetId = sid; clearInterval(checkSheet); }
      }, 2000);

      pushLog('✅ Bot เริ่มทำงานสำเร็จ!', 'success');
      res.json({ ok: true });
    } catch (e) {
      pushLog('❌ เริ่ม Bot ไม่สำเร็จ: ' + e.message, 'error');
      botRunning = false;
      res.json({ ok: false, error: e.message });
    }
  });

  // ── API: Stop bot ──
  app.post('/api/bot/stop', async (req, res) => {
    if (publicAdminBlocked(res)) return;

    if (!botRunning || !botInstance) return res.json({ ok: false, error: 'Bot ไม่ได้ทำงานอยู่' });
    try {
      await botInstance.stopPolling();
      botInstance = null;
      botRunning = false;
      authClient = null;
      pushLog('⏹️ Bot หยุดทำงานแล้ว', 'warn');

      // Clear require cache so bot can be restarted fresh
      Object.keys(require.cache).forEach(key => {
        if (key.includes('bot.js') || key.includes('scheduler.js')) {
          delete require.cache[key];
        }
      });

      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── API: Status ──
  app.get('/api/status', async (req, res) => {
    try {
      res.json(await buildStatusSnapshot());
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, fetchedAt: new Date().toISOString() });
    }
  });

  app.get('/api/realtime', async (req, res) => {
    try {
      const snapshot = await buildStatusSnapshot();
      res.json({
        ok: true,
        fetchedAt: new Date().toISOString(),
        status: snapshot,
        config: getConfigStatus(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, fetchedAt: new Date().toISOString() });
    }
  });

  // ── API: Logs ──
  app.get('/api/logs', (req, res) => {
    const since = parseInt(req.query.since) || 0;
    const newLogs = logBuffer.slice(since);
    res.json({ logs: newLogs, nextIndex: logBuffer.length });
  });

  // ── API: Report ──
  app.get('/api/report', async (req, res) => {
    try {
      let targetDate = req.query.date || null;
      // รองรับช่วงวัน: ?from=YYYY-MM-DD&to=YYYY-MM-DD
      if (req.query.from || req.query.to) {
        const from = req.query.from || req.query.to;
        const to = req.query.to || req.query.from;
        targetDate = `${from}~${to}`;
      }
      const cacheKey = targetDate || 'today';
      const forceRefresh = req.query.refresh === '1';
      const cached = reportCache.get(cacheKey);
      if (!forceRefresh && cached && Date.now() - cached.at < REPORT_CACHE_MS) {
        return res.json({ ok: true, report: cached.report, cached: true, fetchedAt: new Date(cached.at).toISOString() });
      }

      const googleContext = await ensureGoogleContext();
      const { getReport } = require('../sheets');
      const report = await getReport(googleContext.authClient, googleContext.spreadsheetId, null, targetDate);
      reportCache.set(cacheKey, { at: Date.now(), report });
      res.json({ ok: true, report, cached: false, fetchedAt: new Date().toISOString() });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // สรุปวันนี้ (สำหรับการ์ดหน้าแรก) — cache สั้นๆ
  app.get('/api/today', async (req, res) => {
    try {
      const now = Date.now();
      if (todayCache && now - todayCache.at < TODAY_CACHE_MS) return res.json({ ...todayCache.payload, cached: true });
      const ctx = await ensureGoogleContext();
      const { getReport, getTodayStr } = require('../sheets');
      const sum = (report) => {
        let total = 0, count = 0, fee = 0, transfer = 0, withdraw = 0, deposit = 0;
        Object.entries(report).forEach(([k, a]) => {
          if (k.startsWith('_')) return;
          total += Number(a.total || 0); fee += Number(a.feeSum || 0);
          transfer += Number(a.transferSum || 0); withdraw += Number(a.withdrawSum || 0); deposit += Number(a.depositSum || 0);
          count += Number(a.transferCount || 0) + Number(a.withdrawCount || 0) + Number(a.depositCount || 0) + Number(a.billCount || 0) + Number(a.otherCount || 0);
        });
        return { total, count, fee, transfer, withdraw, deposit };
      };
      const todayStr = getTodayStr();
      const monthRange = `${todayStr.slice(0, 8)}01~${todayStr}`;
      const [todayReport, monthReport] = await Promise.all([
        getReport(ctx.authClient, ctx.spreadsheetId, null, null),       // วันนี้
        getReport(ctx.authClient, ctx.spreadsheetId, null, monthRange), // เดือนนี้ (1 → วันนี้)
      ]);
      const payload = { ok: true, today: sum(todayReport), month: sum(monthReport), monthLabel: todayStr.slice(0, 7), fetchedAt: new Date().toISOString() };
      todayCache = { at: now, payload };
      res.json(payload);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // แนวโน้มรายวัน
  app.get('/api/trends', async (req, res) => {
    try {
      const days = Math.max(1, Math.min(parseInt(req.query.days || '7', 10) || 7, 31));
      const now = Date.now();
      if (trendsCache && trendsCache.days === days && now - trendsCache.at < TRENDS_CACHE_MS) {
        return res.json({ ...trendsCache.payload, cached: true });
      }
      const ctx = await ensureGoogleContext();
      const { getTrends } = require('../sheets');
      const trends = await getTrends(ctx.authClient, ctx.spreadsheetId, days);
      const payload = { ok: true, days, trends, fetchedAt: new Date().toISOString() };
      trendsCache = { at: now, days, payload };
      res.json(payload);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Export CSV ของช่วงที่เลือก
  app.get('/api/report/export', async (req, res) => {
    try {
      let targetDate = req.query.date || null;
      if (req.query.from || req.query.to) targetDate = `${req.query.from || req.query.to}~${req.query.to || req.query.from}`;
      const ctx = await ensureGoogleContext();
      const { getReport } = require('../sheets');
      const report = await getReport(ctx.authClient, ctx.spreadsheetId, null, targetDate);
      let csv = '﻿บัญชี,ธนาคาร,โอน,ถอน,ฝาก/รับ,ชำระบิล,อื่นๆ,ค่าธรรมเนียม,รวม,จำนวนรายการ\n';
      Object.entries(report).forEach(([k, a]) => {
        if (k.startsWith('_')) return;
        const cnt = Number(a.transferCount||0)+Number(a.withdrawCount||0)+Number(a.depositCount||0)+Number(a.billCount||0)+Number(a.otherCount||0);
        csv += [k, a.bank||'', a.transferSum||0, a.withdrawSum||0, a.depositSum||0, a.billSum||0, a.otherSum||0, a.feeSum||0, a.total||0, cnt].join(',') + '\n';
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="report_${(targetDate||'today').replace(/[~]/g,'_')}.csv"`);
      res.send(csv);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Export Excel (.xlsx) ของช่วงที่เลือก
  app.get('/api/report/export-xlsx', async (req, res) => {
    try {
      let targetDate = req.query.date || null;
      if (req.query.from || req.query.to) targetDate = `${req.query.from || req.query.to}~${req.query.to || req.query.from}`;
      const ctx = await ensureGoogleContext();
      const { getReport } = require('../sheets');
      const report = await getReport(ctx.authClient, ctx.spreadsheetId, null, targetDate);
      const XLSX = require('xlsx');
      const rows = [['บัญชี', 'ธนาคาร', 'โอน', 'ถอน', 'ฝาก/รับ', 'ชำระบิล', 'อื่นๆ', 'ค่าธรรมเนียม', 'รวม', 'จำนวนรายการ']];
      Object.entries(report).forEach(([k, a]) => {
        if (k.startsWith('_')) return;
        const cnt = Number(a.transferCount||0)+Number(a.withdrawCount||0)+Number(a.depositCount||0)+Number(a.billCount||0)+Number(a.otherCount||0);
        rows.push([k, a.bank || '', a.transferSum||0, a.withdrawSum||0, a.depositSum||0, a.billSum||0, a.otherSum||0, a.feeSum||0, a.total||0, cnt]);
      });
      const recs = (report._recipients || []).map(r => [r.name, r.last4 ? `****${r.last4}` : '', r.total, r.count]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'สรุปบัญชี');
      if (recs.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ผู้รับ', 'เลขบัญชี', 'ยอดรวม', 'จำนวน'], ...recs]), 'ผู้รับ');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="report_${(targetDate||'today').replace(/[~]/g,'_')}.xlsx"`);
      res.send(buf);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // รายการรายตัว (transaction browser)
  app.get('/api/transactions', async (req, res) => {
    try {
      const ctx = await ensureGoogleContext();
      const { listTransactions } = require('../sheets');
      const last4 = /^\d{2,6}$/.test(String(req.query.last4 || '')) ? req.query.last4 : null;
      const items = await listTransactions(ctx.authClient, ctx.spreadsheetId, { targetLast4: last4, limit: 500 });
      const mapped = items.map(it => {
        const m = String(it.driveLink || '').match(/\/d\/([^/]+)/);
        return { ...it, thumbUrl: m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w300` : '' };
      });
      res.json({ ok: true, count: mapped.length, items: mapped, fetchedAt: new Date().toISOString() });
    } catch (e) { res.json({ ok: false, error: e.message, items: [] }); }
  });

  // ลบรายการตาม hash (รายการผิด/ซ้ำ)
  app.post('/api/transactions/delete', async (req, res) => {
    if (publicAdminBlocked(res)) return;
    try {
      const { last4, hash } = req.body || {};
      if (!/^\d{2,6}$/.test(String(last4 || '')) || !hash) return res.json({ ok: false, error: 'ข้อมูลไม่ครบ' });
      const ctx = await ensureGoogleContext();
      const { deleteSlipByHash } = require('../sheets');
      const r = await deleteSlipByHash(ctx.authClient, ctx.spreadsheetId, last4, hash);
      if (!r.ok) return res.json(r);
      reportCache.clear(); todayCache = null; trendsCache = null;
      try { const { appendAudit } = require('../sheets'); await appendAudit(ctx.authClient, ctx.spreadsheetId, { user: req.dashUser, action: 'tx-delete', detail: `ลบรายการบัญชี ****${last4} (hash ${String(hash).slice(0, 8)})` }); } catch (_) {}
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // แก้ไขรายการตาม hash
  app.post('/api/transactions/update', async (req, res) => {
    if (publicAdminBlocked(res)) return;
    try {
      const b = req.body || {};
      if (!/^\d{2,6}$/.test(String(b.last4 || '')) || !b.hash) return res.json({ ok: false, error: 'ข้อมูลไม่ครบ' });
      if (b.amount != null && !(Number(b.amount) > 0)) return res.json({ ok: false, error: 'ยอดเงินต้องมากกว่า 0' });
      const ctx = await ensureGoogleContext();
      const { updateSlipByHash } = require('../sheets');
      const fields = {};
      ['date', 'amount', 'fee', 'tx_type', 'counterparty', 'bank', 'recipient_last4', 'note'].forEach(k => {
        if (Object.prototype.hasOwnProperty.call(b, k)) fields[k] = b[k];
      });
      const r = await updateSlipByHash(ctx.authClient, ctx.spreadsheetId, b.last4, b.hash, fields);
      if (!r.ok) return res.json(r);
      reportCache.clear(); todayCache = null; trendsCache = null;
      try { const { appendAudit } = require('../sheets'); await appendAudit(ctx.authClient, ctx.spreadsheetId, { user: req.dashUser, action: 'tx-edit', detail: `แก้รายการบัญชี ****${b.last4} (hash ${String(b.hash).slice(0, 8)})` }); } catch (_) {}
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Audit log
  app.get('/api/audit', async (req, res) => {
    try {
      const ctx = await ensureGoogleContext();
      const { getAuditLog } = require('../sheets');
      const items = await getAuditLog(ctx.authClient, ctx.spreadsheetId);
      res.json({ ok: true, items: items.slice(0, 100) });
    } catch (e) { res.json({ ok: false, error: e.message, items: [] }); }
  });

  app.get('/api/jobs', async (req, res) => {
    try {
      const status = String(req.query.status || '').trim();

      // Vercel (serverless): บอท local เป็นคนรันคิวจริง → อ่าน snapshot จาก Google Sheets (_jobs)
      if (process.env.VERCEL) {
        const now = Date.now();
        if (!jobsSnapshotCache || now - jobsSnapshotCache.at > JOBS_SNAPSHOT_CACHE_MS) {
          const ctx = await ensureGoogleContext();
          const { getJobsSnapshot } = require('../sheets');
          jobsSnapshotCache = { at: now, snap: await getJobsSnapshot(ctx.authClient, ctx.spreadsheetId) };
        }
        const snap = jobsSnapshotCache.snap || { jobs: [], stats: {} };
        let jobs = (snap.jobs || []).map(sanitizeJobForDashboard);
        if (status && status !== 'all') jobs = jobs.filter(j => j.status === status);
        return res.json({ ok: true, fetchedAt: snap.fetchedAt || new Date().toISOString(), stats: snap.stats || {}, jobs, canRetry: false });
      }

      // Local: อ่านจากไฟล์งานจริง
      const { listJobs, getStats } = require('../persistent_queue');
      const limit = Math.max(1, Math.min(parseInt(req.query.limit || '200', 10) || 200, 500));
      const jobs = listJobs(status && status !== 'all' ? { status } : {})
        .slice(-limit)
        .reverse()
        .map(sanitizeJobForDashboard);
      res.json({
        ok: true,
        fetchedAt: new Date().toISOString(),
        stats: getStats(),
        jobs,
        canRetry: !isAuthDisabled(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── คิวรอตรวจ (review queue) — สลิปจากตัวสำรอง / จับไม่ครบ ───────────────────
  app.get('/api/review', async (req, res) => {
    try {
      const now = Date.now();
      const forceRefresh = req.query.refresh === '1';
      if (!forceRefresh && reviewCache && now - reviewCache.at < REVIEW_CACHE_MS) {
        return res.json({ ...reviewCache.payload, cached: true });
      }
      const ctx = await ensureGoogleContext();
      const { getReviewQueue } = require('../sheets');
      const items = await getReviewQueue(ctx.authClient, ctx.spreadsheetId);
      const mapped = (items || []).map(it => {
        const m = String(it.driveLink || '').match(/\/d\/([^/]+)/);
        return { ...it, thumbUrl: m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w400` : '' };
      });
      const payload = { ok: true, count: mapped.length, items: mapped, fetchedAt: new Date().toISOString() };
      reviewCache = { at: now, payload };
      res.json(payload);
    } catch (e) {
      res.json({ ok: false, error: e.message, items: [] });
    }
  });

  app.post('/api/review/:id/confirm', async (req, res) => {
    if (publicAdminBlocked(res)) return;
    try {
      const ctx = await ensureGoogleContext();
      const { getReviewQueue, removeReviewItem, getOrCreateAccountTab, appendSlip, checkDuplicate } = require('../sheets');
      const items = await getReviewQueue(ctx.authClient, ctx.spreadsheetId);
      const item = items.find(x => x.id === req.params.id);
      if (!item) return res.status(404).json({ ok: false, error: 'ไม่พบรายการในคิว (อาจถูกจัดการไปแล้ว)' });

      const b = req.body || {};
      const last4 = String(b.last4 != null ? b.last4 : item.last4 || '').replace(/\D/g, '');
      if (!/^\d{2,6}$/.test(last4)) return res.json({ ok: false, error: 'เลขบัญชีต้องเป็นตัวเลข 2-6 หลัก' });
      const amount = Number(b.amount != null ? b.amount : item.amount);
      if (!(amount > 0)) return res.json({ ok: false, error: 'ยอดเงินต้องมากกว่า 0' });

      const finalData = {
        last4,
        amount,
        fee: Number(b.fee != null ? b.fee : item.fee) || 0,
        tx_type: (b.tx_type != null ? b.tx_type : item.tx_type) || 'อื่นๆ',
        counterparty: (b.counterparty != null ? b.counterparty : item.counterparty) || '-',
        recipient_last4: item.recipient_last4 || '',
        bank: (b.bank != null ? b.bank : item.bank) || '-',
        date: (b.date != null ? b.date : item.date) || '',
        slip_type: item.slip_type || 'digital',
        senderTG: item.senderTG || '-',
        driveLink: item.driveLink || '-',
        hash: item.fileHash || '',
      };

      if (finalData.hash) {
        const dup = await checkDuplicate(ctx.authClient, ctx.spreadsheetId, finalData.hash, last4);
        if (dup.duplicate) {
          await removeReviewItem(ctx.authClient, ctx.spreadsheetId, item.id);
          return res.json({ ok: true, duplicate: true, tab: dup.tabName });
        }
      }
      await getOrCreateAccountTab(ctx.authClient, ctx.spreadsheetId, last4, finalData.bank);
      await appendSlip(ctx.authClient, ctx.spreadsheetId, last4, finalData);
      await removeReviewItem(ctx.authClient, ctx.spreadsheetId, item.id);
      reportCache.clear();
      reviewCache = null; todayCache = null;
      try { const { appendAudit } = require('../sheets'); await appendAudit(ctx.authClient, ctx.spreadsheetId, { user: req.dashUser, action: 'review-confirm', detail: `บันทึกบัญชี ****${last4} ยอด ${amount}` }); } catch (_) {}
      res.json({ ok: true, last4 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/review/:id/discard', async (req, res) => {
    if (publicAdminBlocked(res)) return;
    try {
      const ctx = await ensureGoogleContext();
      const { removeReviewItem, appendAudit } = require('../sheets');
      await removeReviewItem(ctx.authClient, ctx.spreadsheetId, req.params.id);
      reviewCache = null;
      try { await appendAudit(ctx.authClient, ctx.spreadsheetId, { user: req.dashUser, action: 'review-discard', detail: `ทิ้งงาน ${req.params.id}` }); } catch (_) {}
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/jobs/:id/retry', async (req, res) => {
    if (publicAdminBlocked(res)) return;

    try {
      const { getJob, resetFailedJob } = require('../persistent_queue');
      const job = getJob(req.params.id);
      if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
      if (job.status !== 'failed') return res.status(400).json({ ok: false, error: 'Only failed jobs can be retried' });

      resetFailedJob(job.id);
      let enqueued = false;
      if (botInstance && authClient) {
        const { enqueueSlipJob } = require('../bot');
        enqueued = await enqueueSlipJob(botInstance, authClient, job.id, { notifyResume: true });
      }

      res.json({
        ok: true,
        jobId: job.id,
        status: 'queued',
        enqueued,
        note: enqueued ? 'Job was re-queued immediately.' : 'Job was reset to queued and will recover on bot restart.',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/jobs/retry-failed', async (req, res) => {
    if (publicAdminBlocked(res)) return;

    try {
      const { listFailedJobs, resetFailedJob } = require('../persistent_queue');
      const failed = listFailedJobs();
      let enqueued = 0;
      for (const job of failed) {
        resetFailedJob(job.id);
        if (botInstance && authClient) {
          const { enqueueSlipJob } = require('../bot');
          if (await enqueueSlipJob(botInstance, authClient, job.id, { notifyResume: true })) enqueued++;
        }
      }
      res.json({ ok: true, reset: failed.length, enqueued });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── API: Wipe all sheet rows and Drive files ──
  app.post('/api/wipe-all', async (req, res) => {
    if (publicAdminBlocked(res)) return;

    try {
      const googleContext = await ensureGoogleContext();
      const { authClient, spreadsheetId } = googleContext;
      const {
        wipeAllTabsData, syncSummaryTab, setTokenUsage,
        setJobsSnapshot, setReviewQueue, setOcrConfig,
      } = require('../sheets');
      const { deleteAllDriveFiles } = require('../drive_admin');

      // 1) ชีต (บัญชี_* + สรุป) + Drive
      const sheetResult = await wipeAllTabsData(authClient, spreadsheetId);
      const driveCount = await deleteAllDriveFiles(authClient);
      await syncSummaryTab(authClient, spreadsheetId);

      // 2) ตัวนับ token/รูป + หน้าคิว + คิวรอตรวจ (best-effort แต่ละตัว)
      const steps = { usage: false, jobs: false, review: false, signal: false, local: false, telegram: false };
      try { await setTokenUsage(authClient, spreadsheetId, 0, 0); steps.usage = true; } catch (e) { pushLog('reset usage failed: ' + e.message, 'error'); }
      try { await setJobsSnapshot(authClient, spreadsheetId, { jobs: [], stats: {}, fetchedAt: new Date().toISOString() }); steps.jobs = true; } catch (e) { pushLog('clear jobs snapshot failed: ' + e.message, 'error'); }
      try { await setReviewQueue(authClient, spreadsheetId, []); steps.review = true; } catch (e) { pushLog('clear review queue failed: ' + e.message, 'error'); }

      // 3) ส่งสัญญาณให้บอท local ล้างไฟล์งาน/ตัวนับในเครื่อง (ผ่าน _config)
      try { await setOcrConfig(authClient, spreadsheetId, { wipe_signal: new Date().toISOString() }); steps.signal = true; } catch (e) { pushLog('set wipe_signal failed: ' + e.message, 'error'); }

      // 4) ถ้ารันที่เครื่อง (ไม่ใช่ Vercel) ล้าง local ทันทีด้วย
      if (!process.env.VERCEL) {
        try {
          require('../persistent_queue').clearAll();
          try { require('../localdb').clearLocalDb(); } catch (_) {}
          const usagePath = path.join(process.cwd(), 'ai_usage.json');
          fs.writeFileSync(usagePath, JSON.stringify({ totalTokens: 0, count: 0 }, null, 2), 'utf-8');
          steps.local = true;
        } catch (e) { pushLog('clear local data failed: ' + e.message, 'error'); }
      }

      // 5) แจ้งทาง Telegram ว่าล้างสำเร็จ (ใช้ข้อความกลางตัวเดียวกับการล้างผ่าน Telegram)
      try {
        const env = parseEnv();
        const { buildWipeSummaryText } = require('../sheets');
        const msg = buildWipeSummaryText({ rows: sheetResult.totalDeleted || 0, driveCount });
        steps.telegram = await sendTelegramNotice(env, msg);
      } catch (e) { pushLog('telegram notify failed: ' + e.message, 'error'); }

      pushLog(`ล้างข้อมูลทั้งหมดแล้ว: sheet ${sheetResult.totalDeleted} rows, Drive ${driveCount} files, steps=${JSON.stringify(steps)}`, 'warn');
      todayCache = null; trendsCache = null;
      try { const { appendAudit } = require('../sheets'); await appendAudit(authClient, spreadsheetId, { user: req.dashUser, action: 'wipe-all', detail: `ลบ ${sheetResult.totalDeleted} แถว, Drive ${driveCount} ไฟล์` }); } catch (_) {}
      res.json({ ok: true, sheet: sheetResult, driveCount, steps });
    } catch (e) {
      pushLog('ล้างข้อมูลทั้งหมดไม่สำเร็จ: ' + e.message, 'error');
      res.json({ ok: false, error: e.message });
    }
  });

  // ── API: Usage ──
  app.get('/api/usage', async (req, res) => {
    try {
      const snapshot = await buildStatusSnapshot();
      if (snapshot.usage) {
        return res.json({
          ok: true,
          available: true,
          source: snapshot.spreadsheetId ? 'status_snapshot' : 'empty',
          usage: snapshot.usage,
        });
      }

      const usageFile = path.join(process.cwd(), 'ai_usage.json');
      if (fs.existsSync(usageFile)) {
        const usage = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
        res.json({ ok: true, available: true, source: 'local_file', usage });
      } else {
        res.json({ ok: true, available: true, source: 'empty', usage: { totalTokens: 0, count: 0 } });
      }
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Start server ──
  if (!shouldListen) {
    return app;
  }

  app.listen(port, '0.0.0.0', async () => {
    console.log(`\n🌐 Dashboard: http://localhost:${port}`);
    console.log(`🌐 Public:    http://YOUR_PUBLIC_IP:${port}\n`);
    
    // Create public tunnel
    try {
      if (!shouldCreateTunnel) return;
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({ port: port });
      console.log(`🌍 PUBLIC LINK: ${tunnel.url}`);
      pushLog(`🔗 ลิงก์ออนไลน์ (ส่งให้คนนอกเข้าได้): ${tunnel.url}`, 'info');
      
      tunnel.on('close', () => {
        pushLog('🔴 ลิงก์ออนไลน์ถูกปิดตัวลง', 'error');
      });
    } catch (e) {
      pushLog('⚠️ ไม่สามารถสร้างลิงก์ออนไลน์ได้: ' + e.message, 'error');
    }

    // Auto-start bot if config is ready
    if (!shouldAutoStart) return;

    setTimeout(async () => {
      const env = parseEnv();
      const hasToken = !!env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
      const hasGemini = !!env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE';
      const hasCred = fs.existsSync(CRED_PATH) || !!env.GOOGLE_CREDENTIALS_JSON;

      if (hasToken && hasGemini && hasCred && !botRunning) {
        pushLog('⚡ กำลังเริ่มต้น Bot อัตโนมัติ...', 'info');
        try {
          const { authorize } = require('../auth');
          authClient = await authorize();
          pushLog('✅ Google Auth สำเร็จ', 'success');

          const { setupBot, getSpreadsheetId } = require('../bot');
          botInstance = setupBot(authClient);
          botRunning = true;

          const { setupScheduler } = require('../scheduler');
          setupScheduler(botInstance, authClient, getSpreadsheetId);

          const checkSheet = setInterval(() => {
            const sid = getSpreadsheetId();
            if (sid) { spreadsheetId = sid; clearInterval(checkSheet); }
          }, 2000);

          pushLog('✅ Bot เริ่มทำงานอัตโนมัติสำเร็จ!', 'success');
        } catch (e) {
          pushLog('❌ Auto-start ไม่สำเร็จ: ' + e.message, 'error');
        }
      }
    }, 1500);
  });

  return app;
}

function parseEnv() {
  const env = { ...process.env };
  try {
    return { ...env, ...parseEnvContent(fs.readFileSync(ENV_PATH, 'utf-8')) };
  } catch (e) {
    return env;
  }
}

module.exports = { createDashboard, pushLog };
