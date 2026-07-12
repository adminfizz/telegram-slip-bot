let publicReadOnly = false;
let latestSettings = {};

// ── ชื่อบัญชีจาก debittrans (last4 → ชื่อ) — แปะข้างเลขบัญชีทุกจุดในเว็บ ──
let debitNames = {};
function accName(last4) {
  // normalize เหมือนฝั่ง server: ตัดอักขระไม่ใช่เลข + ตัดศูนย์นำหน้า (0906 ↔ 906 จับคู่กันได้)
  const k = String(last4 == null ? '' : last4).replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return (k && debitNames[k]) || '';
}
function accNameTag(last4) {
  const n = accName(last4);
  return n ? ` <span class="acc-name">${escHtml(n)}</span>` : '';
}
// เซลล์บัญชีแบบ 2 บรรทัด: บน = ****เลข + (ธนาคาร), ล่าง = ชื่อบัญชี (ตัดด้วย … ถ้ายาว)
// ใช้ในตารางที่คอลัมน์บัญชีแคบ กันชื่อตัดคำกลางบรรทัด
function accCell(last4, bank) {
  const name = accName(last4);
  const top = `<span class="acc-cell-top"><strong>****${escHtml(last4)}</strong>${bank ? ` <small>${escHtml(bank)}</small>` : ''}</span>`;
  const nm = name ? `<small class="acc-cell-name">${escHtml(name)}</small>` : '';
  return `<span class="acc-cell">${top}${nm}</span>`;
}
async function loadDebitNames() {
  try {
    const r = await fetch('/api/debit-accounts', { cache: 'no-store' });
    const d = await r.json();
    if (d && d.accounts && Object.keys(d.accounts).length) debitNames = d.accounts;
  } catch (_) {}
}

// ถ้า session หมดอายุ/ยังไม่ล็อกอิน (API ตอบ 401) → เด้งไปหน้า login
(function () {
  const _fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const r = await _fetch(...args);
    try {
      const url = String(args[0] || '');
      if (r.status === 401 && !url.includes('/api/login')) {
        if (location.pathname !== '/login') location.href = '/login';
      }
    } catch (_) {}
    return r;
  };
})();

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
  location.href = '/login';
}

// ปรับ UI ตาม role: viewer = แสดงแถบ "ดูอย่างเดียว"
function applyRoleUI(role, readOnly) {
  const btn = document.getElementById('btnLogout');
  if (btn) btn.textContent = readOnly ? '🚪 ออก (โหมดดู)' : '🚪 ออกจากระบบ';
  let b = document.getElementById('roleBanner');
  if (readOnly) {
    if (!b) {
      b = document.createElement('div'); b.id = 'roleBanner'; b.className = 'role-banner';
      const mc = document.querySelector('.main-content'); if (mc) mc.prepend(b);
    }
    b.innerHTML = '👁️ โหมดดูอย่างเดียว — แก้ไข/บันทึก/ล้าง ไม่ได้ · <a href="/login">ใส่ PIN 6 หลักเพื่อแก้ไข</a>';
    b.style.display = '';
  } else if (b) { b.style.display = 'none'; }
}
let statusInFlight = false;
let jobsInFlight = false;
let lastJobsRenderSignature = '';
let lastReportRenderSignature = '';

const MASK_RE = /^\*{6,}$/;

function isMaskedSecret(value) {
  return MASK_RE.test(String(value || '').trim());
}

function getAllowedChatCount(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean).length;
}

function boolStatus(value, fallback = false) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['true', 'yes', 'ok', 'ready', 'configured', 'connected', 'online'].includes(normalized)) return true;
    if (['false', 'no', 'missing', 'error', 'offline', 'not_configured'].includes(normalized)) return false;
  }
  return fallback;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function setStatusText(id, ready, readyText = 'Configured', missingText = 'Missing') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = ready ? readyText : missingText;
  el.classList.toggle('ready', Boolean(ready));
  el.classList.toggle('missing', !ready);
}

function setMaskedHelp(inputId, helpId, label) {
  const input = document.getElementById(inputId);
  const help = document.getElementById(helpId);
  if (!input || !help) return;
  if (isMaskedSecret(input.value)) {
    help.textContent = `${label} is already configured. The asterisks are only a mask, not the real value. Leave it unchanged to keep the existing secret.`;
    help.classList.add('warning');
  } else {
    help.textContent = '';
    help.classList.remove('warning');
  }
}

function refreshMaskedHelp() {
  setMaskedHelp('telegramToken', 'telegramTokenHelp', 'Telegram token');
  setMaskedHelp('geminiKey', 'geminiKeyHelp', 'Gemini API key');
  setMaskedHelp('dashPass', 'dashPassHelp', 'Dashboard password');
}

function setSettingsMode(isPublic) {
  publicReadOnly = Boolean(isPublic);
  const modeText = document.getElementById('settingsModeText');
  const modePill = document.getElementById('settingsModePill');
  const banner = document.getElementById('publicReadonlyBanner');
  const body = document.body;

  if (modeText) modeText.textContent = publicReadOnly ? 'Public Read-only' : 'Local Admin';
  if (modePill) {
    modePill.textContent = publicReadOnly ? 'Read-only' : 'Admin';
    modePill.classList.toggle('readonly', publicReadOnly);
  }
  if (banner) banner.hidden = !publicReadOnly;
  body.classList.toggle('public-readonly', publicReadOnly);

  const settingsForm = document.getElementById('settingsForm');
  if (settingsForm) {
    settingsForm.querySelectorAll('input, button, textarea, select').forEach(control => {
      control.disabled = publicReadOnly;
    });
  }

  ['btnWipeAll', 'btnStartBot', 'btnStopBot'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = publicReadOnly ? 'none' : el.style.display;
  });
}

function buildConfigSummary(data = {}, fallback = {}) {
  const telegram = data.telegram || data.telegramBot || {};
  const gemini = data.gemini || data.geminiAi || {};
  const google = data.google || {};
  const sheets = data.sheets || google.sheets || {};
  const credentials = data.credentials || google.credentials || {};
  const dashboard = data.dashboard || data.auth || {};
  const mode = String(firstDefined(data.mode, data.settingsMode, fallback.mode, '')).toLowerCase();
  const allowedChatIds = firstDefined(data.allowedChatIds, data.ALLOWED_CHAT_IDS, fallback.ALLOWED_CHAT_IDS, '');
  const allowedChatCount = Number(firstDefined(data.allowedChatCount, data.allowedChatsCount, getAllowedChatCount(allowedChatIds)));

  return {
    publicDashboard: mode.includes('public') || boolStatus(firstDefined(data.publicDashboard, data.PUBLIC_DASHBOARD, fallback.PUBLIC_DASHBOARD), false),
    telegramReady: boolStatus(firstDefined(telegram.ready, telegram.configured, data.telegramReady, data.hasTelegramToken, fallback.TELEGRAM_BOT_TOKEN), Boolean(fallback.TELEGRAM_BOT_TOKEN)),
    geminiReady: boolStatus(firstDefined(gemini.ready, gemini.configured, data.geminiReady, data.hasGeminiKey, fallback.GEMINI_API_KEY), Boolean(fallback.GEMINI_API_KEY)),
    credentialsReady: boolStatus(firstDefined(credentials.ready, credentials.configured, data.credentialsReady, data.hasCredentials, data.HAS_CREDENTIALS, fallback.HAS_CREDENTIALS), Boolean(fallback.HAS_CREDENTIALS)),
    spreadsheetReady: boolStatus(firstDefined(sheets.ready, sheets.configured, data.sheetsReady, data.spreadsheetReady, data.SPREADSHEET_ID, fallback.SPREADSHEET_ID), Boolean(fallback.SPREADSHEET_ID)),
    dashboardAuthReady: boolStatus(firstDefined(dashboard.ready, dashboard.configured, data.dashboardAuthReady, fallback.DASHBOARD_USER || fallback.DASHBOARD_PASS), Boolean(fallback.DASHBOARD_USER || fallback.DASHBOARD_PASS)),
    allowedChatCount,
  };
}

function renderConfigSummary(summary, source = '') {
  setSettingsMode(summary.publicDashboard);
  setStatusText('summaryTelegram', summary.telegramReady);
  setStatusText('summaryGemini', summary.geminiReady);
  setStatusText('summaryCredentials', summary.credentialsReady, 'Configured', 'Missing');
  setStatusText('summarySpreadsheet', summary.spreadsheetReady, 'Configured', 'Auto-create / missing');
  setStatusText('summaryDashboardAuth', summary.dashboardAuthReady);
  const allowedEl = document.getElementById('summaryAllowedChats');
  if (allowedEl) {
    allowedEl.textContent = `${summary.allowedChatCount} configured`;
    allowedEl.classList.toggle('ready', summary.allowedChatCount > 0);
    allowedEl.classList.toggle('missing', summary.allowedChatCount === 0);
  }

  const note = document.getElementById('configSummaryNote');
  if (note) note.textContent = source;
}

async function loadConfigStatus(fallbackSettings = latestSettings) {
  try {
    const res = await fetch('/api/config-status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderConfigSummary(buildConfigSummary(data, fallbackSettings), '');
  } catch (e) {
    renderConfigSummary(
      buildConfigSummary(fallbackSettings, fallbackSettings),
      'Config status endpoint is unavailable; showing a fallback summary from /api/settings.'
    );
  }
}

function omitMaskedSecret(payload, key, inputId) {
  const value = document.getElementById(inputId)?.value.trim() || '';
  if (isMaskedSecret(value)) {
    delete payload[key];
  } else {
    payload[key] = value;
  }
}

function getSafeConnectionLines(target, result) {
  const lines = [];
  const label = String(target || 'connection').toUpperCase();
  const ok = Boolean(result && (result.ok || result.success || result.status === 'ok' || result.status === 'connected'));
  lines.push(`${label}: ${ok ? 'OK' : 'FAILED'}`);

  const message = result?.message || result?.error || result?.statusText;
  if (message) lines.push(String(message));

  let checks = result?.checks || result?.results || result?.targets;
  if (!checks && result && typeof result === 'object') {
    checks = {};
    ['telegram', 'gemini', 'sheets', 'drive'].forEach(name => {
      if (result[name] && typeof result[name] === 'object') checks[name] = result[name];
    });
  }
  if (checks && typeof checks === 'object') {
    Object.entries(checks).forEach(([name, value]) => {
      if (value && typeof value === 'object') {
        const checkOk = Boolean(value.ok || value.success || value.status === 'ok' || value.status === 'connected');
        const checkMessage = value.message || value.error || value.statusText || '';
        lines.push(`${name}: ${checkOk ? 'OK' : 'FAILED'}${checkMessage ? ` - ${checkMessage}` : ''}`);
      } else {
        lines.push(`${name}: ${String(value)}`);
      }
    });
  }

  return lines.map(line => line.replace(/([A-Za-z0-9_-]{12,}:[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,})/g, '[redacted]'));
}

// === Tab Navigation ===
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    item.classList.add('active');
    const tabId = item.getAttribute('data-tab');
    document.getElementById(`tab-${tabId}`).classList.add('active');

    // Auto-load report when switching to report tab
    if (tabId === 'report') {
      loadReport();
    }
    if (tabId === 'jobs') {
      loadJobs();
    }
    if (tabId === 'review') {
      loadReview();
    }
    if (tabId === 'dashboard') {
      loadToday();
      loadTrends(7);
      loadAccountChart();
    }
    if (tabId === 'logs') {
      loadAudit();
      loadReconcile();
    }
    if (tabId === 'transactions') {
      loadTransactions();
    }
    if (tabId === 'bankmatch') {
      bmScopeChange();
    }
    if (tabId === 'groupmatch') {
      // เปิดแท็บครั้งแรก → โหลด "เดือนนี้" อัตโนมัติ ไม่ต้องกดจับคู่เอง
      if (!gmData && !gmInFlight) gmPreset('thisMonth');
    }
  });
});

// === รายการรายตัว (transaction browser) + ลบ ===
let txItems = [];
let txInFlight = false;
async function loadTransactions(force = false) {
  const box = document.getElementById('txContainer');
  if (!box || txInFlight) return;
  txInFlight = true;
  if (force) box.innerHTML = '<div class="report-loading">กำลังโหลด...</div>';
  try {
    const res = await fetch('/api/transactions', { cache: 'no-store' });
    const d = await res.json();
    if (!d.ok) { box.innerHTML = `<div class="info-card"><div style="color:var(--red);text-align:center;">${escHtml(d.error || 'โหลดไม่สำเร็จ')}</div></div>`; return; }
    txItems = d.items || [];
    setText('txUpdatedAt', `${txItems.length} รายการ · อัปเดต ${d.fetchedAt ? new Date(d.fetchedAt).toLocaleTimeString('th-TH') : ''}`);
    renderTransactions();
  } catch (_) { box.innerHTML = '<div class="info-card"><div style="color:var(--red);text-align:center;">โหลดไม่สำเร็จ</div></div>'; }
  finally { txInFlight = false; }
}

let txEditing = null; // hash ที่กำลังแก้ไข
const TX_TYPES = ['โอน', 'ถอน', 'ฝาก/รับ', 'ชำระบิล', 'อื่นๆ'];

function txFilterMatch(t) {
  const q = (document.getElementById('txSearch')?.value || '').trim().toLowerCase();
  if (q && !`${t.last4} ${t.counterparty} ${t.recipient_last4} ${t.bank} ${t.amount} ${t.date} ${t.tx_type} ${t.note}`.toLowerCase().includes(q)) return false;
  const from = document.getElementById('txFrom')?.value || '';
  const to = document.getElementById('txTo')?.value || '';
  const d = String(t.date || '').slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  const min = parseFloat(document.getElementById('txMin')?.value); if (!isNaN(min) && t.amount < min) return false;
  const max = parseFloat(document.getElementById('txMax')?.value); if (!isNaN(max) && t.amount > max) return false;
  const ty = document.getElementById('txType')?.value || '';
  if (ty && t.tx_type !== ty) return false;
  return true;
}

function renderTransactions() {
  const box = document.getElementById('txContainer');
  if (!box) return;
  const list = txItems.filter(txFilterMatch);
  const sum = list.reduce((a, t) => a + Number(t.amount || 0), 0);
  if (list.length === 0) { box.innerHTML = '<div class="info-card empty-state">ไม่พบรายการตามเงื่อนไข</div>'; return; }
  box.innerHTML = `<div class="tokchart-avg">พบ <b>${list.length}</b> รายการ · รวม <b>${fmtMoney(sum)}</b> ฿</div>
    <div class="tx-table"><div class="tx-row tx-head">
      <span>วันที่</span><span>บัญชี</span><span>ประเภท</span><span>ยอด</span><span>ค่าธรรม</span><span>ผู้รับ / หมายเหตุ</span><span></span></div>
    ${list.map(t => t.hash === txEditing ? renderTxEditForm(t) : renderTxRow(t)).join('')}</div>`;
}

function renderTxRow(t) {
  const ro = publicReadOnly;
  const recip = `${escHtml(t.counterparty || '-')}${t.recipient_last4 ? ` <span class="acc-bank">(****${escHtml(t.recipient_last4)})</span>` : ''}`;
  const note = t.note ? `<small class="tx-note">📝 ${escHtml(t.note)}</small>` : '';
  const link = t.driveLink ? `<a class="job-link" href="${escHtml(t.driveLink)}" target="_blank">🖼️</a>` : '';
  const acts = ro ? '' : `<button class="btn btn-sm tx-edit-btn" title="แก้ไข" onclick="editTransaction('${escHtml(t.hash)}')">✏️</button><button class="btn btn-sm tx-del" title="ลบ" onclick="deleteTransaction('${escHtml(t.last4)}','${escHtml(t.hash)}')">🗑️</button>`;
  return `<article class="tx-row">
    <span class="tx-date">${escHtml(t.date || '-')}</span>
    ${accCell(t.last4, t.bank || '')}
    <span>${escHtml(t.tx_type || '-')}</span>
    <span class="tx-amt">${fmtMoney(t.amount)}</span>
    <span class="tx-fee">${fmtMoney(t.fee)}</span>
    <span class="tx-recip">${recip}${note}</span>
    <span>${link} ${acts}</span>
  </article>`;
}

function renderTxEditForm(t) {
  const h = escHtml(t.hash);
  const opts = TX_TYPES.map(x => `<option value="${x}"${t.tx_type === x ? ' selected' : ''}>${x}</option>`).join('');
  return `<div class="tx-edit-row">
    <div class="tx-edit-grid">
      <label>วันที่<input id="ed-date-${h}" value="${escHtml(t.date || '')}"></label>
      <label>ยอดเงิน<input id="ed-amount-${h}" type="number" step="0.01" value="${escHtml(t.amount)}"></label>
      <label>ค่าธรรมเนียม<input id="ed-fee-${h}" type="number" step="0.01" value="${escHtml(t.fee)}"></label>
      <label>ประเภท<select id="ed-tx-${h}">${opts}</select></label>
      <label>ผู้รับ<input id="ed-cp-${h}" value="${escHtml(t.counterparty || '')}"></label>
      <label>เลขบัญชีผู้รับ<input id="ed-rl-${h}" value="${escHtml(t.recipient_last4 || '')}"></label>
      <label>ธนาคาร<input id="ed-bank-${h}" value="${escHtml(t.bank || '')}"></label>
      <label class="tx-edit-note">หมายเหตุ/ป้าย<input id="ed-note-${h}" value="${escHtml(t.note || '')}" placeholder="เช่น ลูกค้า A, ค่าของ"></label>
    </div>
    <div class="tx-edit-actions">
      <button class="btn btn-primary btn-sm" onclick="saveTxEdit('${escHtml(t.last4)}','${h}')">💾 บันทึก</button>
      <button class="btn btn-secondary btn-sm" onclick="cancelTxEdit()">ยกเลิก</button>
    </div>
  </div>`;
}

function clearTxFilters() {
  ['txSearch', 'txFrom', 'txTo', 'txMin', 'txMax'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
  const ty = document.getElementById('txType'); if (ty) ty.value = '';
  renderTransactions();
}

function txDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ส่งออก Excel (.xlsx) เฉพาะรายการที่กรองไว้ในหน้านี้
async function exportTxXlsx() {
  const list = txItems.filter(txFilterMatch);
  if (!list.length) return showToast('ไม่มีรายการให้ส่งออก (ลองล้างตัวกรอง)', 'info');
  try {
    const res = await fetch('/api/transactions/export-xlsx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: list }),
    });
    if (!res.ok) return showToast('ส่งออก Excel ไม่สำเร็จ', 'error');
    txDownload(await res.blob(), `รายการ_${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast(`⬇️ ส่งออก ${list.length} รายการ (Excel) แล้ว`, 'success');
  } catch (_) { showToast('ส่งออก Excel ไม่สำเร็จ', 'error'); }
}

// ส่งออก CSV เฉพาะรายการที่กรองไว้ (สร้างฝั่ง client + BOM ให้ Excel อ่านไทยได้)
function exportTxCsv() {
  const list = txItems.filter(txFilterMatch);
  if (!list.length) return showToast('ไม่มีรายการให้ส่งออก (ลองล้างตัวกรอง)', 'info');
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['วันที่', 'บัญชี', 'ธนาคาร', 'ประเภท', 'ยอดเงิน', 'ค่าธรรมเนียม', 'ผู้รับ', 'เลขบัญชีผู้รับ', 'หมายเหตุ'];
  let sumA = 0, sumF = 0;
  const lines = list.map(t => {
    sumA += Number(t.amount || 0); sumF += Number(t.fee || 0);
    return [t.date || '', t.last4 ? `****${t.last4}` : '', t.bank || '', t.tx_type || '',
      Number(t.amount || 0), Number(t.fee || 0), t.counterparty || '',
      t.recipient_last4 ? `****${t.recipient_last4}` : '', t.note || ''].map(esc).join(',');
  });
  const total = ['รวม', '', '', '', sumA, sumF, `${list.length} รายการ`, '', ''].map(esc).join(',');
  const csv = '﻿' + [head.map(esc).join(','), ...lines, total].join('\n');
  txDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `รายการ_${new Date().toISOString().slice(0, 10)}.csv`);
  showToast(`⬇️ ส่งออก ${list.length} รายการ (CSV) แล้ว`, 'success');
}

function editTransaction(hash) {
  if (publicReadOnly) return showToast('โหมดดูอย่างเดียว: แก้ไขไม่ได้', 'info');
  txEditing = hash; renderTransactions();
}
function cancelTxEdit() { txEditing = null; renderTransactions(); }

async function saveTxEdit(last4, hash) {
  const v = (p) => document.getElementById(`ed-${p}-${hash}`)?.value;
  const payload = {
    last4, hash,
    date: v('date'), amount: v('amount'), fee: v('fee'), tx_type: v('tx'),
    counterparty: v('cp'), recipient_last4: v('rl'), bank: v('bank'), note: v('note'),
  };
  try {
    const res = await fetch('/api/transactions/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const r = await res.json();
    if (!r.ok) return showToast('❌ ' + (r.error || 'แก้ไขไม่สำเร็จ'), 'error');
    showToast('✅ แก้ไขรายการแล้ว', 'success');
    txEditing = null;
    loadTransactions(true);
  } catch (_) { showToast('❌ แก้ไขไม่สำเร็จ', 'error'); }
}

async function deleteTransaction(last4, hash) {
  if (publicReadOnly) return showToast('โหมดดูอย่างเดียว: ลบไม่ได้', 'info');
  if (!confirm(`ลบรายการบัญชี ****${last4}${accName(last4) ? ` (${accName(last4)})` : ''} นี้? (ลบออกจากชีตถาวร)`)) return;
  try {
    const res = await fetch('/api/transactions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ last4, hash }) });
    const r = await res.json();
    if (!r.ok) return showToast('❌ ' + (r.error || 'ลบไม่สำเร็จ'), 'error');
    showToast('✅ ลบรายการแล้ว', 'success');
    txItems = txItems.filter(t => !(t.last4 === last4 && t.hash === hash));
    renderTransactions();
  } catch (_) { showToast('❌ ลบไม่สำเร็จ', 'error'); }
}

async function loadAudit() {
  const box = document.getElementById('auditContainer');
  if (!box) return;
  try {
    const res = await fetch('/api/audit', { cache: 'no-store' });
    const d = await res.json();
    const items = (d.ok && d.items) || [];
    if (items.length === 0) { box.innerHTML = '<div class="prov-empty">ยังไม่มีบันทึก</div>'; return; }
    const ACT = { 'wipe-all': '🗑️ ล้างข้อมูล', 'review-confirm': '✅ ยืนยันคิว', 'review-discard': '🗑️ ทิ้งคิว', 'settings-save': '⚙️ แก้ตั้งค่า', 'tx-delete': '🗑️ ลบรายการ', 'tx-edit': '✏️ แก้รายการ' };
    box.innerHTML = items.map(a => `
      <div class="audit-row">
        <span class="audit-act">${ACT[a.action] || a.action}</span>
        <span class="audit-detail">${escHtml(a.detail || '')}</span>
        <span class="audit-meta">${escHtml(a.user || '-')} · ${a.at ? new Date(a.at).toLocaleString('th-TH') : ''}</span>
      </div>`).join('');
  } catch (_) { box.innerHTML = '<div class="prov-empty">โหลดไม่สำเร็จ</div>'; }
}

// === เทียบยอดธนาคาร (bank match) — ดึง debittrans API มาจับคู่กับสลิป ===
let bmData = null;
let bmInFlight = false;

function bmScopeChange() {
  const scope = document.getElementById('bmScope')?.value || 'all';
  // ใช้ style.display (inline ชนะ .tx-filters label{display:flex} — attribute hidden ใช้ไม่ได้เพราะ CSS ทับ)
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('bmDateWrap', scope === 'day');
  show('bmFromWrap', scope === 'range');
  show('bmToWrap', scope === 'range');
  show('bmMonthWrap', scope === 'month');

  // เติมค่า default ให้เลย ไม่ต้องเลือกวันเอง (วันนี้ / เดือนนี้ / ต้นเดือน→วันนี้) ตามเวลาเครื่อง
  const now = new Date(), pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const setIfEmpty = (id, val) => { const el = document.getElementById(id); if (el && !el.value) el.value = val; };
  if (scope === 'day') setIfEmpty('bmDate', today);
  if (scope === 'month') setIfEmpty('bmMonth', today.slice(0, 7));
  if (scope === 'range') { setIfEmpty('bmFrom', today.slice(0, 8) + '01'); setIfEmpty('bmTo', today); }
}

// เติมรายชื่อบัญชีลง dropdown จากผลเทียบ (คงค่าที่เลือกไว้ถ้ายังมี)
function populateBmAccounts(d) {
  const sel = document.getElementById('bmAccount');
  if (!sel) return;
  const cur = sel.value;
  const accs = (d.byAccount || []).map(a => a.last4).filter(Boolean);
  sel.innerHTML = '<option value="">ทุกบัญชี (รวม)</option>'
    + accs.map(a => `<option value="${escHtml(a)}">****${escHtml(a)}${accName(a) ? ` · ${escHtml(accName(a))}` : ''}</option>`).join('');
  sel.value = accs.includes(cur) ? cur : '';
}

async function loadBankMatch() {
  const box = document.getElementById('bmContainer');
  if (!box || bmInFlight) return;
  bmInFlight = true;
  box.innerHTML = '<div class="report-loading">⏳ กำลังเทียบกับธนาคาร...</div>';
  try {
    const scope = document.getElementById('bmScope')?.value || 'all';
    const p = new URLSearchParams({ scope });
    if (scope === 'day') p.set('date', document.getElementById('bmDate')?.value || '');
    if (scope === 'range') { p.set('from', document.getElementById('bmFrom')?.value || ''); p.set('to', document.getElementById('bmTo')?.value || ''); }
    if (scope === 'month') p.set('month', document.getElementById('bmMonth')?.value || '');
    // ดึงทุกบัญชีมาเสมอ แล้วใช้ dropdown กรองฝั่ง client (เลือกบัญชีไม่ต้องดึงใหม่)
    const res = await fetch('/api/bankmatch?' + p.toString(), { cache: 'no-store' });
    const d = await res.json();
    if (!d.ok) { box.innerHTML = `<div class="info-card"><div style="color:var(--red);text-align:center;">${escHtml(d.error || 'เทียบไม่สำเร็จ')}</div></div>`; bmData = null; return; }
    bmData = d;
    populateBmAccounts(d);
    setText('bmUpdatedAt', `อัปเดต ${d.fetchedAt ? new Date(d.fetchedAt).toLocaleString('th-TH') : ''}`);
    renderBankMatch();
  } catch (_) { box.innerHTML = '<div class="info-card"><div style="color:var(--red);text-align:center;">เทียบไม่สำเร็จ</div></div>'; }
  finally { bmInFlight = false; }
}

function bmRow(x, kind) {
  const extra = kind === 'matched'
    ? `<span class="acc-bank">${x.via === 'gross' ? 'รวมค่าธรรมเนียม' : 'ตรง'}</span>`
    : (kind === 'bank' ? `<span class="acc-bank">${escHtml(x.status || '-')}</span>` : `<span class="acc-bank">${escHtml(x.counterparty || '-')}</span>`);
  return `<div class="tx-row">
    <span>${escHtml(x.day || '')}${x.time ? ' ' + escHtml(x.time) : ''}</span>
    ${x.last4 ? accCell(x.last4, '') : '<span>-</span>'}
    <span>${escHtml(x.tx_type || '-')}</span>
    <span>${fmtMoney(x.amount)} ฿</span>
    <span>${escHtml(x.bank || '-')}</span>
    ${extra}</div>`;
}

function bmList(title, arr, kind, hint) {
  if (!arr || !arr.length) return '';
  return `<div class="info-card" style="margin-top:.75rem;">
    <h3>${title} · ${arr.length} รายการ</h3>
    ${hint ? `<p class="subtitle">${hint}</p>` : ''}
    <div class="tx-table bm-table"><div class="tx-row tx-head"><span>วัน/เวลา</span><span>บัญชี</span><span>ประเภท</span><span>ยอด</span><span>ธนาคาร</span><span>สถานะ/ผู้รับ</span></div>
    ${arr.map(x => bmRow(x, kind)).join('')}</div></div>`;
}

function renderBankMatch() {
  const box = document.getElementById('bmContainer');
  if (!box || !bmData) return;
  const d = bmData;
  const acc = document.getElementById('bmAccount')?.value || ''; // '' = ทุกบัญชี
  const flt = (arr) => acc ? (arr || []).filter(x => x.last4 === acc) : (arr || []);
  const matched = flt(d.matched), bankOnly = flt(d.bankOnly), slipOnly = flt(d.slipOnly);
  const sumA = (arr) => arr.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const sumSlip = (arr) => arr.reduce((a, x) => a + (Number(x.slip && x.slip.amount) || 0), 0);

  const warn = !d.bankApiOk ? `<div class="info-card" style="border-color:var(--red);"><div style="color:var(--red);">⚠️ ดึงรายการธนาคารไม่ได้: ${escHtml(d.bankApiError || '')} — ตอนนี้เทียบกับ “ศูนย์รายการธนาคาร” (สลิปทั้งหมดจะขึ้นเป็น “เกินสลิป”) เช็กว่า debittrans deploy API + ตั้ง key แล้วหรือยัง</div></div>` : '';

  // ยอดรวม: ถ้าเลือก "ทุกบัญชี" ใช้ summary จาก server; ถ้าเลือกบัญชีเดียว คำนวณจากรายการที่กรองแล้ว
  const bankCount = matched.length + bankOnly.length;
  const slipCount = matched.length + slipOnly.length;
  const bankTotal = acc ? sumA(matched) + sumA(bankOnly) : d.summary.bankTotal;
  const slipTotal = acc ? sumSlip(matched) + sumA(slipOnly) : d.summary.slipTotal;
  const scopeTag = acc ? ` · เฉพาะบัญชี ****${escHtml(acc)}${accName(acc) ? ` ${escHtml(accName(acc))}` : ''}` : '';
  const chips = `<div class="tokchart-avg">
    🏦 ธนาคาร <b>${bankCount}</b> (${fmtMoney(bankTotal)} ฿) · 🧾 สลิป <b>${slipCount}</b> (${fmtMoney(slipTotal)} ฿)${scopeTag}<br>
    ✅ ตรงกัน <b>${matched.length}</b> (${fmtMoney(sumA(matched))} ฿) · ⚠️ ขาดสลิป <b>${bankOnly.length}</b> (${fmtMoney(sumA(bankOnly))} ฿) · 🟡 เกินสลิป <b>${slipOnly.length}</b> (${fmtMoney(sumA(slipOnly))} ฿)
  </div>`;

  // ตารางสรุปแยกรายบัญชี — โชว์เฉพาะตอนเลือก "ทุกบัญชี" (คลิกบัญชีเพื่อกรอง)
  let accTable = '';
  if (!acc && (d.byAccount || []).length > 1) {
    const rows = d.byAccount.map(a => `<div class="tx-row bm-acc-row" onclick="bmPickAccount('${escHtml(a.last4)}')" style="cursor:pointer;">
      <span>****${escHtml(a.last4 || '-')}${accNameTag(a.last4)}</span>
      <span>✅ ${a.matchedCount} (${fmtMoney(a.matchedTotal)})</span>
      <span>⚠️ ${a.bankOnlyCount} (${fmtMoney(a.bankOnlyTotal)})</span>
      <span>🟡 ${a.slipOnlyCount} (${fmtMoney(a.slipOnlyTotal)})</span></div>`).join('');
    accTable = `<div class="info-card" style="margin-top:.75rem;"><h3>แยกรายบัญชี <span class="subtitle">(คลิกบัญชีเพื่อดูเฉพาะตัวนั้น)</span></h3>
      <div class="tx-table bm-acc-table"><div class="tx-row tx-head"><span>บัญชี</span><span>ตรงกัน</span><span>ขาดสลิป</span><span>เกินสลิป</span></div>
      ${rows}</div></div>`;
  }

  const empty = (matched.length + bankOnly.length + slipOnly.length) === 0
    ? '<div class="info-card empty-state" style="margin-top:.75rem;">ไม่พบรายการในช่วง/บัญชีที่เลือก</div>' : '';

  box.innerHTML = warn + chips + empty + accTable
    + bmList('⚠️ ขาดสลิป', bankOnly, 'bank', 'มีในธนาคาร แต่ไม่มีสลิปที่บันทึก')
    + bmList('🟡 เกินสลิป', slipOnly, 'slip', 'มีสลิปที่บันทึก แต่ไม่เจอในธนาคาร')
    + bmList('✅ ตรงกัน', matched, 'matched', 'ยอดธนาคารจับคู่กับสลิปได้');
}

// คลิกแถวบัญชีในตารางสรุป → เลือกใน dropdown แล้ว re-render
function bmPickAccount(last4) {
  const sel = document.getElementById('bmAccount');
  if (sel) { sel.value = last4; renderBankMatch(); }
}

// === จับคู่ประกาศกลุ่ม (group match) — กระทบยอดรายวัน + รายบัญชี ===
let gmData = null, gmInFlight = false, gmView = 'day';
const GM_PRESETS = ['today', 'yesterday', '7d', '30d', 'thisMonth', 'lastMonth', 'all'];

function gmSetChip(kind) {
  GM_PRESETS.forEach(k => {
    const el = document.getElementById('gmp-' + k);
    if (el) el.classList.toggle('chip-active', kind === k);
  });
}

// ช่วงเร็ว: today | yesterday | 7d | 30d | thisMonth | lastMonth | all
function gmPreset(kind) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  let from = new Date(today), to = new Date(today);
  if (kind === 'yesterday') { from.setDate(today.getDate() - 1); to.setDate(today.getDate() - 1); }
  else if (kind === '7d') from.setDate(today.getDate() - 6);
  else if (kind === '30d') from.setDate(today.getDate() - 29);
  else if (kind === 'thisMonth') from = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (kind === 'lastMonth') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = new Date(today.getFullYear(), today.getMonth(), 0);
  }
  const dEl = document.getElementById('gmDay'); if (dEl) dEl.value = '';
  const fEl = document.getElementById('gmFrom'), tEl = document.getElementById('gmTo');
  if (kind === 'all') { if (fEl) fEl.value = ''; if (tEl) tEl.value = ''; }
  else { if (fEl) fEl.value = fmt(from); if (tEl) tEl.value = fmt(to); }
  gmSetChip(kind);
  loadGroupMatch();
}

// เลือกดูวันเดียว — จับคู่ทันที
function gmPickDay() {
  const v = document.getElementById('gmDay')?.value || '';
  if (!v) return;
  ['gmFrom', 'gmTo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  gmSetChip(null);
  loadGroupMatch();
}

// กดกรองช่วง from–to เอง
function gmApplyRange() {
  const dEl = document.getElementById('gmDay'); if (dEl) dEl.value = '';
  gmSetChip(null);
  loadGroupMatch();
}

function gmParams() {
  const day = document.getElementById('gmDay')?.value || '';
  if (day) return new URLSearchParams({ scope: 'day', date: day });
  const from = document.getElementById('gmFrom')?.value || '';
  const to = document.getElementById('gmTo')?.value || '';
  if (from || to) return new URLSearchParams({ scope: 'range', from: from || to, to: to || from });
  return new URLSearchParams({ scope: 'all' });
}

async function loadGroupMatch() {
  const box = document.getElementById('gmContainer');
  if (!box || gmInFlight) return;
  gmInFlight = true;
  box.innerHTML = '<div class="report-loading">⏳ กำลังจับคู่ประกาศกับสลิป...</div>';
  try {
    const res = await fetch('/api/groupmatch?' + gmParams().toString(), { cache: 'no-store' });
    const d = await res.json();
    if (!d.ok) { box.innerHTML = `<div class="info-card"><div style="color:var(--red);text-align:center;">${escHtml(d.error || 'จับคู่ไม่สำเร็จ')}</div></div>`; gmData = null; return; }
    gmData = d;
    populateGmAccounts(d);
    setText('gmUpdatedAt', `อัปเดต ${d.fetchedAt ? new Date(d.fetchedAt).toLocaleString('th-TH') : ''}`);
    renderGroupMatch();
  } catch (_) { gmData = null; box.innerHTML = '<div class="info-card"><div style="color:var(--red);text-align:center;">จับคู่ไม่สำเร็จ</div></div>'; }
  finally { gmInFlight = false; }
}

function populateGmAccounts(d) {
  const sel = document.getElementById('gmAccount');
  if (sel) {
    const cur = sel.value;
    const accs = (d.accounts || []).map(a => a.last4).filter(x => x && x !== '-');
    sel.innerHTML = '<option value="">ทุกบัญชี</option>'
      + accs.map(a => `<option value="${escHtml(a)}">****${escHtml(a)}</option>`).join('');
    sel.value = accs.includes(cur) ? cur : '';
  }
  // dropdown อิโมจิ จากข้อมูลจริงในช่วง (🔥 ก่อนเสมอ, ⏳ = ยังไม่มี react)
  const esel = document.getElementById('gmEmoji');
  if (esel) {
    const cur = esel.value;
    const opts = (d.byEmoji || []).map(e => e.emoji || '⏳');
    esel.innerHTML = '<option value="">ทั้งหมด</option>'
      + opts.map(e => `<option value="${escHtml(e)}">${escHtml(e === '⏳' ? '⏳ รอ react' : e)}</option>`).join('');
    esel.value = opts.includes(cur) ? cur : '';
  }
}

function gmSetView(v) {
  gmView = v;
  [['gmv-day', 'day'], ['gmv-account', 'account'], ['gmv-ann', 'ann']].forEach(([id, k]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('chip-active', v === k);
  });
  renderGroupMatch();
}

const GM_STATUS = {
  no_slip:   { label: 'ยังไม่โอน', icon: '🔴', cls: 'gm-nosl' },
  short:     { label: 'โอนไม่ครบ', icon: '🟠', cls: 'gm-short' },
  over:      { label: 'โอนเกิน', icon: '🟡', cls: 'gm-over' },
  slip_only: { label: 'โอนไม่มีประกาศ', icon: '🔵', cls: 'gm-slip' },
  ok:        { label: 'โอนครบ', icon: '✅', cls: 'gm-ok' },
};

// วันที่ไทยอ่านง่าย: "ศ. 12 ก.ค. 69"
const GM_TH_WD = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const GM_TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function gmThaiDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${GM_TH_WD[d.getDay()]} ${Number(m[3])} ${GM_TH_MON[Number(m[2]) - 1]} ${String((Number(m[1]) + 543) % 100).padStart(2, '0')}`;
}

// ตัวกรอง สถานะ+บัญชี (ใช้ทั้งมุมมองรายวันและรายบัญชี)
function gmFilterAccounts(arr) {
  const acc = document.getElementById('gmAccount')?.value || '';
  const st = document.getElementById('gmStatus')?.value || '';
  let out = arr || [];
  if (acc) out = out.filter(a => a.last4 === acc);
  if (st === 'problem') out = out.filter(a => a.status === 'short' || a.status === 'over');
  else if (st) out = out.filter(a => a.status === st);
  return out;
}

// แถวกระทบยอด 1 บัญชี (ใช้ร่วมทั้ง 2 มุมมอง)
function gmAcctRow(a) {
  const st = GM_STATUS[a.status] || { label: a.status, icon: '', cls: '' };
  const diffTxt = Math.abs(a.diff) < 1 ? '-' : (a.diff > 0 ? '<span class="gm-d-short">−' + fmtMoney(a.diff) + '</span>' : '<span class="gm-d-over">+' + fmtMoney(-a.diff) + '</span>');
  return `<div class="tx-row gm-acct ${st.cls}">
    <span><strong>****${escHtml(a.last4)}</strong>${a.name ? ` <span class="acc-bank">${escHtml(a.name)}</span>` : ''}</span>
    <span>${escHtml(a.bank || '-')}</span>
    <span>${fmtMoney(a.announced)}${a.announceCount > 1 ? ` <small>×${a.announceCount}</small>` : ''}</span>
    <span>${fmtMoney(a.transferred)}${a.slipCount > 1 ? ` <small>×${a.slipCount}</small>` : ''}</span>
    <span>${diffTxt}</span>
    <span class="gm-badge">${st.icon} ${st.label}</span></div>`;
}
const GM_TABLE_HEAD = '<div class="tx-row tx-head"><span>บัญชี / ชื่อ</span><span>ธนาคาร</span><span>ประกาศ</span><span>โอนจริง</span><span>ต่าง</span><span>สถานะ</span></div>';

// ── การ์ดสรุปบนสุด ──
function renderGmStats(sm) {
  const el = document.getElementById('gmStats');
  if (!el) return;
  const tile = (label, value, sub, cls) => `<div class="gm-stat ${cls || ''}"><small>${label}</small><strong>${value}</strong>${sub ? `<span>${sub}</span>` : ''}</div>`;
  el.innerHTML =
    tile('🔥 ประกาศเข้าจับคู่', fmtMoney(sm.announcedTotal) + ' ฿', `${sm.fireCount ?? 0} รายการ · ${sm.accountCount ?? 0} บัญชี · ${sm.dayCount ?? 0} วัน`) +
    tile('📄 โอนจริง', fmtMoney(sm.transferredTotal) + ' ฿', `โอนครบ ${sm.okCount ?? 0} บัญชี`) +
    tile('⚠️ ยังขาด', fmtMoney(sm.shortTotal) + ' ฿', `ยังไม่โอน ${sm.noSlipCount ?? 0} · ไม่ครบ ${sm.shortCount ?? 0}`, 'gm-stat-bad') +
    tile('🏧 ถอน ATM', fmtMoney(sm.atmTotal) + ' ฿', `${sm.atmCount ?? 0} ใบ · ไม่นับกระทบยอด`, 'gm-stat-mut');
}

// แถบสรุปอิโมจิ (ทุกประกาศ ไม่ใช่แค่ไฟ) — คลิกเพื่อกรอง+เปิดมุมมองประกาศ
function renderGmEmojiBar(byEmoji) {
  const el = document.getElementById('gmEmojiBar');
  if (!el) return;
  if (!byEmoji || !byEmoji.length) { el.innerHTML = ''; return; }
  el.innerHTML = byEmoji.map(e => {
    const emo = e.emoji || '⏳';
    const label = emo === '⏳' ? '⏳ รอ react' : emo;
    return `<button class="gm-emoji-chip${emo === '🔥' ? ' gm-emoji-fire' : ''}" onclick="gmPickEmoji('${escHtml(emo)}')" title="ดูรายการประกาศอิโมจิ ${escHtml(label)}">
      ${escHtml(label)} <b>${e.count}</b> · ${fmtMoney(e.total)} ฿${emo === '🔥' ? ' <small>เข้าจับคู่</small>' : ''}</button>`;
  }).join('');
}
function gmPickEmoji(emo) {
  const sel = document.getElementById('gmEmoji');
  if (sel) sel.value = emo;
  gmSetView('ann');
}

// ── กราฟรายวัน: ประกาศ vs โอนจริง (แท่งคู่แนวนอน คลิกวันเพื่อเจาะ) ──
function renderGmChart(days) {
  const card = document.getElementById('gmChartCard'), box = document.getElementById('gmChart');
  if (!card || !box) return;
  const ds = [...(days || [])].sort((a, b) => (a.date < b.date ? -1 : 1)); // เก่า→ใหม่ อ่านเป็นไทม์ไลน์
  if (ds.length < 2) { card.style.display = 'none'; return; }
  card.style.display = '';
  const max = Math.max(...ds.map(d => Math.max(d.announced, d.transferred)), 1);
  box.innerHTML = ds.map(d => {
    const wA = d.announced > 0 ? Math.max(Math.round(d.announced / max * 100), 2) : 0;
    const wT = d.transferred > 0 ? Math.max(Math.round(d.transferred / max * 100), 2) : 0;
    return `<div class="gmc-row" onclick="gmChartPick('${escHtml(d.date)}')" title="ประกาศ ${fmtMoney(d.announced)} ฿ · โอนจริง ${fmtMoney(d.transferred)} ฿ — คลิกเพื่อเจาะดูวันนี้">
      <span class="gmc-date">${gmThaiDate(d.date)}</span>
      <span class="gmc-bars"><i class="gmc-bar gmc-ann" style="width:${wA}%"></i><i class="gmc-bar gmc-tr" style="width:${wT}%"></i></span>
      <span class="gmc-vals">${fmtMoney(d.announced)}<small> / ${fmtMoney(d.transferred)}</small></span>
    </div>`;
  }).join('');
}
function gmChartPick(date) { const el = document.getElementById('gmDay'); if (el) { el.value = date; gmPickDay(); } }

// ── การ์ดรายวัน: หัววันที่ชัด + สรุป + ตารางบัญชี (ปัญหาก่อน, โอนครบพับไว้) ──
function gmDayCard(d) {
  const stFilter = document.getElementById('gmStatus')?.value || '';
  const all = gmFilterAccounts(d.accounts);
  const main = stFilter ? all : all.filter(a => a.status !== 'ok');
  const okList = stFilter ? [] : all.filter(a => a.status === 'ok');
  const short = d.shortTotal > 0 ? ` · <span class="gm-d-short">ขาด ${fmtMoney(d.shortTotal)} ฿</span>` : '';
  const rows = main.map(gmAcctRow).join('');
  const okBlock = okList.length
    ? `<details class="gm-ok-details"><summary>✅ โอนครบ ${okList.length} บัญชี — กดเพื่อดู</summary><div class="tx-table gm-table">${GM_TABLE_HEAD}${okList.map(gmAcctRow).join('')}</div></details>`
    : '';
  return `<div class="info-card gm-day-card">
    <div class="gm-day-head">
      <div class="gm-day-title"><h3>📅 ${gmThaiDate(d.date)}</h3><span class="gm-day-iso">${escHtml(d.date)}</span></div>
      <div class="gm-day-sum">ประกาศ 🔥 <b>${fmtMoney(d.announced)}</b> ฿ <small>(${d.announceCount} รายการ)</small> · โอนจริง <b>${fmtMoney(d.transferred)}</b> ฿ <small>(${d.slipCount} สลิป)</small>${short}</div>
      <div class="gm-day-badges">✅ ครบ ${d.okCount} · 🔴 ยังไม่โอน ${d.noSlipCount} · 🟠 ไม่ครบ ${d.shortCount} · 🟡 เกิน ${d.overCount} · 🔵 ไม่มีประกาศ ${d.slipOnlyCount}${d.atmCount ? ` · 🏧 ATM ${d.atmCount}` : ''}</div>
      ${(d.byEmoji && d.byEmoji.length) ? `<div class="gm-day-emoji">${d.byEmoji.map(e => `${escHtml(e.emoji || '⏳')} ${e.count}·${fmtMoney(e.total)}`).join(' &nbsp;·&nbsp; ')}</div>` : ''}
    </div>
    ${main.length ? `<div class="tx-table gm-table">${GM_TABLE_HEAD}${rows}</div>` : (stFilter ? '<div class="empty-state" style="padding:6px 0;">ไม่มีบัญชีตามตัวกรองในวันนี้</div>' : '<div class="gm-day-clear">🎉 วันนี้กระทบยอดครบทุกบัญชี</div>')}
    ${okBlock}
  </div>`;
}

// แถวรายการประกาศรายตัว (มุมมอง 📃 ประกาศ)
function gmAnnRow(a) {
  const emo = a.emoji || '⏳';
  return `<div class="tx-row gm-ann-row${a.fire ? ' gm-ann-fire' : ''}">
    <span>${escHtml(a.date || '')}${a.time ? ' ' + escHtml(a.time) : ''}</span>
    <span><strong>****${escHtml(a.last4 || '-')}</strong>${a.name ? ` <span class="acc-bank">${escHtml(a.name)}</span>` : ''}</span>
    <span>${escHtml(a.bank || '-')}</span>
    <span>${fmtMoney(a.amount)}</span>
    <span class="gm-ann-emo" title="${escHtml(a.reacts || '')}">${escHtml(a.reacts || emo)}</span>
    <span>${a.fire ? '🔥 เข้าจับคู่' : '<span class="acc-bank">ไม่จับคู่</span>'}</span></div>`;
}

function renderGroupMatch() {
  const box = document.getElementById('gmContainer');
  if (!box || !gmData) return;
  const d = gmData;
  renderGmStats(d.summary || {});
  renderGmEmojiBar(d.byEmoji || []);
  renderGmChart(d.days || []);
  if (gmView === 'account') {
    const accounts = gmFilterAccounts(d.accounts);
    box.innerHTML = accounts.length
      ? `<div class="info-card"><h3>กระทบยอดรายบัญชี 🔥 (รวมทั้งช่วง) <span class="subtitle">เฉพาะประกาศติดไฟ · เรียงบัญชีที่มีปัญหาก่อน</span></h3><div class="tx-table gm-table">${GM_TABLE_HEAD}${accounts.map(gmAcctRow).join('')}</div></div>`
      : '<div class="info-card empty-state">ไม่พบบัญชีตามตัวกรอง</div>';
  } else if (gmView === 'ann') {
    const acc = document.getElementById('gmAccount')?.value || '';
    const emo = document.getElementById('gmEmoji')?.value || '';
    let list = d.announcements || [];
    if (acc) list = list.filter(a => a.last4 === acc);
    if (emo) list = list.filter(a => (a.emoji || '⏳') === emo);
    const total = list.reduce((t, a) => t + (Number(a.amount) || 0), 0);
    const head = '<div class="tx-row tx-head"><span>วัน/เวลา</span><span>บัญชี / ชื่อ</span><span>ธนาคาร</span><span>ยอด</span><span>react</span><span>จับคู่</span></div>';
    box.innerHTML = list.length
      ? `<div class="info-card"><h3>📃 รายการประกาศ ${emo ? escHtml(emo === '⏳' ? '⏳ รอ react' : emo) + ' ' : ''}· ${list.length} รายการ <span class="subtitle">รวม ${fmtMoney(total)} ฿</span></h3><div class="tx-table gm-ann-table">${head}${list.map(gmAnnRow).join('')}</div></div>`
      : '<div class="info-card empty-state">ไม่พบประกาศตามตัวกรอง</div>';
  } else {
    const days = d.days || [];
    box.innerHTML = days.length ? days.map(gmDayCard).join('') : '<div class="info-card empty-state">ไม่พบข้อมูลในช่วงที่เลือก</div>';
  }
}

function exportGroupXlsx() {
  window.open('/api/groupmatch/export-xlsx?' + gmParams().toString(), '_blank');
}

// รีเช็ครายวัน (รูปที่ส่ง vs บันทึก) — แสดงในแท็บ Log
async function loadReconcile() {
  const box = document.getElementById('reconcileContainer');
  if (!box) return;
  try {
    const res = await fetch('/api/reconcile', { cache: 'no-store' });
    const d = await res.json();
    const items = (d.ok && d.items) || [];
    if (items.length === 0) { box.innerHTML = '<div class="prov-empty">ยังไม่มีผลรีเช็ค (ระบบจะตรวจอัตโนมัติทุกวัน 23:55)</div>'; return; }
    box.innerHTML = items.map(r => {
      const ok = r.matched;
      const badge = ok ? '<span class="rec-badge ok">✔️ ตรงกัน</span>' : `<span class="rec-badge warn">⚠️ ไม่ตรง (เหลือ ${r.leftover})</span>`;
      return `<div class="rec-row ${ok ? '' : 'rec-warn'}">
        <div class="rec-head"><strong>${escHtml(r.date)}</strong> ${badge}</div>
        <div class="rec-stats">
          <span>📥 ส่งเข้า <b>${r.received}</b></span>
          <span>✅ บันทึก <b>${r.done}</b></span>
          <span>🟡 รอตรวจ <b>${r.review}</b></span>
          <span>♻️ ซ้ำ <b>${r.duplicate}</b></span>
          <span>❌ ล้มเหลว <b>${r.failed}</b></span>
          ${r.pending ? `<span>⏳ ค้าง <b>${r.pending}</b></span>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (_) { box.innerHTML = '<div class="prov-empty">โหลดไม่สำเร็จ</div>'; }
}

// === Load Settings on page load ===
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    latestSettings = data || {};
    // โหมดดูอย่างเดียว (viewer) → publicReadOnly = true (ปุ่มแก้ไขทั้งหมดถูกบล็อก)
    if (typeof data.READ_ONLY === 'boolean') { publicReadOnly = data.READ_ONLY; applyRoleUI(data.ROLE, data.READ_ONLY); }
    if (document.getElementById('dashPin')) document.getElementById('dashPin').value = data.DASHBOARD_PIN || '';
    document.getElementById('telegramToken').value = data.TELEGRAM_BOT_TOKEN || '';
    document.getElementById('geminiKey').value = data.GEMINI_API_KEY || '';
    if (document.getElementById('openaiKey')) document.getElementById('openaiKey').value = data.OPENAI_API_KEY || '';
    if (document.getElementById('typhoonKey')) document.getElementById('typhoonKey').value = data.TYPHOON_API_KEY || '';
    populateModelDropdowns(data.SUPPORTED_MODELS || [], data);
    document.getElementById('spreadsheetId').value = data.SPREADSHEET_ID || '';
    document.getElementById('summaryChatId').value = data.SUMMARY_CHAT_ID || '';
    document.getElementById('dashUser').value = data.DASHBOARD_USER || 'admin';
    document.getElementById('dashPass').value = data.DASHBOARD_PASS || 'admin';
    document.getElementById('allowedChats').value = data.ALLOWED_CHAT_IDS || '';

    if (data.HAS_CREDENTIALS) {
      const zone = document.getElementById('credDropZone');
      zone.classList.add('uploaded');
      document.getElementById('credStatus').innerHTML = '<span class="upload-icon">✅</span><p>credentials.json — พร้อมใช้งาน</p>';
    }
    refreshMaskedHelp();
    await loadConfigStatus(data);
  } catch (e) {
    console.error('Failed to load settings', e);
    renderConfigSummary(buildConfigSummary(), 'Unable to load /api/settings or /api/config-status.');
  }
}

// เติม option โมเดลลง dropdown หลัก/สำรอง (สำรองมี "ไม่ใช้ (none)")
function populateModelDropdowns(models, data) {
  const mk = (withNone) => {
    const opts = models.map(m => `<option value="${m.id}">${m.label || m.id}</option>`);
    if (withNone) opts.push('<option value="none">— ไม่ใช้ —</option>');
    return opts.join('');
  };
  const primary = document.getElementById('ocrModel');
  const fb1 = document.getElementById('ocrFallback1');
  const fb2 = document.getElementById('ocrFallback2');
  if (primary) { primary.innerHTML = mk(false); primary.value = data.OCR_MODEL || 'gemini-2.5-flash'; }
  if (fb1) { fb1.innerHTML = mk(true); fb1.value = data.OCR_FALLBACK_1 || 'typhoon-ocr'; }
  if (fb2) { fb2.innerHTML = mk(true); fb2.value = data.OCR_FALLBACK_2 || 'gpt-4o'; }
}

// บันทึกเฉพาะส่วนโมเดล/คีย์ OCR แล้วมีผลทันที (ใช้ /api/settings เดิมซึ่ง reload env ในตัว)
async function saveOcrSettings() {
  const status = document.getElementById('ocrSaveStatus');
  if (publicReadOnly) {
    if (status) status.textContent = '⚠️ โหมดสาธารณะบันทึกไม่ได้ — ใช้แดชบอร์ดเครื่องที่รันบอท';
    return showToast('โหมดสาธารณะ: บันทึกไม่ได้', 'info');
  }
  const payload = {
    OCR_MODEL: document.getElementById('ocrModel')?.value || '',
    OCR_FALLBACK_1: document.getElementById('ocrFallback1')?.value || '',
    OCR_FALLBACK_2: document.getElementById('ocrFallback2')?.value || '',
  };
  omitMaskedSecret(payload, 'OPENAI_API_KEY', 'openaiKey');
  omitMaskedSecret(payload, 'TYPHOON_API_KEY', 'typhoonKey');
  if (status) status.textContent = 'กำลังบันทึก...';
  try {
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (r.ok) {
      if (status) status.textContent = '✅ บันทึกแล้ว ใช้งานได้ทันที';
      showToast('✅ บันทึกโมเดล OCR แล้ว — มีผลทันที', 'success');
      await loadSettings();
    } else {
      const msg = (r.details && r.details.join(', ')) || r.error || 'ผิดพลาด';
      if (status) status.textContent = '❌ ' + msg;
      showToast('❌ ' + msg, 'error');
    }
  } catch (e) {
    if (status) status.textContent = '❌ บันทึกไม่สำเร็จ';
    showToast('❌ บันทึกไม่สำเร็จ', 'error');
  }
}

// === Save Settings ===
async function saveSettings(e) {
  e.preventDefault();
  if (publicReadOnly) {
    showToast('Public dashboard is read-only. Settings were not saved.', 'info');
    return;
  }
  // ส่งเฉพาะ "ช่องที่เปลี่ยนจากค่าที่โหลดมา" — ไม่ต้องกรอกทุกช่อง ช่องที่ไม่แตะจะคงค่าเดิม
  const payload = {};
  const addIfChanged = (key, id, isSecret) => {
    const el = document.getElementById(id);
    if (!el) return;
    const val = (el.value || '').trim();
    const loaded = String(latestSettings[key] == null ? '' : latestSettings[key]);
    if (isSecret) {
      // secret: ส่งเฉพาะเมื่อกรอกค่าจริง (ไม่ใช่ ****) และต่างจากเดิม
      if (val && !isMaskedSecret(val) && val !== loaded) payload[key] = val;
    } else if (val !== loaded) {
      payload[key] = val;
    }
  };
  addIfChanged('SPREADSHEET_ID', 'spreadsheetId');
  addIfChanged('SUMMARY_CHAT_ID', 'summaryChatId');
  addIfChanged('DASHBOARD_USER', 'dashUser');
  addIfChanged('ALLOWED_CHAT_IDS', 'allowedChats');
  addIfChanged('OCR_MODEL', 'ocrModel');
  addIfChanged('OCR_FALLBACK_1', 'ocrFallback1');
  addIfChanged('OCR_FALLBACK_2', 'ocrFallback2');
  addIfChanged('TELEGRAM_BOT_TOKEN', 'telegramToken', true);
  addIfChanged('GEMINI_API_KEY', 'geminiKey', true);
  addIfChanged('OPENAI_API_KEY', 'openaiKey', true);
  addIfChanged('TYPHOON_API_KEY', 'typhoonKey', true);
  addIfChanged('DASHBOARD_PASS', 'dashPass', true);
  addIfChanged('DASHBOARD_PIN', 'dashPin', true);

  if (Object.keys(payload).length === 0) {
    showToast('ℹ️ ไม่มีช่องที่เปลี่ยนแปลง', 'info');
    return;
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.ok) {
      const n = Object.keys(payload).length;
      showToast(`✅ บันทึก ${n} ช่องที่แก้ไขสำเร็จ`, 'success');
      await loadSettings();
    } else {
      const msg = (result.details && result.details.join(', ')) || result.error || 'เกิดข้อผิดพลาด';
      showToast('❌ ' + msg, 'error');
    }
  } catch (e) {
    showToast('❌ ไม่สามารถบันทึกได้', 'error');
  }
}

// === Upload credentials.json ===
async function handleCredFile(input) {
  if (publicReadOnly) {
    showToast('Public dashboard is read-only. Credential upload is disabled.', 'info');
    input.value = '';
    return;
  }
  const file = input.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('credentials', file);

  try {
    const res = await fetch('/api/credentials', { method: 'POST', body: formData });
    const result = await res.json();
    if (result.ok) {
      const zone = document.getElementById('credDropZone');
      zone.classList.add('uploaded');
      document.getElementById('credStatus').innerHTML = '<span class="upload-icon">✅</span><p>credentials.json — อัปโหลดสำเร็จ</p>';
      showToast('✅ อัปโหลด credentials.json สำเร็จ', 'success');
      await loadConfigStatus();
    } else {
      showToast('❌ ' + (result.error || 'ไฟล์ไม่ถูกต้อง'), 'error');
    }
  } catch (e) {
    showToast('❌ อัปโหลดไม่สำเร็จ', 'error');
  }
}

// === Drag & Drop ===
const dropZone = document.getElementById('credDropZone');
if (dropZone) {
  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
  });
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) {
      const input = document.getElementById('credFile');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      handleCredFile(input);
    }
  });
}

// === Start / Stop Bot ===
async function startBot() {
  if (publicReadOnly) return;
  const btn = document.getElementById('btnStartBot');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon">⏳</span> กำลังเริ่มต้น...';
  addLog('🚀 กำลังเริ่มต้น Bot...', 'info');

  try {
    const res = await fetch('/api/bot/start', { method: 'POST' });
    const result = await res.json();
    if (result.ok) {
      showToast('✅ Bot เริ่มทำงานแล้ว!', 'success');
      addLog('✅ Bot เริ่มทำงานสำเร็จ', 'success');
    } else {
      showToast('❌ ' + (result.error || 'ไม่สามารถเริ่ม Bot ได้'), 'error');
      addLog('❌ ' + (result.error || 'Error'), 'error');
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">🚀</span> เริ่มต้น Bot';
    }
  } catch (e) {
    showToast('❌ เกิดข้อผิดพลาด', 'error');
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🚀</span> เริ่มต้น Bot';
  }
  refreshStatus();
}

async function stopBot() {
  if (publicReadOnly) return;
  try {
    const res = await fetch('/api/bot/stop', { method: 'POST' });
    const result = await res.json();
    showToast(result.ok ? '⏹️ Bot หยุดทำงานแล้ว' : '❌ ไม่สามารถหยุดได้', result.ok ? 'info' : 'error');
    addLog(result.ok ? '⏹️ Bot หยุดทำงาน' : '❌ หยุดไม่สำเร็จ', result.ok ? 'warn' : 'error');
  } catch (e) {
    showToast('❌ เกิดข้อผิดพลาด', 'error');
  }
  refreshStatus();
}

// === Status Polling ===
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ตัวเลขวิ่งขึ้น (count-up) — วิ่งจากค่าเดิม→ค่าใหม่เฉพาะตอนค่าเปลี่ยน (กันวิ่งซ้ำทุก poll)
function animateNumber(el, target, money) {
  if (!el) return;
  target = Number(target) || 0;
  const prev = el.dataset.val != null ? Number(el.dataset.val) : 0;
  const fmt = (v) => money ? fmtMoney(v) : fmtNum(Math.round(v));
  if (prev === target) { el.textContent = fmt(target); el.dataset.val = target; return; }
  el.dataset.val = target;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { el.textContent = fmt(target); return; }
  const dur = 850, start = performance.now(), from = prev;
  const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
  function frame(now) {
    const t = Math.min((now - start) / dur, 1);
    el.textContent = fmt(from + (target - from) * ease(t));
    if (t < 1) requestAnimationFrame(frame); else el.textContent = fmt(target);
  }
  requestAnimationFrame(frame);
}
function setNumber(id, value, money) { animateNumber(document.getElementById(id), value, money); }

// ── ย่อ/ขยาย sidebar (จำสถานะใน localStorage) ──
function toggleSidebar() {
  const app = document.querySelector('.app');
  if (!app) return;
  const collapsed = app.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch (_) {}
}
(function restoreSidebar() {
  try {
    if (localStorage.getItem('sidebarCollapsed') === '1') {
      const app = document.querySelector('.app');
      if (app) app.classList.add('sidebar-collapsed');
    }
  } catch (_) {}
})();

// ลูกเล่น ripple ตอนแตะปุ่ม/เมนู (เด้งวงคลื่นจากจุดที่กด)
document.addEventListener('click', (e) => {
  const el = e.target.closest('.btn, .nav-item');
  if (!el) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const r = document.createElement('span');
  r.className = 'ripple';
  r.style.width = r.style.height = size + 'px';
  r.style.left = (e.clientX - rect.left - size / 2) + 'px';
  r.style.top = (e.clientY - rect.top - size / 2) + 'px';
  el.appendChild(r);
  setTimeout(() => r.remove(), 650);
});

function formatAge(ms) {
  if (ms === null || ms === undefined || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

async function refreshStatus() {
  if (statusInFlight) return;
  statusInFlight = true;
  try {
    const res = await fetch('/api/realtime', { cache: 'no-store' });
    const payload = await res.json();
    const data = payload.status || payload;

    const dot = document.querySelector('.status-dot');
    const text = document.getElementById('statusText');
    const btnStart = document.getElementById('btnStartBot');
    const btnStop = document.getElementById('btnStopBot');

    const botOnline = Boolean(data.botOnline || data.botRunning);
    const botAge = formatAge(data.botLastSeenAgeMs);

    if (publicReadOnly) {
      dot.className = 'status-dot online';
      text.textContent = botOnline ? 'Bot Online' : 'Dashboard Online';
      btnStart.style.display = 'none';
      btnStop.style.display = 'none';
    } else if (data.hostedOnVercel) {
      dot.className = 'status-dot online';
      text.textContent = botOnline ? 'Bot Online' : 'Dashboard Online';
      btnStart.style.display = 'none';
      btnStop.style.display = 'none';
    } else if (botOnline) {
      dot.className = 'status-dot online';
      text.textContent = 'กำลังทำงาน';
      btnStart.style.display = 'none';
      btnStop.style.display = 'inline-flex';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = data.configured ? 'พร้อมเริ่ม' : 'ยังไม่ได้ตั้งค่า';
      btnStart.style.display = 'inline-flex';
      btnStart.disabled = !data.configured;
      btnStart.innerHTML = '<span class="btn-icon">🚀</span> เริ่มต้น Bot';
      btnStop.style.display = 'none';
    }

    setText('statBot', botOnline ? `🟢 Bot Online${botAge ? ` (${botAge})` : ''}` : '🔴 Bot Offline');
    setText('statDrive', (data.sheetsReady && data.driveReady) ? '🟢 Sheets + Drive พร้อม' : '⚪ รอ Google');
    const queue = data.queue || {};
    const waiting = Number(queue.waiting || 0);
    const active = Number(queue.active || 0);
    const step = queue.currentStep ? ` · ${queue.currentStep}` : '';
    setText('statQueue', `รอ ${waiting} · ทำอยู่ ${active}${step}`);
    setText('dashboardUpdatedAt', data.fetchedAt ? `อัปเดตล่าสุด ${new Date(data.fetchedAt).toLocaleTimeString('th-TH')}` : '');

    if (data.spreadsheetId) {
      document.getElementById('sheetLinkCard').style.display = 'block';
      const link = document.getElementById('sheetLink');
      link.href = `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}`;
    }

    if (data.usage) {
      const tok = Number(data.usage.totalTokens || 0);
      const cnt = Number(data.usage.count || 0);
      const avg = cnt > 0 ? Math.round(tok / cnt) : 0;
      const tokenEl = document.getElementById('token-usage-text');
      tokenEl.innerText = `${tok.toLocaleString()} Tokens · ${cnt} รูป · เฉลี่ย ${avg.toLocaleString()}/รูป`;
      tokenEl.classList.remove('warning');
      tokenEl.classList.add('success');
      renderProviderStats(data.usage.byProvider || []);
      renderTokenChart(data.usage.byProvider || [], avg);
      renderOcrHealth(data.usage.health);
    }
    renderQuota(data.quota);
    renderAlerts(data);

  } catch (e) { /* silent */ }
  finally {
    statusInFlight = false;
  }
}

// กราฟยอด token รายค่าย (แท่งแนวนอน) + เฉลี่ยต่อรูป
function renderTokenChart(list, avg) {
  const box = document.getElementById('tokenChart');
  if (!box) return;
  const items = (list || []).filter(p => Number(p.tokens) > 0);
  if (items.length === 0) { box.innerHTML = '<div class="prov-empty">ยังไม่มีข้อมูล token</div>'; return; }
  const max = Math.max(...items.map(p => p.tokens), 1);
  const total = items.reduce((s, p) => s + p.tokens, 0);
  const cls = { gemini: 'prov-gemini', typhoon: 'prov-typhoon', openai: 'prov-gpt' };
  box.innerHTML = `<div class="tokchart-avg">⌀ เฉลี่ย <b>${Number(avg || 0).toLocaleString()}</b> token/รูป · รวม ${total.toLocaleString()}</div>` +
    items.map(p => {
      const pct = Math.round((p.tokens / max) * 100);
      const share = total ? Math.round((p.tokens / total) * 100) : 0;
      return `<div class="tokchart-row">
        <span class="tokchart-lbl">${escHtml(p.label)}</span>
        <div class="tokchart-track"><div class="tokchart-fill ${cls[p.key] || ''}" style="width:${Math.max(pct, 3)}%"></div></div>
        <span class="tokchart-val">${Number(p.tokens).toLocaleString()} <small>(${share}%)</small></span>
      </div>`;
    }).join('');
}

// การ์ดสถิติแยกตามค่าย OCR: token / ครั้ง / สำเร็จ / error / %แม่น
const PROV_CLS = { gemini: 'prov-gemini', typhoon: 'prov-typhoon', openai: 'prov-gpt' };
function renderProviderStats(list) {
  const box = document.getElementById('providerStats');
  if (!box) return;
  if (!Array.isArray(list) || list.length === 0) {
    box.innerHTML = '<div class="prov-empty">ยังไม่มีสถิติการจับยอด — ส่งสลิปเข้าบอทเพื่อเริ่มเก็บข้อมูล</div>';
    return;
  }
  box.innerHTML = list.map(p => {
    const rate = p.successRate == null ? '-' : `${p.successRate}%`;
    const rateCls = p.successRate == null ? '' : (p.successRate >= 90 ? 'rate-good' : (p.successRate >= 70 ? 'rate-mid' : 'rate-bad'));
    return `
      <div class="prov-card ${PROV_CLS[p.key] || ''}">
        <div class="prov-head"><span class="prov-name">${escHtml(p.label)}</span><span class="prov-rate ${rateCls}">${rate}</span></div>
        <div class="prov-stats">
          <span>จับครบ <b>${p.ok}</b>/${p.calls}</span>
          <span>error <b>${p.err}</b></span>
          <span>${Number(p.tokens || 0).toLocaleString()} tok</span>
        </div>
      </div>`;
  }).join('');
}

const fmtMoney = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
const fmtNum = (v) => Number(v || 0).toLocaleString('en-US');

// === การ์ดสรุปวันนี้ ===
let dayCardSel = 'today';   // 'today' | 'yesterday' | 'YYYY-MM-DD' — การ์ดใบแรกดูวันไหน
let monthCardSel = null;    // null = เดือนปัจจุบัน (live) | 'YYYY-MM'

function fillDayCard(t) {
  setNumber('todayTotal', t.total, true);
  setNumber('todayCount', t.count, false);
  setNumber('todayTransfer', t.transfer, true);
  setNumber('todayWithdraw', t.withdraw, true);
  setNumber('todayDeposit', t.deposit, true);
  setNumber('todayFee', t.fee, true);
}
function fillMonthCard(m) {
  setNumber('monthTotal', m.total, true);
  setNumber('monthCount', m.count, false);
  setNumber('monthTransfer', m.transfer, true);
  setNumber('monthWithdraw', m.withdraw, true);
  setNumber('monthDeposit', m.deposit, true);
  setNumber('monthFee', m.fee, true);
}
// รวมยอดจาก /api/report (per-account) → มิติเดียวกับการ์ด
function computeReportSums(rep) {
  let total = 0, count = 0, transfer = 0, withdraw = 0, deposit = 0, fee = 0;
  Object.entries(rep || {}).forEach(([k, a]) => {
    if (k.startsWith('_')) return;
    total += Number(a.total || 0); transfer += Number(a.transferSum || 0);
    withdraw += Number(a.withdrawSum || 0); deposit += Number(a.depositSum || 0); fee += Number(a.feeSum || 0);
    count += Number(a.transferCount || 0) + Number(a.withdrawCount || 0) + Number(a.depositCount || 0) + Number(a.billCount || 0) + Number(a.otherCount || 0);
  });
  return { total, count, transfer, withdraw, deposit, fee };
}

async function loadToday() {
  try {
    const res = await fetch('/api/today', { cache: 'no-store' });
    const d = await res.json();
    if (!d.ok || !d.today) return;
    if (dayCardSel === 'today') fillDayCard(d.today); // ไม่ทับตอนผู้ใช้เลือกดูวันอื่นอยู่
    setText('todayUpdated', d.fetchedAt ? new Date(d.fetchedAt).toLocaleTimeString('th-TH') : '');
    if (d.month && !monthCardSel) {
      fillMonthCard(d.month);
      setText('monthLabel', d.monthLabel || '');
    }
    lastTodayData = d;
    renderTypeChart();
  } catch (_) {}
}

// การ์ดใบแรก: วันนี้ / เมื่อวาน / เลือกวันที่
async function setDayCard(sel) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  dayCardSel = sel || 'today';
  const dcDate = document.getElementById('dcDate');
  ['dc-today', 'dc-yesterday'].forEach(id => document.getElementById(id)?.classList.remove('chip-active'));
  if (dayCardSel === 'today') {
    document.getElementById('dc-today')?.classList.add('chip-active');
    if (dcDate) dcDate.value = '';
    setText('dayCardLabel', 'วันนี้');
    loadToday();
    return;
  }
  let date;
  if (dayCardSel === 'yesterday') {
    const y = new Date(); y.setDate(y.getDate() - 1); date = fmt(y);
    document.getElementById('dc-yesterday')?.classList.add('chip-active');
    if (dcDate) dcDate.value = '';
    setText('dayCardLabel', 'เมื่อวาน');
  } else {
    date = dayCardSel;
    setText('dayCardLabel', gmThaiDate(date));
  }
  try {
    const res = await fetch(`/api/report?date=${date}`, { cache: 'no-store' });
    const d = await res.json();
    fillDayCard(computeReportSums(d.ok && d.report));
  } catch (_) {}
}

// การ์ดใบสอง: เลือกเดือนได้
async function setMonthCard(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) { monthCardSel = null; loadToday(); return; }
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (month === curMonth) { monthCardSel = null; setText('monthLabel', month); loadToday(); return; }
  monthCardSel = month;
  const [y, mo] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  try {
    const res = await fetch(`/api/report?from=${month}-01&to=${month}-${String(lastDay).padStart(2, '0')}`, { cache: 'no-store' });
    const d = await res.json();
    fillMonthCard(computeReportSums(d.ok && d.report));
    setText('monthLabel', month);
  } catch (_) {}
}

// === กราฟสัดส่วน โอน/ถอน/ฝาก/อื่นๆ (จากข้อมูล today/month) ===
let lastTodayData = null;
let typeChartScope = 'month';
let allTypeSummary = null; // สรุปประเภท "ทั้งหมด" (โหลดครั้งแรกที่กด)
let customTypeSummary = null; // สรุปประเภทของวันที่เลือกเอง (yesterday / date)
async function setTypeChartScope(s) {
  typeChartScope = s;
  if (s === 'all' && !allTypeSummary) {
    try {
      const res = await fetch('/api/report?date=all', { cache: 'no-store' });
      const d = await res.json();
      const rep = (d.ok && d.report) || {};
      const x = computeReportSums(rep);
      allTypeSummary = { total: x.total, transfer: x.transfer, withdraw: x.withdraw, deposit: x.deposit };
    } catch (_) { allTypeSummary = { total: 0, transfer: 0, withdraw: 0, deposit: 0 }; }
  }
  // เมื่อวาน หรือเลือกวันที่เอง (scope = 'yesterday' | 'date:YYYY-MM-DD') → ดึงจาก report ของวันนั้น
  if (s === 'yesterday' || String(s).startsWith('date:')) {
    let date;
    if (s === 'yesterday') { const y = new Date(); y.setDate(y.getDate() - 1); date = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`; }
    else date = s.slice(5);
    try {
      const res = await fetch(`/api/report?date=${date}`, { cache: 'no-store' });
      const d = await res.json();
      customTypeSummary = computeReportSums((d.ok && d.report) || {});
    } catch (_) { customTypeSummary = { total: 0, transfer: 0, withdraw: 0, deposit: 0 }; }
  }
  renderTypeChart();
}
function renderTypeChart() {
  const box = document.getElementById('typeChart');
  if (!box) return;
  ['today', 'yesterday', 'month', 'all'].forEach(k => {
    const el = document.getElementById('typeChart' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.classList.toggle('chip-active', typeChartScope === k);
  });
  let s;
  if (typeChartScope === 'all') s = allTypeSummary || {};
  else if (typeChartScope === 'today') s = (lastTodayData && lastTodayData.today) || {};
  else if (typeChartScope === 'yesterday' || String(typeChartScope).startsWith('date:')) s = customTypeSummary || {};
  else s = (lastTodayData && lastTodayData.month) || {};
  const other = Math.max(0, Number(s.total || 0) - Number(s.transfer || 0) - Number(s.withdraw || 0) - Number(s.deposit || 0));
  const rows = [
    { label: '🔄 โอน', val: Number(s.transfer || 0), cls: 'bar-c1' },
    { label: '🏧 ถอน', val: Number(s.withdraw || 0), cls: 'bar-c3' },
    { label: '📥 ฝาก/รับ', val: Number(s.deposit || 0), cls: 'bar-c2' },
    { label: '📝 อื่นๆ', val: other, cls: 'bar-c4' },
  ].filter(r => r.val > 0);
  if (rows.length === 0) { box.innerHTML = '<div class="prov-empty">ยังไม่มีข้อมูลในช่วงนี้</div>'; return; }
  const total = rows.reduce((a, r) => a + r.val, 0);
  const max = Math.max(...rows.map(r => r.val), 1);
  box.innerHTML = `<div class="tokchart-avg">รวม <b>${fmtMoney(total)}</b> ฿</div>` +
    rows.map(r => {
      const share = total ? Math.round(r.val / total * 100) : 0;
      return `<div class="tokchart-row">
        <span class="tokchart-lbl">${r.label}</span>
        <div class="tokchart-track"><div class="tokchart-fill ${r.cls}" style="width:${Math.max(Math.round(r.val / max * 100), 3)}%"></div></div>
        <span class="tokchart-val">${fmtMoney(r.val)} <small>(${share}%)</small></span>
      </div>`;
    }).join('');
}

// === กราฟแท่งยอดรวมต่อบัญชี (แยกแต่ละบัญชี) ===
let acctChartPeriod = 'all';
const ACCT_BAR_CLS = ['bar-c1', 'bar-c2', 'bar-c3', 'bar-c4', 'bar-c5', 'bar-c6'];
async function loadAccountChart(period) {
  if (period) acctChartPeriod = period;
  const box = document.getElementById('acctChart');
  if (!box) return;
  ['today', 'yesterday', '7d', 'month', 'all'].forEach(k => {
    const el = document.getElementById('acctChart' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.classList.toggle('chip-active', acctChartPeriod === k);
  });
  // เลือกจาก chip → ล้าง date picker (period แบบ date: มาจาก picker เท่านั้น)
  const acDate = document.getElementById('acctChartDate');
  if (acDate && !String(acctChartPeriod).startsWith('date:')) acDate.value = '';
  try {
    let url = '/api/report';
    const now = new Date();
    const fmtD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const td = fmtD(now);
    if (acctChartPeriod === 'today') url += `?date=${td}`;
    else if (acctChartPeriod === 'yesterday') { const y = new Date(now); y.setDate(now.getDate() - 1); url += `?date=${fmtD(y)}`; }
    else if (acctChartPeriod === '7d') { const s = new Date(now); s.setDate(now.getDate() - 6); url += `?from=${fmtD(s)}&to=${td}`; }
    else if (acctChartPeriod === 'month') url += `?from=${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01&to=${td}`;
    else if (String(acctChartPeriod).startsWith('date:')) url += `?date=${acctChartPeriod.slice(5)}`;
    else url += '?date=all';
    const res = await fetch(url, { cache: 'no-store' });
    const d = await res.json();
    const rep = (d.ok && d.report) || {};
    const accts = Object.entries(rep).filter(([k]) => !k.startsWith('_'))
      .map(([l, a]) => ({ last4: l, bank: a.bank || '', total: Number(a.total || 0) }))
      .filter(a => a.total > 0).sort((x, y) => y.total - x.total);
    if (accts.length === 0) { box.innerHTML = '<div class="prov-empty">ยังไม่มีข้อมูล</div>'; return; }
    const max = Math.max(...accts.map(a => a.total), 1);
    const grand = accts.reduce((s, a) => s + a.total, 0);
    box.innerHTML = `<div class="tokchart-avg">รวมทุกบัญชี <b>${fmtMoney(grand)}</b> ฿ · ${accts.length} บัญชี</div>` +
      accts.map((a, i) => `<div class="tokchart-row">
        <span class="tokchart-lbl">****${escHtml(a.last4)}${accNameTag(a.last4)} <small>${escHtml(a.bank)}</small></span>
        <div class="tokchart-track"><div class="tokchart-fill ${ACCT_BAR_CLS[i % ACCT_BAR_CLS.length]}" style="width:${Math.max(Math.round(a.total / max * 100), 3)}%"></div></div>
        <span class="tokchart-val">${fmtMoney(a.total)}</span>
      </div>`).join('');
  } catch (_) { box.innerHTML = '<div class="prov-empty">โหลดไม่สำเร็จ</div>'; }
}

// === แนวโน้มรายวัน (กราฟเส้น + พื้นไล่เฉด SVG) ===
async function loadTrends(days = 7, range = null) {
  const box = document.getElementById('trendsChart');
  if (!box) return;
  try {
    const qs = range ? `from=${range.from}&to=${range.to}` : `days=${days}`;
    const res = await fetch(`/api/trends?${qs}`, { cache: 'no-store' });
    const d = await res.json();
    const data = (d.ok && d.trends) || [];
    if (data.length === 0) { box.innerHTML = '<div class="prov-empty">ยังไม่มีข้อมูล</div>'; return; }
    box.innerHTML = renderTrendArea(data);
  } catch (_) { box.innerHTML = '<div class="prov-empty">โหลดไม่สำเร็จ</div>'; }
}
// เลือกช่วงแนวโน้มเอง (from–to)
function loadTrendsRange() {
  const from = document.getElementById('trFrom')?.value, to = document.getElementById('trTo')?.value;
  if (!from || !to) return showToast('เลือกวันที่ให้ครบทั้ง จาก–ถึง', 'info');
  loadTrends(0, { from, to });
}

function renderTrendArea(data) {
  const W = 760, H = 180, padL = 8, padR = 8, padT = 18, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = data.length;
  const max = Math.max(...data.map(x => x.amount), 1);
  const xAt = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v) => padT + innerH - (v / max) * innerH;
  const pts = data.map((x, i) => ({ x: xAt(i), y: yAt(x.amount), d: x }));

  // เส้นโค้งนุ่ม (Catmull-Rom → Bézier)
  let line = '';
  if (pts.length === 1) {
    line = `M ${pts[0].x} ${pts[0].y}`;
  } else {
    line = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      line += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
    }
  }
  const baseY = padT + innerH;
  const area = `${line} L ${pts[pts.length - 1].x} ${baseY} L ${pts[0].x} ${baseY} Z`;
  const labelEvery = Math.ceil(n / 8);

  const dots = pts.map((p, i) => `
    <g class="tr-pt">
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9" fill="transparent">
        <title>${p.d.date} · ${fmtMoney(p.d.amount)} ฿ · ${p.d.count} สลิป</title>
      </circle>
      <circle class="tr-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5"></circle>
    </g>`).join('');
  const labels = pts.map((p, i) => (i % labelEvery === 0 || i === n - 1)
    ? `<text class="tr-x" x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${p.d.date.slice(5)}</text>` : '').join('');
  const peak = pts.reduce((a, b) => b.d.amount > a.d.amount ? b : a, pts[0]);
  const peakLbl = peak.d.amount > 0
    ? `<text class="tr-peak" x="${Math.min(Math.max(peak.x, 30), W - 30).toFixed(1)}" y="${Math.max(peak.y - 10, 12).toFixed(1)}" text-anchor="middle">${fmtMoney(peak.d.amount)}</text>` : '';

  return `
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
      <defs>
        <linearGradient id="trArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#trArea)"></path>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
      ${dots}${labels}${peakLbl}
    </svg>`;
}

// === OCR health (auto/review/manual) + alert + quota meter (เรียกจาก refreshStatus) ===
function renderOcrHealth(h) {
  const el = document.getElementById('ocrHealth');
  if (!el || !h) return;
  const total = (h.auto || 0) + (h.review || 0) + (h.manual || 0);
  if (total === 0) { el.textContent = ''; return; }
  const pct = (n) => Math.round((n / total) * 100);
  el.innerHTML = `<span class="hl-auto">อัตโนมัติ ${pct(h.auto)}%</span> · <span class="hl-review">รอตรวจ ${pct(h.review)}%</span> · <span class="hl-manual">กรอกเอง ${pct(h.manual)}%</span>`;
}

function renderQuota(q) {
  const el = document.getElementById('quotaMeter');
  if (!el) return;
  if (!q) { el.hidden = true; return; }
  el.hidden = false;
  const bar = (lab, u, lim) => {
    const pct = Math.min(100, Math.round((u / 60) * 100));
    const cls = u >= 55 ? 'q-bad' : (u >= 45 ? 'q-mid' : 'q-good');
    return `<div class="quota-row"><span>${lab}</span><div class="quota-track"><div class="quota-fill ${cls}" style="width:${pct}%"></div></div><b>${u}/60</b></div>`;
  };
  el.innerHTML = `<div class="quota-title">⚙️ Google Sheets quota (โปรเซสนี้ · ต่อนาที)</div>${bar('Read', q.read.used)}${bar('Write', q.write.used)}`;
}

function renderAlerts(data) {
  const el = document.getElementById('alertBanner');
  if (!el) return;
  const alerts = [];
  if (data.botOnline === false) alerts.push('🔴 บอทออฟไลน์ — สลิปจะยังไม่ถูกประมวลผลจนกว่าบอทจะกลับมา');
  const failed = Number(data.queue?.persistedFailed ?? data.queue?.failed ?? 0);
  if (failed > 0) alerts.push(`⚠️ มีงานล้มเหลวค้าง ${failed} งาน — ไปแท็บ Jobs กด Retry ได้`);
  const q = data.quota;
  if (q && (q.read.used >= 55 || q.write.used >= 55)) alerts.push('🟠 ใกล้ชน Google Sheets quota — ระบบกำลังหน่วงให้อัตโนมัติ');
  if (alerts.length === 0) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = alerts.map(a => `<div class="alert-item">${a}</div>`).join('');
}

// === ค้นหา/กรองหน้าสรุป (client-side) ===
function filterReport() {
  const q = (document.getElementById('reportSearch')?.value || '').trim().toLowerCase();
  document.querySelectorAll('#reportContainer .account-row:not(.account-head)').forEach(row => {
    const recipBlock = row.nextElementSibling && row.nextElementSibling.classList.contains('acct-recip') ? row.nextElementSibling : null;
    const text = (row.textContent + (recipBlock ? recipBlock.textContent : '')).toLowerCase();
    const show = !q || text.includes(q);
    row.style.display = show ? '' : 'none';
    if (recipBlock) recipBlock.style.display = show ? '' : 'none';
  });
}

function reportFilterParams() {
  const params = new URLSearchParams();
  if (currentReportFilter === 'all') { /* ทั้งหมด */ }
  else if (String(currentReportFilter).includes('~')) { const [f, t] = currentReportFilter.split('~'); params.set('from', f); params.set('to', t); }
  else if (currentReportFilter && currentReportFilter !== 'today') params.set('date', currentReportFilter);
  return params.toString();
}
function exportReportCsv() { const qs = reportFilterParams(); window.open(qs ? `/api/report/export?${qs}` : '/api/report/export', '_blank'); }
function exportReportXlsx() { const qs = reportFilterParams(); window.open(qs ? `/api/report/export-xlsx?${qs}` : '/api/report/export-xlsx', '_blank'); }

let currentReportFilter = 'all'; // ตัวกรองหน้าสรุปยอด: 'all' | 'YYYY-MM-DD' | 'from~to'

// ไฮไลต์ chip ตัวกรองที่เลือกอยู่ (null = กรองเองด้วยวันที่)
const REPORT_CHIPS = ['today', 'yesterday', '7d', '30d', 'thisMonth', 'lastMonth', 'all'];
function setReportChip(kind) {
  REPORT_CHIPS.forEach(k => {
    const el = document.getElementById('rp-' + k);
    if (el) el.classList.toggle('chip-active', kind === k);
  });
}

function applyReportFilter(keepChip = false) {
  const from = document.getElementById('reportFrom')?.value || '';
  const to = document.getElementById('reportTo')?.value || '';
  let filter;
  if (from && to) filter = from === to ? from : `${from}~${to}`;
  else if (from) filter = from;
  else if (to) filter = to;
  else filter = 'all';
  if (keepChip !== true) setReportChip(filter === 'all' ? 'all' : null); // กรองเอง = ดับ chip
  loadReport(filter);
}

function showAllReport() {
  ['reportFrom', 'reportTo', 'reportDay'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  setReportChip('all');
  loadReport('all');
}

// เลือกดู "วันเดียว" จากปฏิทิน — กรองทันที
function reportPickDay() {
  const v = document.getElementById('reportDay')?.value || '';
  if (!v) return;
  const f = document.getElementById('reportFrom'); if (f) f.value = '';
  const t = document.getElementById('reportTo'); if (t) t.value = '';
  setReportChip(null);
  loadReport(v);
}

// ช่วงวันแบบเร็ว: today | yesterday (เมื่อวานวันเดียว) | 7d | 30d | thisMonth | lastMonth
function reportPreset(kind) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  let from = new Date(today);
  let to = new Date(today);
  if (kind === 'yesterday') { from.setDate(today.getDate() - 1); to.setDate(today.getDate() - 1); } // เมื่อวานล้วน แยกจากวันนี้ชัดเจน
  else if (kind === '7d') from.setDate(today.getDate() - 6);
  else if (kind === '30d') from.setDate(today.getDate() - 29);
  else if (kind === 'thisMonth') from = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (kind === 'lastMonth') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = new Date(today.getFullYear(), today.getMonth(), 0); // วันสุดท้ายเดือนก่อน
  }
  const fEl = document.getElementById('reportFrom');
  const tEl = document.getElementById('reportTo');
  const dEl = document.getElementById('reportDay');
  if (fEl) fEl.value = fmt(from);
  if (tEl) tEl.value = fmt(to);
  if (dEl) dEl.value = '';
  setReportChip(kind);
  applyReportFilter(true);
}

async function loadReport(forceDate = null, silent = false) {
  const container = document.getElementById('reportContainer');
  if (!silent) {
    container.innerHTML = '<div class="report-loading">กำลังดึงข้อมูลจาก Google Sheets...</div>';
  }

  try {
    // forceDate ระบุมา → ใช้+จำไว้; ไม่งั้นใช้ตัวกรองปัจจุบัน (ค่าเริ่มต้น = ทั้งหมด)
    let dateParam = forceDate !== null ? forceDate : currentReportFilter;
    if (forceDate !== null) currentReportFilter = forceDate;

    let url = '/api/report';
    const params = new URLSearchParams();
    if (dateParam && dateParam !== 'all') {
      if (String(dateParam).includes('~')) {
        const [f, t] = dateParam.split('~');
        params.set('from', f);
        params.set('to', t);
      } else {
        params.set('date', dateParam);
      }
    } else {
      params.set('date', 'all');
    }
    if (!silent) params.set('refresh', '1');
    url += `?${params.toString()}`;

    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();

    if (!data.ok) {
      container.innerHTML = `<div class="info-card"><div style="color:var(--red);text-align:center;">${data.error}</div></div>`;
      return;
    }

    const report = data.report || {};
    const recipients = Array.isArray(report._recipients) ? report._recipients : [];
    const accounts = Object.entries(report).filter(([k]) => !k.startsWith('_'));
    const topAccounts = accounts.map(([l, a]) => ({ last4: l, bank: a.bank, total: Number(a.total || 0) })).sort((x, y) => y.total - x.total).slice(0, 10);
    const renderSignature = JSON.stringify({ date: dateParam || '', report });

    if (accounts.length === 0) {
      if (silent && lastReportRenderSignature === renderSignature) return;
      lastReportRenderSignature = renderSignature;
      container.innerHTML = '<div class="info-card empty-state">ไม่พบข้อมูลรายการของวันที่เลือก</div>';
      return;
    }

    if (silent && lastReportRenderSignature === renderSignature) return;
    lastReportRenderSignature = renderSignature;

    const money = (value) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
    const totals = accounts.reduce((sum, [, acc]) => ({
      transfer: sum.transfer + Number(acc.transferSum || 0),
      withdraw: sum.withdraw + Number(acc.withdrawSum || 0),
      deposit: sum.deposit + Number(acc.depositSum || 0),
      other: sum.other + Number(acc.billSum || 0) + Number(acc.otherSum || 0),
      total: sum.total + Number(acc.total || 0),
      count: sum.count + Number(acc.transferCount || 0) + Number(acc.withdrawCount || 0) + Number(acc.depositCount || 0) + Number(acc.billCount || 0) + Number(acc.otherCount || 0),
    }), { transfer: 0, withdraw: 0, deposit: 0, other: 0, total: 0, count: 0 });

    // ป้ายกำกับยอดให้ตรงกับช่วงเวลาที่กำลังดู (กันสับสนกับคอลัมน์ "ยอดรวมทั้งหมด" สะสมในชีต)
    let scopeLabel;
    if (!dateParam || dateParam === 'all') scopeLabel = 'ยอดรวมสะสมทั้งหมด';
    else if (String(dateParam).includes('~')) {
      const [f, t] = dateParam.split('~');
      scopeLabel = `ยอดรวม ${f} ถึง ${t}`;
    } else scopeLabel = `ยอดรวมวันที่ ${dateParam}`;

    container.innerHTML = `
      <section class="report-summary">
        <div class="summary-total">
          <span class="summary-label">${scopeLabel}</span>
          <strong>${money(totals.total)} ฿</strong>
          <small>${accounts.length} บัญชี · ${totals.count} รายการ</small>
        </div>
        <div class="summary-metrics">
          <span><b>${money(totals.transfer)}</b><small>โอน</small></span>
          <span><b>${money(totals.withdraw)}</b><small>ถอน</small></span>
          <span><b>${money(totals.deposit)}</b><small>ฝาก/รับ</small></span>
          <span><b>${money(totals.other)}</b><small>อื่นๆ</small></span>
        </div>
      </section>

      <section class="account-list">
        <div class="account-row account-head">
          <span>บัญชี</span>
          <span>โอน</span>
          <span>ถอน</span>
          <span>ฝาก/รับ</span>
          <span>อื่นๆ</span>
          <span>ค่าธรรมเนียม</span>
          <span>รวม</span>
        </div>
        ${accounts.map(([last4, acc]) => {
          const other = Number(acc.billSum || 0) + Number(acc.otherSum || 0);
          const txCount = Number(acc.transferCount || 0) + Number(acc.withdrawCount || 0) + Number(acc.depositCount || 0) + Number(acc.billCount || 0) + Number(acc.otherCount || 0);
          return `
            <article class="account-row">
              <div class="account-id">
                <strong>****${last4}${accNameTag(last4)}${acc.bank ? ` <span class="acc-bank">(${escHtml(acc.bank)})</span>` : ''}</strong>
                <small>${txCount} รายการ</small>
              </div>
              <div class="metric transfer" data-label="โอน"><b>${money(acc.transferSum)}</b><small>${acc.transferCount || 0}</small></div>
              <div class="metric withdraw" data-label="ถอน"><b>${money(acc.withdrawSum)}</b><small>${acc.withdrawCount || 0}</small></div>
              <div class="metric deposit" data-label="ฝาก/รับ"><b>${money(acc.depositSum)}</b><small>${acc.depositCount || 0}</small></div>
              <div class="metric other" data-label="อื่นๆ"><b>${money(other)}</b><small>${Number(acc.billCount || 0) + Number(acc.otherCount || 0)}</small></div>
              <div class="metric fee" data-label="ค่าธรรมเนียม"><b>${money(acc.feeSum || 0)}</b><small>บาท</small></div>
              <div class="metric total" data-label="รวม"><b>${money(acc.total)}</b><small>บาท</small></div>
            </article>
            ${Array.isArray(acc.recipients) && acc.recipients.length > 0 ? `
            <details class="acct-recip">
              <summary>👤 ผู้รับจากบัญชีนี้ (${acc.recipients.length})</summary>
              ${acc.recipients.map(r => `
                <div class="recipient-row">
                  <span class="recipient-name">${escHtml(r.name)}${r.last4 ? ` <span class="acc-bank">(****${escHtml(r.last4)})</span>` : ''}</span>
                  <span class="recipient-count">${r.count} รายการ${r.fee ? ` · ค่าธรรม ${money(r.fee)}` : ''}</span>
                  <strong class="recipient-total">${money(r.total)} ฿</strong>
                </div>
              `).join('')}
            </details>` : ''}
          `;
        }).join('')}
      </section>

      ${(recipients.length > 0 || topAccounts.length > 0) ? `
      <section class="top10-grid">
        <div class="top10-col">
          <h3 class="recipient-title">🏆 Top 10 ผู้รับ</h3>
          ${recipients.slice(0, 10).map((r, i) => `
            <div class="recipient-row"><span class="top-rank">${i + 1}</span>
              <span class="recipient-name">${escHtml(r.name)}${r.last4 ? ` <span class="acc-bank">(****${escHtml(r.last4)})</span>` : ''}</span>
              <strong class="recipient-total">${money(r.total)} ฿</strong></div>`).join('') || '<div class="prov-empty">—</div>'}
        </div>
        <div class="top10-col">
          <h3 class="recipient-title">🏆 Top 10 บัญชี (ยอดรวม)</h3>
          ${topAccounts.map((a, i) => `
            <div class="recipient-row"><span class="top-rank">${i + 1}</span>
              <span class="recipient-name">****${escHtml(a.last4)}${accNameTag(a.last4)} <span class="acc-bank">${escHtml(a.bank || '')}</span></span>
              <strong class="recipient-total">${money(a.total)} ฿</strong></div>`).join('')}
        </div>
      </section>` : ''}

      ${(report._fees && report._fees.total > 0) ? `
      <section class="recipient-list">
        <h3 class="recipient-title">💸 สรุปค่าธรรมเนียม <small>(รวม ${money(report._fees.total)} ฿)</small></h3>
        <div class="recipient-rows">
          ${report._fees.byBank.map(f => `
            <div class="recipient-row">
              <span class="recipient-name">${escHtml(f.bank)}</span>
              <span class="recipient-count"></span>
              <strong class="recipient-total">${money(f.amount)} ฿</strong>
            </div>
          `).join('')}
        </div>
      </section>` : ''}
    `;

    if (!silent) showToast('ดึงข้อมูลสำเร็จ', 'success');
  } catch (e) {
    container.innerHTML = '<div class="info-card"><div style="color:var(--red);text-align:center;">การเชื่อมต่อล้มเหลว</div></div>';
  }
}

async function wipeAllData() {
  if (publicReadOnly) {
    showToast('Public dashboard is read-only. Wipe is disabled.', 'info');
    return;
  }
  const ok = confirm(
    '⚠️ ล้างข้อมูลทั้งหมดไหม?\n\n' +
    'จะลบ/รีเซ็ตทั้งหมดนี้ (ย้อนกลับไม่ได้):\n' +
    '• ทุกบัญชีในชีต + สรุปยอด\n' +
    '• ไฟล์สลิปทั้งหมดใน Google Drive\n' +
    '• ตัวนับ token / จำนวนรูป → 0\n' +
    '• คิวงาน + คิวรอตรวจ\n' +
    '• ประวัติงานฝั่งบอท (ส่งสลิปเดิมใหม่ได้)\n\n' +
    'และจะแจ้งผลในแชท Telegram\n\nกด OK เพื่อยืนยัน'
  );
  if (!ok) return;

  try {
    showToast('⏳ กำลังล้างข้อมูลทั้งหมด...', 'info');
    const res = await fetch('/api/wipe-all', { method: 'POST' });
    const result = await res.json();

    if (!result.ok) {
      showToast('❌ ' + (result.error || 'ล้างข้อมูลไม่สำเร็จ'), 'error');
      return;
    }

    const rows = result.sheet?.totalDeleted || 0;
    const files = result.driveCount || 0;
    const tg = result.steps?.telegram ? ' + แจ้งเทเลแล้ว' : '';
    showToast(`✅ ล้างทั้งหมดแล้ว: ${rows} รายการ, Drive ${files} ไฟล์, รีเซ็ต token/คิว/รอตรวจ${tg}`, 'success');
    await loadReport('all');
    refreshReviewBadge();
  } catch (e) {
    showToast('❌ ล้างข้อมูลไม่สำเร็จ', 'error');
  }
}

async function loadJobs(force = false) {
  const container = document.getElementById('jobsContainer');
  if (!container) return;
  if (jobsInFlight) return;
  jobsInFlight = true;
  if (force) container.innerHTML = '<div class="report-loading">กำลังโหลด jobs...</div>';

  try {
    const status = document.getElementById('jobsStatusFilter')?.value || 'all';
    const res = await fetch(`/api/jobs?status=${encodeURIComponent(status)}&limit=200`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      container.innerHTML = `<div class="info-card"><div style="color:var(--red);text-align:center;">${data.error || 'โหลด jobs ไม่สำเร็จ'}</div></div>`;
      return;
    }

    renderJobs(data, force);
  } catch (e) {
    container.innerHTML = '<div class="info-card"><div style="color:var(--red);text-align:center;">โหลด jobs ไม่สำเร็จ</div></div>';
  } finally {
    jobsInFlight = false;
  }
}

let lastJobsData = null;
function jobDurationSec(j) {
  if (!j.startedAt || !j.finishedAt) return null;
  const s = (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000;
  return (s > 0 && s < 1800) ? s : null;
}
function renderJobs(data, force = false) {
  const container = document.getElementById('jobsContainer');
  if (data) lastJobsData = data; else data = lastJobsData || {};
  const allJobs = data.jobs || [];
  const stats = data.stats || {};
  const canRetry = Boolean(data.canRetry) && !publicReadOnly;
  const q = (document.getElementById('jobsSearch')?.value || '').trim().toLowerCase();
  const jobs = !q ? allJobs : allJobs.filter(j =>
    `${j.id} ${j.last4 || ''} ${j.senderTG || ''} ${j.bank || ''} ${j.amount || ''} ${j.txType || ''} ${j.status || ''}`.toLowerCase().includes(q));
  const renderSignature = JSON.stringify({ jobs, stats, canRetry, publicReadOnly, q });

  // เวลาเฉลี่ยต่อใบ (จากงานที่มี startedAt+finishedAt)
  const durs = allJobs.map(jobDurationSec).filter(x => x != null);
  const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
  setText('jobsUpdatedAt', `${data.fetchedAt ? 'อัปเดต ' + new Date(data.fetchedAt).toLocaleTimeString('th-TH') : ''}${avg ? ` · เฉลี่ย ${avg} วิ/ใบ` : ''}`);
  setText('jobsTotal', Number(stats.total || 0).toLocaleString('en-US'));
  setText('jobsRecoverable', Number(stats.recoverable || 0).toLocaleString('en-US'));
  setText('jobsFailed', Number(stats.failed || 0).toLocaleString('en-US'));
  setText('jobsDone', Number(stats.done || 0).toLocaleString('en-US'));
  renderCurrentJob(allJobs, stats);

  const retryAll = document.getElementById('btnRetryFailedAll');
  if (retryAll) retryAll.style.display = canRetry ? 'inline-flex' : 'none';

  if (!force && lastJobsRenderSignature === renderSignature) return;
  lastJobsRenderSignature = renderSignature;

  if (jobs.length === 0) {
    container.innerHTML = '<div class="info-card empty-state">ไม่พบ job ตามเงื่อนไข</div>';
    return;
  }
  container.innerHTML = `
    <div class="jobs-table">
      <div class="jobs-row jobs-head">
        <span>Job</span><span>สถานะ</span><span>สลิป</span><span>เวลา</span><span>ข้อผิดพลาด</span><span>Action</span>
      </div>
      ${jobs.map(job => renderJobRow(job, canRetry)).join('')}
    </div>`;
}

// แถบ "กำลังประมวลผล" — งานที่ทำอยู่ + step + เหลือในคิว
function renderCurrentJob(jobs, stats) {
  const el = document.getElementById('jobsCurrent');
  if (!el) return;
  const cur = jobs.find(j => j.status === 'processing');
  const waiting = Number(stats.queued != null ? stats.queued : (stats.recoverable || 0));
  if (cur) {
    el.hidden = false;
    el.innerHTML = `<span class="jc-spin">⏳</span> กำลังประมวลผล: <b>${escHtml(cur.id)}</b> · ขั้น <b>${escHtml(cur.step || '-')}</b>${cur.last4 ? ` · บัญชี ****${escHtml(cur.last4)}${accName(cur.last4) ? ` ${escHtml(accName(cur.last4))}` : ''}` : ''}${waiting > 1 ? ` · รอในคิวอีก ${waiting - 1}` : ''}`;
  } else if (waiting > 0) {
    el.hidden = false;
    el.innerHTML = `<span class="jc-spin">⏳</span> มีงานรอในคิว <b>${waiting}</b> งาน`;
  } else {
    el.hidden = true;
  }
}

// ป้ายค่ายที่จับ + ความแม่นเฉลี่ย (จาก benchmark สลิปจริง) + สถานะตัวหลัก/สำรอง
function providerBadge(job) {
  const p = String(job.ocrProvider || '').toLowerCase();
  if (!p) return '';
  let label = job.ocrProvider, acc = '', cls = 'prov-other';
  if (p.includes('gemini')) { label = 'Gemini'; acc = '~100%'; cls = 'prov-gemini'; }
  else if (p.includes('typhoon')) { label = 'Typhoon'; acc = '~88%'; cls = 'prov-typhoon'; }
  else if (p.includes('gpt') || p.includes('openai')) { label = 'GPT'; acc = '~88%'; cls = 'prov-gpt'; }
  const st = job.ocrStatus === 'review' ? ' · ⚠️ ตัวสำรอง (รอตรวจ)'
    : (job.ocrStatus === 'auto' ? ' · ✓ ตัวหลัก' : '');
  return `<small class="job-provider ${cls}" title="ความแม่นเฉลี่ยของค่ายจากผลทดสอบสลิปจริง (ไม่ใช่ค่าต่อใบ)">🤖 ${label}${acc ? ' · แม่น ' + acc : ''}${st}</small>`;
}

// แสดงข้อมูลคู่ซ้ำ: ซ้ำกับงานไหน + รูปใบต้นฉบับ
function duplicateInfo(job) {
  const orig = job.duplicateOfJobId ? `ซ้ำกับงาน ${job.duplicateOfJobId}` : 'สลิปซ้ำ';
  const date = job.duplicateOfDate ? ` · ${job.duplicateOfDate}` : '';
  const tab = job.duplicateTabName ? ` · ${job.duplicateTabName}` : '';
  const thumb = job.duplicateOfThumb
    ? `<a href="${job.duplicateOfDriveLink || job.duplicateOfThumb}" target="_blank" title="ใบต้นฉบับที่ซ้ำ"><img class="dup-thumb" src="${job.duplicateOfThumb}" alt="orig" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'"></a>`
    : '';
  return `<div class="job-dup">🔁 ${orig}${date}${tab}</div>${thumb}`;
}

function renderJobRow(job, canRetry) {
  const statusClass = `job-status ${String(job.status || '').toLowerCase()}`;
  const slipInfo = [
    job.last4 ? `****${job.last4}${accName(job.last4) ? ` ${escHtml(accName(job.last4))}` : ''}` : '',
    job.amount ? Number(job.amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) : '',
    job.txType || '',
    job.bank || '',
  ].filter(Boolean).join(' · ') || '-';
  const updated = job.updatedAt ? new Date(job.updatedAt).toLocaleString('th-TH') : '-';
  const created = job.createdAt ? new Date(job.createdAt).toLocaleString('th-TH') : '-';
  const retryButton = canRetry && job.status === 'failed'
    ? `<button class="btn btn-sm btn-secondary" onclick="retryJob('${job.id}')">Retry</button>`
    : '';
  const driveLink = job.driveLink ? `<a class="job-link" href="${job.driveLink}" target="_blank">Drive</a>` : '';
  const thumb = job.thumbUrl
    ? `<a href="${job.driveLink || job.thumbUrl}" target="_blank" class="job-thumb-link" title="เปิดรูปสลิป">
         <img class="job-thumb" src="${job.thumbUrl}" alt="slip" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.job-thumb-link').style.display='none'">
       </a>`
    : '<span class="job-thumb job-thumb-empty">🧾</span>';

  return `
    <article class="jobs-row">
      <div class="job-id">
        <strong>${job.id}</strong>
        <small>${job.senderTG || job.senderUsername || job.chatId || '-'}</small>
      </div>
      <div>
        <span class="${statusClass}">${job.status || '-'}</span>
        <small>${job.step || '-'}</small>
      </div>
      <div class="job-slip-cell">
        ${thumb}
        <div class="job-slip-info">
          <strong>${slipInfo}</strong>
          ${job.counterparty && job.counterparty !== '-' ? `<small class="job-recipient">👤 ผู้รับ: ${escHtml(job.counterparty)}</small>` : ''}
          ${providerBadge(job)}
          <small>${job.fileHash || ''} ${driveLink}</small>
        </div>
      </div>
      <div>
        <small>สร้าง: ${created}</small>
        <small>อัปเดต: ${updated}</small>
        ${jobDurationSec(job) != null ? `<small class="job-dur">⏱️ ${jobDurationSec(job)} วิ</small>` : ''}
      </div>
      <div class="job-error">${job.status === 'duplicate' ? duplicateInfo(job) : (job.lastError || '-')}</div>
      <div>${retryButton}</div>
    </article>
  `;
}

async function retryJob(jobId) {
  if (publicReadOnly) return showToast('Public dashboard is read-only. Retry is disabled.', 'info');
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
    const result = await res.json();
    if (!result.ok) {
      showToast(result.error || 'Retry ไม่สำเร็จ', 'error');
      return;
    }
    showToast(result.enqueued ? 'Retry และเข้าคิวแล้ว' : 'Reset job แล้ว', 'success');
    await loadJobs(true);
    await refreshStatus();
  } catch (e) {
    showToast('Retry ไม่สำเร็จ', 'error');
  }
}

async function retryAllFailedJobs() {
  if (publicReadOnly) return showToast('Public dashboard is read-only. Retry is disabled.', 'info');
  if (!confirm('ยืนยัน retry งาน failed ทั้งหมด?')) return;
  try {
    const res = await fetch('/api/jobs/retry-failed', { method: 'POST' });
    const result = await res.json();
    if (!result.ok) {
      showToast(result.error || 'Retry failed all ไม่สำเร็จ', 'error');
      return;
    }
    showToast(`Retry แล้ว ${result.reset || 0} งาน`, 'success');
    await loadJobs(true);
    await refreshStatus();
  } catch (e) {
    showToast('Retry failed all ไม่สำเร็จ', 'error');
  }
}

// === Logs ===
function addLog(message, type = 'info') {
  const container = document.getElementById('logContainer');
  const entry = document.createElement('div');
  const time = new Date().toLocaleTimeString('th-TH');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${time}] ${message}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

function clearLogs() {
  document.getElementById('logContainer').innerHTML = '<div class="log-entry info">Logs cleared.</div>';
}

// === Fetch server logs periodically ===
let lastLogIndex = 0;
async function pollLogs() {
  try {
    const res = await fetch(`/api/logs?since=${lastLogIndex}`);
    const data = await res.json();
    if (data.logs && data.logs.length > 0) {
      data.logs.forEach(log => addLog(log.message, log.type));
      lastLogIndex = data.nextIndex;
    }
  } catch (e) { /* silent */ }
}

// === Toast ===
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// === Connection Tests ===
async function testConnection(target) {
  const resultBox = document.getElementById('connectionResult');
  const button = document.querySelector(`[data-test-target="${target}"]`);
  const previousText = button?.textContent;

  if (button) {
    button.disabled = true;
    button.textContent = 'Testing...';
  }
  if (resultBox) {
    resultBox.className = 'connection-result pending';
    resultBox.textContent = `Testing ${target}...`;
  }

  try {
    const res = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target })
    });
    const result = await res.json();
    const lines = getSafeConnectionLines(target, result);
    const ok = Boolean(result.ok || result.success || result.status === 'ok' || result.status === 'connected');

    if (resultBox) {
      resultBox.className = `connection-result ${ok ? 'success' : 'error'}`;
      resultBox.textContent = lines.join('\n');
    }
    showToast(ok ? `${target} connection OK` : `${target} connection failed`, ok ? 'success' : 'error');
    await loadConfigStatus();
  } catch (e) {
    if (resultBox) {
      resultBox.className = 'connection-result error';
      resultBox.textContent = `/api/test-connection is unavailable or returned an invalid response for ${target}.`;
    }
    showToast('Connection test failed', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

// === Password Toggle ===
function togglePassword(id) {
  const input = document.getElementById(id);
  input.type = input.type === 'password' ? 'text' : 'password';
  refreshMaskedHelp();
}

// === Review Queue (คิวรอตรวจ) ===
let reviewInFlight = false;
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshReviewBadge() {
  try {
    const res = await fetch('/api/review', { cache: 'no-store' });
    const data = await res.json();
    const n = data.ok ? (data.count || 0) : 0;
    const badge = document.getElementById('reviewBadge');
    if (badge) { badge.textContent = n; badge.hidden = n === 0; }
  } catch (_) { /* silent */ }
}

async function loadReview(force = false) {
  const container = document.getElementById('reviewContainer');
  if (!container) return;
  if (reviewInFlight) return;
  reviewInFlight = true;
  if (force) container.innerHTML = '<div class="report-loading">กำลังโหลด...</div>';
  try {
    const res = await fetch('/api/review', { cache: 'no-store' });
    const data = await res.json();
    if (!data.ok) {
      container.innerHTML = `<div class="info-card"><div style="color:var(--red);text-align:center;">${escHtml(data.error || 'โหลดไม่สำเร็จ')}</div></div>`;
      return;
    }
    setText('reviewUpdatedAt', data.fetchedAt ? `อัปเดตล่าสุด ${new Date(data.fetchedAt).toLocaleTimeString('th-TH')}` : '');
    const badge = document.getElementById('reviewBadge');
    if (badge) { badge.textContent = data.count || 0; badge.hidden = (data.count || 0) === 0; }
    const items = data.items || [];
    if (items.length === 0) {
      container.innerHTML = '<div class="info-card empty-state">✅ ไม่มีสลิปรอตรวจ — ทุกใบบันทึกอัตโนมัติด้วยตัวหลักแล้ว</div>';
      return;
    }
    container.innerHTML = items.map(renderReviewCard).join('');
  } catch (e) {
    container.innerHTML = '<div class="info-card"><div style="color:var(--red);text-align:center;">โหลดไม่สำเร็จ</div></div>';
  } finally {
    reviewInFlight = false;
  }
}

const TX_OPTIONS = ['โอน', 'ถอน', 'ฝาก/รับ', 'ชำระบิล', 'อื่นๆ'];
function renderReviewCard(it) {
  const ro = publicReadOnly;
  const thumb = it.thumbUrl
    ? `<a href="${escHtml(it.driveLink || it.thumbUrl)}" target="_blank" class="job-thumb-link" title="เปิดรูปสลิป"><img class="review-thumb" src="${escHtml(it.thumbUrl)}" alt="slip" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'"></a>`
    : '<span class="job-thumb job-thumb-empty">🧾</span>';
  const txOpts = TX_OPTIONS.map(t => `<option value="${t}"${(it.tx_type === t) ? ' selected' : ''}>${t}</option>`).join('');
  const ocr = it.ocrText
    ? `<details class="review-ocr"><summary>📄 ข้อความ OCR ที่อ่านได้</summary><pre>${escHtml(it.ocrText)}</pre></details>`
    : '';
  const dis = ro ? 'disabled' : '';

  // เช็คเดือนว่าตรงกับเดือนที่ส่งสลิปไหม
  let dateWarningHtml = '';
  if (it.date && it.receivedAt) {
    const slipMonth = it.date.split('-')[1]; // e.g. "05"
    const recDate = new Date(it.receivedAt);
    const bkkMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', month: '2-digit' }).format(recDate); // e.g. "06"
    if (slipMonth && bkkMonth && slipMonth !== bkkMonth) {
      dateWarningHtml = `
        <div class="date-warning-msg" style="color:var(--red); font-size:12px; margin-top:4px; grid-column:span 2; font-weight:bold;">
          ⚠️ เดือนไม่ตรงเดือนที่รับสลิป (สลิปเดือน ${slipMonth}, รับเดือน ${bkkMonth})
          <button type="button" class="btn btn-primary" style="margin-left:8px; padding:2px 8px; font-size:11px; background:var(--blue); border:none; height:auto; display:inline-block;" onclick="updateReviewMonth('${escHtml(it.id)}', '${bkkMonth}')">เปลี่ยนเป็นเดือน ${bkkMonth}</button>
        </div>
      `;
    }
  }

  return `
    <article class="review-card" id="review-${escHtml(it.id)}">
      <div class="review-top">
        ${thumb}
        <div class="review-meta">
          <span class="review-reason">${escHtml(it.reason || 'รอตรวจ')}</span>
          <span class="review-prov">${escHtml(it.provider || '-')}</span>
          <span class="review-sender">${escHtml(it.senderTG || '')}</span>
        </div>
      </div>
      <div class="review-fields">
        <label>เลขบัญชี<input type="text" id="rv-last4-${escHtml(it.id)}" value="${escHtml(it.last4 || '')}" placeholder="2-6 หลัก" ${dis}></label>
        <label>ยอดเงิน<input type="number" step="0.01" id="rv-amount-${escHtml(it.id)}" value="${escHtml(it.amount || '')}" ${dis}></label>
        <label>ค่าธรรมเนียม<input type="number" step="0.01" id="rv-fee-${escHtml(it.id)}" value="${escHtml(it.fee || 0)}" ${dis}></label>
        <label>ประเภท<select id="rv-tx-${escHtml(it.id)}" ${dis}>${txOpts}</select></label>
        <label>ธนาคาร<input type="text" id="rv-bank-${escHtml(it.id)}" value="${escHtml(it.bank || '')}" ${dis}></label>
        <label>วันที่<input type="text" id="rv-date-${escHtml(it.id)}" value="${escHtml(it.date || '')}" placeholder="YYYY-MM-DD HH:mm" ${dis}></label>
        ${dateWarningHtml}
      </div>
      ${ocr}
      <div class="review-actions">
        <button class="btn btn-primary" onclick="confirmReview('${escHtml(it.id)}')" ${dis}>✅ ยืนยันบันทึก</button>
        <button class="btn btn-secondary" onclick="discardReview('${escHtml(it.id)}')" ${dis}>🗑️ ทิ้ง</button>
      </div>
    </article>`;
}

async function confirmReview(id) {
  if (publicReadOnly) return showToast('โหมดสาธารณะ: บันทึกไม่ได้', 'info');
  const val = (p) => document.getElementById(`rv-${p}-${id}`)?.value;
  const payload = {
    last4: val('last4'), amount: val('amount'), fee: val('fee'),
    tx_type: val('tx'), bank: val('bank'), date: val('date'),
  };
  try {
    const res = await fetch(`/api/review/${encodeURIComponent(id)}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (!r.ok) return showToast('❌ ' + (r.error || 'บันทึกไม่สำเร็จ'), 'error');
    showToast(r.duplicate ? `⚠️ สลิปนี้บันทึกแล้วในแท็บ ${r.tab}` : `✅ บันทึกบัญชี ****${r.last4}${accName(r.last4) ? ` (${accName(r.last4)})` : ''} แล้ว`, 'success');
    document.getElementById(`review-${id}`)?.remove();
    refreshReviewBadge();
    loadReview(true);
  } catch (e) { showToast('❌ บันทึกไม่สำเร็จ', 'error'); }
}

async function discardReview(id) {
  if (publicReadOnly) return showToast('โหมดสาธารณะ: ทิ้งไม่ได้', 'info');
  if (!confirm('ทิ้งสลิปนี้ออกจากคิว? (จะไม่บันทึกลงชีต)')) return;
  try {
    const res = await fetch(`/api/review/${encodeURIComponent(id)}/discard`, { method: 'POST' });
    const r = await res.json();
    if (!r.ok) return showToast('❌ ' + (r.error || 'ทิ้งไม่สำเร็จ'), 'error');
    showToast('ทิ้งออกจากคิวแล้ว', 'info');
    document.getElementById(`review-${id}`)?.remove();
    refreshReviewBadge();
    loadReview(true);
  } catch (e) { showToast('❌ ทิ้งไม่สำเร็จ', 'error'); }
}

function updateReviewMonth(id, targetMonth) {
  const input = document.getElementById(`rv-date-${id}`);
  if (input && input.value) {
    // Replace the MM part in YYYY-MM-DD
    const nextVal = input.value.replace(/^(\d{4})-(\d{2})-(.*)$/, `$1-${targetMonth}-$3`);
    input.value = nextVal;
    showToast('เปลี่ยนเดือนของวันที่เรียบร้อย', 'success');
  }
}

// === Init ===
['telegramToken', 'geminiKey', 'dashPass'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', refreshMaskedHelp);
});
loadSettings();
refreshStatus();
refreshReviewBadge();
// โหลดชื่อบัญชี (debittrans) ให้เสร็จก่อนวาดหน้าแรก — กันเลขบัญชีโผล่ก่อนแล้วชื่อมาทีหลัง
loadDebitNames().finally(() => {
  loadToday();
  loadTrends(7);
  loadAccountChart('all');
});
setInterval(loadDebitNames, 5 * 60 * 1000);
setInterval(() => {
  if (document.getElementById('tab-dashboard')?.classList.contains('active')) loadToday();
}, 60000);
// poll ช้าลงเพื่อกันชน Google Sheets read quota (บอท+เว็บ+หลายเครื่อง ใช้ quota ก้อนเดียวกัน 60/นาที)
setInterval(refreshReviewBadge, 60000);
setInterval(() => {
  if (document.getElementById('tab-review')?.classList.contains('active')) loadReview();
}, 25000);
setInterval(refreshStatus, 15000);
setInterval(pollLogs, 3000);
setInterval(() => loadConfigStatus(), 30000);
setInterval(() => {
  if (document.getElementById('tab-report')?.classList.contains('active')) {
    loadReport(null, true);
  }
}, 60000);
setInterval(() => {
  if (document.getElementById('tab-jobs')?.classList.contains('active')) {
    loadJobs();
  }
}, 15000);
