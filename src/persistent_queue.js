const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'slip_jobs.json');

const RECOVERABLE_STATUSES = new Set([
  'queued',
  'processing',
  'download',
  'duplicate_check',
  'ocr',
  'ocr_retry',
  'upload_drive',
  'save_sheet',
]);

const LEASE_TTL_MS = 2 * 60 * 1000;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    writeStore({ jobs: [] });
  }
}

function readStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch (_) {
    return { jobs: [] };
  }
}

function writeStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify({ jobs: store.jobs || [] }, null, 2);
  const tmpPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, payload, 'utf-8');
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  fs.renameSync(tmpPath, STORE_PATH);
}

function nowIso() {
  return new Date().toISOString();
}

// ลบ job ที่จบแล้ว (terminal) และเก่ากว่า keepDays — แต่เก็บล่าสุด keepRecent ตัวเสมอ
// ไม่แตะงานที่ยังค้าง (recoverable) เด็ดขาด → กัน slip_jobs.json โตไม่หยุด
function pruneOldJobs({ keepDays = 14, keepRecent = 150 } = {}) {
  const store = readStore();
  const jobs = store.jobs || [];
  if (jobs.length <= keepRecent) return 0;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const sorted = [...jobs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const keepIds = new Set(sorted.slice(0, keepRecent).map(j => j.id));
  const kept = jobs.filter(j => {
    if (keepIds.has(j.id)) return true;                       // เก็บล่าสุดเสมอ
    if (RECOVERABLE_STATUSES.has(j.status)) return true;      // งานค้าง = ห้ามลบ
    const t = Date.parse(j.finishedAt || j.updatedAt || j.createdAt || '') || 0;
    return !(t && t < cutoff);                                // ลบ terminal ที่เก่ากว่า cutoff
  });
  const removed = jobs.length - kept.length;
  if (removed > 0) writeStore({ jobs: kept });
  return removed;
}

function createSlipJob(input) {
  const store = readStore();
  const job = {
    id: `slip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'slip',
    status: 'queued',
    step: 'queued',
    attempts: { ocr: 0, drive: 0, sheet: 0 },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...input,
  };
  store.jobs.push(job);
  writeStore(store);
  return job;
}

function updateJob(id, patch) {
  const store = readStore();
  const index = store.jobs.findIndex(job => job.id === id);
  if (index === -1) return null;
  store.jobs[index] = {
    ...store.jobs[index],
    ...patch,
    updatedAt: nowIso(),
  };
  writeStore(store);
  return store.jobs[index];
}

function getJob(id) {
  return readStore().jobs.find(job => job.id === id) || null;
}

// หา job ที่มี fileHash ตรงกัน (ใช้เช็คสลิปซ้ำจากในเครื่อง ไม่ต้องอ่าน Google Sheets)
function findJobByHash(fileHash, { excludeId = null, statuses = null } = {}) {
  if (!fileHash) return null;
  const set = statuses ? new Set(statuses) : null;
  return readStore().jobs.find(job =>
    job.fileHash === fileHash &&
    job.id !== excludeId &&
    (!set || set.has(job.status))
  ) || null;
}

function listJobs(filter = {}) {
  let jobs = readStore().jobs;
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? new Set(filter.status) : new Set([filter.status]);
    jobs = jobs.filter(job => statuses.has(job.status));
  }
  return jobs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function listRecoverableJobs(options = {}) {
  return listJobs().filter(job => (
    RECOVERABLE_STATUSES.has(job.status)
    && (options.includeLeased || isLeaseExpired(job))
  ));
}

function listFailedJobs() {
  return listJobs({ status: 'failed' });
}

function markDone(id, patch = {}) {
  return updateJob(id, {
    ...patch,
    status: patch.status || 'done',
    step: patch.step || 'done',
    finishedAt: nowIso(),
    lastError: '',
  });
}

function markFailed(id, error, patch = {}) {
  return updateJob(id, {
    ...patch,
    status: 'failed',
    step: patch.step || 'failed',
    finishedAt: nowIso(),
    lastError: error?.message || String(error || 'Unknown error'),
  });
}

function resetFailedJob(id) {
  const job = getJob(id);
  if (!job || job.status !== 'failed') return null;
  return updateJob(id, {
    status: 'queued',
    step: 'queued',
    leaseOwner: '',
    leaseUntil: '',
    finishedAt: '',
    lastError: '',
  });
}

// ล้างงานทั้งหมด + hash กันซ้ำ (ให้ส่งสลิปเดิมเข้ามาใหม่ได้) — ใช้ตอนกดล้างทั้งหมด
function clearAll() {
  writeStore({ jobs: [] });
  return true;
}

function isLeaseExpired(job) {
  if (!job.leaseUntil) return true;
  const leaseUntil = Date.parse(job.leaseUntil);
  return Number.isNaN(leaseUntil) || leaseUntil <= Date.now();
}

function acquireLease(id, owner, ttlMs = LEASE_TTL_MS) {
  const job = getJob(id);
  if (!job) return null;
  if (!isLeaseExpired(job) && job.leaseOwner && job.leaseOwner !== owner) return null;
  return updateJob(id, {
    leaseOwner: owner,
    leaseUntil: new Date(Date.now() + ttlMs).toISOString(),
  });
}

function renewLease(id, owner, ttlMs = LEASE_TTL_MS) {
  const job = getJob(id);
  if (!job || (job.leaseOwner && job.leaseOwner !== owner)) return null;
  return updateJob(id, {
    leaseOwner: owner,
    leaseUntil: new Date(Date.now() + ttlMs).toISOString(),
  });
}

function releaseLease(id, owner) {
  const job = getJob(id);
  if (!job || (job.leaseOwner && job.leaseOwner !== owner)) return null;
  return updateJob(id, {
    leaseOwner: '',
    leaseUntil: '',
  });
}

function getStats() {
  const jobs = listJobs();
  return {
    total: jobs.length,
    queued: jobs.filter(job => job.status === 'queued').length,
    processing: jobs.filter(job => job.status === 'processing').length,
    recoverable: jobs.filter(job => RECOVERABLE_STATUSES.has(job.status)).length,
    leased: jobs.filter(job => job.leaseUntil && !isLeaseExpired(job)).length,
    failed: jobs.filter(job => job.status === 'failed').length,
    done: jobs.filter(job => job.status === 'done' || job.status === 'duplicate').length,
    latest: jobs[jobs.length - 1] || null,
  };
}

module.exports = {
  createSlipJob,
  updateJob,
  getJob,
  findJobByHash,
  listJobs,
  listRecoverableJobs,
  listFailedJobs,
  markDone,
  markFailed,
  resetFailedJob,
  clearAll,
  pruneOldJobs,
  acquireLease,
  renewLease,
  releaseLease,
  isLeaseExpired,
  getStats,
};
