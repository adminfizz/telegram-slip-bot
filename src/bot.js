const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const md5 = require('md5');
const fs = require('fs');

const {
  initSpreadsheet,
  getOrCreateAccountTab,
  checkDuplicate,
  appendSlip,
  updateBotHeartbeat,
  recordTokenUsage,
  recordProviderUsage,
  setTokenUsage,
  updateSystemState,
  getOcrConfig,
  setJobsSnapshot,
  addReviewItem,
} = require('./sheets');
const { extractSlipData } = require('./ocr');
const { parseSlipData, slipDateWarning } = require('./parser');
const { uploadSlip } = require('./drive');
const { mirrorSlip, clearLocalDb } = require('./localdb');
const slipQueue = require('./queue');
const {
  createSlipJob,
  updateJob,
  getJob,
  findJobByHash,
  listJobs,
  listRecoverableJobs,
  markDone,
  markFailed,
  resetFailedJob,
  listFailedJobs,
  getStats: getPersistentQueueStats,
  acquireLease,
  renewLease,
  releaseLease,
  clearAll: clearAllJobs,
  pruneOldJobs,
} = require('./persistent_queue');

const reportCommand = require('./commands/report');

let spreadsheetId = null;
let heartbeatTimer = null;
let usageSyncTimer = null;
let queueReportTimer = null;   // throttle การเขียนสถานะคิวลง _system tab
let pendingQueueState = null;
let jobsSyncTimer = null;      // debounce การ sync รายการงานลง _jobs tab (ให้ Vercel อ่าน)
let lastOcrConfigSig = '';     // กัน log ซ้ำเวลา config โมเดลไม่เปลี่ยน
let lastWipeSignal = null;     // null = ยังไม่ตั้ง baseline (กันล้าง local ตอนรีสตาร์ท)

// ล้างข้อมูลในเครื่อง (ไฟล์งาน + ตัวนับ token/รูป) — เรียกเมื่อได้รับ wipe_signal ใหม่จากเว็บ
function clearLocalDataOnWipe() {
  try { clearAllJobs(); } catch (e) { console.error('wipe: clearAllJobs failed:', e.message); }
  try { clearLocalDb(); } catch (e) { console.error('wipe: clearLocalDb failed:', e.message); }
  try {
    fs.writeFileSync(path.join(process.cwd(), 'ai_usage.json'), JSON.stringify({ totalTokens: 0, count: 0 }, null, 2), 'utf-8');
  } catch (e) { console.error('wipe: reset ai_usage.json failed:', e.message); }
  console.log('[wipe] ล้างข้อมูลในเครื่อง (งาน + token/รูป) ตามคำสั่งจากเว็บแล้ว');
}

// ดึง config โมเดล OCR ที่ผู้ใช้ตั้งบนเว็บ (เก็บใน _config) มาใส่ process.env + รับสัญญาณล้างข้อมูล
// เพื่อให้บอท (คนละโปรเซส/คนละเครื่องกับ Vercel) ใช้โมเดลที่เลือกบนเว็บได้จริง
async function syncOcrConfigFromSheet(authClient, ssid) {
  if (!ssid) return;
  try {
    const cfg = await getOcrConfig(authClient, ssid);
    const applied = {};
    ['OCR_MODEL', 'OCR_FALLBACK_1', 'OCR_FALLBACK_2'].forEach(envKey => {
      const v = cfg[envKey];
      if (v && String(v).trim()) { process.env[envKey] = String(v).trim(); applied[envKey] = process.env[envKey]; }
    });
    // allow-list / summary chat: ถ้าตั้งบนเว็บ (มี key ใน _config) ให้ override .env แม้ค่าว่าง
    // (ว่าง = ทุกคนใช้บอทได้) — ทำให้จัดการผู้ใช้/กลุ่มจากเว็บได้จริง
    ['ALLOWED_CHAT_IDS', 'SUMMARY_CHAT_ID'].forEach(envKey => {
      if (Object.prototype.hasOwnProperty.call(cfg, envKey)) {
        process.env[envKey] = String(cfg[envKey] == null ? '' : cfg[envKey]).trim();
        applied[envKey] = process.env[envKey];
      }
    });

    // รับ wipe_signal: ครั้งแรก (startup) แค่ตั้ง baseline ไม่ล้าง; ถ้าเปลี่ยนตอนรัน = สั่งล้าง local
    const wsig = cfg.wipe_signal || '';
    if (lastWipeSignal === null) lastWipeSignal = wsig;
    else if (wsig && wsig !== lastWipeSignal) { lastWipeSignal = wsig; clearLocalDataOnWipe(); }
    const sig = JSON.stringify(applied);
    if (Object.keys(applied).length && sig !== lastOcrConfigSig) {
      lastOcrConfigSig = sig;
      console.log(`[OCR config] ใช้ค่าจากเว็บ: ${sig}`);
    }
  } catch (err) {
    console.error('syncOcrConfigFromSheet failed:', err.message);
  }
}

// ตัดเฉพาะ field ที่แดชบอร์ดต้องใช้ (ลดขนาด snapshot)
function trimJobForSnapshot(j) {
  return {
    id: j.id, type: j.type, status: j.status, step: j.step,
    createdAt: j.createdAt, updatedAt: j.updatedAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
    chatId: j.chatId, senderTG: j.senderTG, senderUsername: j.senderUsername,
    last4: j.last4,
    parsedData: j.parsedData ? {
      last4: j.parsedData.last4, amount: j.parsedData.amount,
      tx_type: j.parsedData.tx_type, bank: j.parsedData.bank,
      counterparty: j.parsedData.counterparty,
    } : undefined,
    fileHash: j.fileHash, driveLink: j.driveLink, tabName: j.tabName,
    duplicateTabName: j.duplicateTabName, lastError: j.lastError,
    duplicateOfJobId: j.duplicateOfJobId, duplicateOfDriveLink: j.duplicateOfDriveLink, duplicateOfDate: j.duplicateOfDate,
    ocrProvider: j.ocrProvider, ocrStatus: j.ocrStatus,
    attempts: j.attempts, leaseOwner: j.leaseOwner, leaseUntil: j.leaseUntil,
  };
}

// sync รายการงานล่าสุดลง Google Sheets (_jobs) แบบ debounce ~6 วิ — ให้ Vercel อ่านหน้าคิวสด
function scheduleJobsSync(authClient) {
  if (!spreadsheetId || jobsSyncTimer) return;
  jobsSyncTimer = setTimeout(async () => {
    jobsSyncTimer = null;
    if (!spreadsheetId) return;
    try {
      const jobs = listJobs().slice(-25).reverse().map(trimJobForSnapshot); // 25 งานล่าสุด ใหม่→เก่า
      const stats = getPersistentQueueStats();
      await setJobsSnapshot(authClient, spreadsheetId, { jobs, stats, fetchedAt: new Date().toISOString() });
    } catch (e) {
      console.error('Jobs snapshot sync failed:', e.message);
    }
  }, 6000);
  if (jobsSyncTimer.unref) jobsSyncTimer.unref();
}
const queueLeaseOwner = `${require('os').hostname()}:${process.pid}`;

function getSpreadsheetId() {
  return spreadsheetId;
}

function setupBot(authClient) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const bot = new TelegramBot(botToken, { polling: true });
  spreadsheetId = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (usageSyncTimer) {
    clearInterval(usageSyncTimer);
    usageSyncTimer = null;
  }
  if (queueReportTimer) {
    clearTimeout(queueReportTimer);
    queueReportTimer = null;
  }
  if (jobsSyncTimer) {
    clearTimeout(jobsSyncTimer);
    jobsSyncTimer = null;
  }
  pendingQueueState = null;

  function checkAccess(msg) {
    const allowed = process.env.ALLOWED_CHAT_IDS;
    if (!allowed) return true; // allow all if empty
    const ids = allowed.split(',').map(id => id.trim());
    return ids.includes(msg.chat.id.toString());
  }

  // Initialize Spreadsheet
  initSpreadsheet(authClient).then(async id => {
    spreadsheetId = id;
    console.log(`📋 Spreadsheet ready: ${id}`);
    await syncLocalUsageToSheet(authClient, id);
    // รายงานสถานะคิวแบบ throttle: เก็บ state ล่าสุดไว้ แล้วเขียนลง _system tab ครั้งเดียวทุก ~4 วิ
    // (เดิมเขียนทุก event ของคิว ~10 ครั้ง/สลิป × clear+update = ~20 writes/สลิป → เปลือง write quota)
    slipQueue.setReporter(queueState => {
      if (!spreadsheetId) return;
      scheduleJobsSync(authClient); // sync รายการงานลง _jobs (debounce) ให้ Vercel อ่านสด
      pendingQueueState = queueState;
      if (queueReportTimer) return;
      queueReportTimer = setTimeout(async () => {
        queueReportTimer = null;
        const state = pendingQueueState;
        pendingQueueState = null;
        if (!state || !spreadsheetId) return;
        try {
          const persistentStats = getPersistentQueueStats();
          await updateSystemState(authClient, spreadsheetId, {
            queue_waiting: state.waiting,
            queue_active: state.active,
            queue_concurrency: state.concurrency,
            queue_persisted_total: persistentStats.total,
            queue_persisted_recoverable: persistentStats.recoverable,
            queue_persisted_failed: persistentStats.failed,
            queue_persisted_done: persistentStats.done,
            queue_current_task_id: state.currentTaskId,
            queue_current_chat_id: state.currentChatId,
            queue_current_step: state.currentStep,
            queue_current_started_at: state.currentStartedAt,
            queue_processed_count: state.processedCount,
            queue_failed_count: state.failedCount,
            queue_last_success_at: state.lastSuccessAt,
            queue_last_success_task_id: state.lastSuccessTaskId,
            queue_last_error_at: state.lastErrorAt,
            queue_last_error: state.lastError,
            queue_last_error_task_id: state.lastErrorTaskId,
            queue_last_retry_at: state.lastRetryAt,
            queue_last_retry: state.lastRetry,
            queue_last_retry_task_id: state.lastRetryTaskId,
            queue_updated_at: state.updatedAt,
          });
        } catch (e) {
          console.error('Queue state report failed:', e.message);
        }
      }, 4000);
      if (queueReportTimer.unref) queueReportTimer.unref();
    });
    await updateBotHeartbeat(authClient, id);
    recoverPendingJobs(bot, authClient, checkAccess);
    syncOcrConfigFromSheet(authClient, id); // ดึง config โมเดลที่ตั้งบนเว็บ (Vercel) มาใช้ตั้งแต่เริ่ม
    heartbeatTimer = setInterval(() => {
      if (!spreadsheetId) return;
      updateBotHeartbeat(authClient, spreadsheetId).catch(err => {
        console.error('Heartbeat update failed:', err.message);
      });
      syncOcrConfigFromSheet(authClient, spreadsheetId); // อัปเดต config โมเดลทุก 30 วิ (ให้เว็บเปลี่ยนแล้วมีผล)
    }, 30000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
    usageSyncTimer = setInterval(() => {
      if (!spreadsheetId) return;
      syncLocalUsageToSheet(authClient, spreadsheetId).catch(err => {
        console.error('Usage sync retry failed:', err.message);
      });
    }, 300000);
    if (usageSyncTimer.unref) usageSyncTimer.unref();
  }).catch(err => {
    console.error('❌ Failed to initialize spreadsheet:', err.message);
  });

  // Setup Telegram native command menu
  bot.setMyCommands([
    { command: '/report', description: 'ดูสรุปยอด (วันนี้/ย้อนหลัง)' },
    { command: '/add', description: 'บันทึกรายการแบบไม่มีสลิป' },
    { command: '/undo', description: 'ลบรายการล่าสุดที่เพิ่งส่ง' },
    { command: '/clear_all', description: 'ล้างข้อมูลของวันนี้ (ทุกบัญชี)' },
    { command: '/wipe_all', description: 'ล้างเกลี้ยง (ทุกวัน+ลบรูป Drive)' },
    { command: '/status', description: 'เช็กสถานะบอทและ Token' },
    { command: '/queue', description: 'เช็กคิว OCR และงานที่กำลังประมวลผล' },
    { command: '/failed', description: 'ดูงานสลิปที่ล้มเหลว' },
    { command: '/retry_failed', description: 'รันงานที่ล้มเหลวใหม่' },
    { command: '/sheetlink', description: 'ขอลิงก์ Google Sheets' },
    { command: '/help', description: 'ดูรายการคำสั่งและวิธีใช้งาน' }
  ]).catch(err => console.error('Failed to set commands:', err.message));

  const mainKeyboard = {
    reply_markup: {
      keyboard: [
        [{ text: '📊 ดูสรุปยอดรวม' }, { text: '📊 สถานะระบบ' }],
        [{ text: '⏱️ ดูคิว OCR' }, { text: '⚠️ งานล้มเหลว' }],
        [{ text: '🔁 Retry Failed All' }, { text: '🔗 ลิงก์ Sheets' }],
        [{ text: '🗑️ ล้างยอดวันนี้' }, { text: '🔥 ล้างเกลี้ยงทั้งหมด' }],
        [{ text: 'ℹ️ วิธีใช้งาน' }]
      ],
      resize_keyboard: true,
      is_persistent: true
    }
  };

  // /start command
  bot.onText(/\/start/, (msg) => {
    if (!checkAccess(msg)) return bot.sendMessage(msg.chat.id, '⛔ ไม่อนุญาตให้ใช้งาน (Unauthorized)');
    const chatId = msg.chat.id;
    const welcome = [
      '🤖 ยินดีต้อนรับสู่ Slip Bot!',
      '',
      '📷 ส่งรูปสลิปมาได้เลย บอทจะวิเคราะห์และบันทึกลง Google Sheets แยกตามบัญชีให้อัตโนมัติ',
      '',
      '📌 คำสั่งที่ใช้ได้:',
      '/report — ดูสรุปยอดโอน+กดเงิน ทุกบัญชี',
      '/report [4ตัวท้าย] — ดูเฉพาะบัญชี',
      '/sheetlink — ลิงก์ Google Sheets',
      '',
      `💬 Chat ID ของคุณ: ${chatId}`,
      '(เอาไปใส่ SUMMARY_CHAT_ID ใน .env เพื่อรับสรุปรายวันอัตโนมัติ)'
    ].join('\n');
    bot.sendMessage(chatId, welcome, mainKeyboard);
  });

  // /sheetlink command and button
  const handleSheetLink = (msg) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    if (spreadsheetId) {
      bot.sendMessage(chatId, `📋 Google Sheets:\nhttps://docs.google.com/spreadsheets/d/${spreadsheetId}`, mainKeyboard);
    } else {
      bot.sendMessage(chatId, '⚠️ ยังไม่มี Spreadsheet', mainKeyboard);
    }
  };
  bot.onText(/\/sheetlink/, handleSheetLink);
  bot.onText(/🔗 ลิงก์ Sheets/, handleSheetLink);

  // /help command and button
  const handleHelp = (msg) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const helpMsg = [
      '📌 **คำสั่งทั้งหมดของ Slip Bot**',
      '',
      '📷 **ส่งรูปสลิป** — บอทจะอ่านข้อมูลและบันทึกลง Sheet ให้อัตโนมัติ',
      '📄 `/report` — ดูสรุปยอดของวันนี้',
      '📄 `/report 4321` — ดูรายละเอียดเฉพาะบัญชี 4321',
      '📄 `/report 4321 2026-05-26` — ดูสรุปย้อนหลังระบุวันที่',
      '➕ `/add 4321 500 โอนเงินสด` — บันทึกรายการเอง (Manual)',
      '↩️ `/undo 4321` — ยกเลิกรายการล่าสุดที่เพิ่งส่งไป',
      '🗑️ `/clear 4321` — ล้างข้อมูลบัญชี 4321 ของวันนี้ทั้งหมด',
      '📊 `/status` — เช็กสถานะและยอดการใช้ Token Gemini',
      '⏱️ `/queue` — เช็กคิว OCR และงานที่กำลังประมวลผล',
      '⚠️ `/failed` — ดูงานสลิปที่ล้มเหลว',
      '🔁 `/retry_failed <job_id|all>` — รันงานที่ล้มเหลวใหม่',
      '🔗 `/sheetlink` — ขอลิงก์ Google Sheets',
      '',
      '⚠️ หากพบปัญหา สามารถพิมพ์ติดต่อผู้ดูแลระบบได้เลย'
    ].join('\n');
    bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown', ...mainKeyboard });
  };
  bot.onText(/\/help/, handleHelp);
  bot.onText(/ℹ️ วิธีใช้งาน/, handleHelp);

  bot.on('polling_error', (error) => {
    console.error(`[Telegram Polling Error] ${error.code}: ${error.message}`);
    // Not killing the process, let it retry
  });

  // Handle photos (slips)
  bot.on('photo', async (msg) => {
    if (!checkAccess(msg)) {
      bot.sendMessage(msg.chat.id, '⛔ ระบบถูกล็อกให้ใช้งานเฉพาะเจ้าของเท่านั้น');
      return;
    }
    const chatId = msg.chat.id;
    const senderTG = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

    if (!spreadsheetId) {
      bot.sendMessage(chatId, '⚠️ ระบบยังเชื่อมต่อ Spreadsheet ไม่เสร็จ กรุณารอสักครู่...');
      return;
    }

    const fileId = msg.photo[msg.photo.length - 1].file_id;

    // สร้าง job ลง store "ก่อน" (เขียนแบบ sync ทันที) เพื่อให้นับลำดับคิวถูกต้อง
    // แม้ส่งหลายใบพร้อมกัน (เดิมคำนวณก่อน enqueue → ทุกใบเห็นคิวว่าง = ลำดับ 1 หมด)
    const job = createSlipJob({
      chatId,
      messageId: msg.message_id,
      telegramFileId: fileId,
      senderTG,
      senderId: msg.from.id,
      senderUsername: msg.from.username || '',
    });

    // ลำดับ = จำนวนงานที่ยังค้าง (queued/processing) รวมใบนี้ — ดึงจาก persistent queue
    let queuePosition = 1;
    try {
      const pending = listRecoverableJobs({ includeLeased: true }).length;
      queuePosition = pending > 0 ? pending : 1;
      console.log(`[queue] slip ${job.id} → ลำดับที่ ${queuePosition} (pending=${pending})`);
    } catch (e) {
      console.error('queue position calc failed:', e.message);
    }

    let processingMsg = null;
    try {
      processingMsg = await bot.sendMessage(
        chatId,
        `⏳ ได้รับสลิปแล้ว กำลังเข้าคิวรอประมวลผล... (ลำดับที่ ${queuePosition})`,
        { reply_to_message_id: msg.message_id }
      );
      updateJob(job.id, { processingMessageId: processingMsg.message_id });
    } catch (e) {
      console.error('Failed to send initial queue message:', e);
    }

    await enqueueSlipJob(bot, authClient, job.id, { notifyResume: false });
  });

  // Attach commands
  const { setupReportCommand } = require('./commands/report');
  const { setupUndoCommand } = require('./commands/undo');
  const { setupClearCommand } = require('./commands/clear');
  const { setupAddCommand } = require('./commands/add');
  const { setupStatusCommand } = require('./commands/status');
  
  setupReportCommand(bot, authClient, getSpreadsheetId);
  setupUndoCommand(bot, authClient, getSpreadsheetId);
  setupClearCommand(bot, authClient, getSpreadsheetId);
  setupAddCommand(bot, authClient, getSpreadsheetId);
  setupStatusCommand(bot, authClient, getSpreadsheetId, (jobId) => enqueueSlipJob(bot, authClient, jobId, { notifyResume: true }));

  return bot;
}

async function enqueueSlipJob(bot, authClient, jobId, options = {}) {
  const job = getJob(jobId);
  if (!job) return false;

  slipQueue.add({
    id: job.id,
    retries: 0,
    maxRetries: 0,
    chatId: job.chatId,
    execute: async function() {
      await processSlipJob(bot, authClient, job.id, this, options);
    },
    onFail: async (error) => {
      markFailed(job.id, error);
      await notifyJob(bot, job.id, `❌ งาน ${job.id} ล้มเหลว: ${error.message || error}`);
    },
  });

  return true;
}

async function recoverPendingJobs(bot, authClient) {
  // ลบ job เก่าที่จบแล้วตอนบูต (กัน slip_jobs.json โตไม่หยุด — ไม่แตะงานค้าง)
  try { const n = pruneOldJobs({ keepDays: 14, keepRecent: 150 }); if (n > 0) console.log(`[Recovery] ลบ job เก่า ${n} รายการ`); } catch (_) {}
  const jobs = listRecoverableJobs({ includeLeased: true });
  if (jobs.length === 0) return;
  console.log(`[Recovery] Re-queueing ${jobs.length} persisted slip job(s).`);
  for (const job of jobs) {
    updateJob(job.id, { status: 'queued', step: 'queued' });
    await enqueueSlipJob(bot, authClient, job.id, { notifyResume: true });
  }
}

async function processSlipJob(bot, authClient, jobId, task, options = {}) {
  const leased = acquireLease(jobId, queueLeaseOwner);
  if (!leased) {
    console.warn(`[Queue] Job ${jobId} is leased by another worker; skipping.`);
    return;
  }

  let job = getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  try {
    if (options.notifyResume) {
      await notifyJob(bot, jobId, `🔁 กู้คืนงานค้าง ${jobId} กลับเข้าคิวแล้ว`);
    }

    updateJob(jobId, { status: 'processing', step: 'download', startedAt: job.startedAt || new Date().toISOString() });
    await updateQueueStep(task, 'download');

    let downloadPath = job.localPath && fs.existsSync(job.localPath) ? job.localPath : null;
    if (!downloadPath) {
      await editOrSend(bot, job, '⏳ กำลังดาวน์โหลดรูปสลิป...');
      const tempPath = await bot.downloadFile(job.telegramFileId, path.join(__dirname, '..', 'temp'));
      downloadPath = persistSlipFile(tempPath, jobId);
      job = updateJob(jobId, { localPath: downloadPath }) || getJob(jobId);
    }
    renewLease(jobId, queueLeaseOwner);

    const fileBuffer = fs.readFileSync(downloadPath);
    const fileHash = job.fileHash || md5(fileBuffer);
    job = updateJob(jobId, { fileHash, step: 'duplicate_check' }) || getJob(jobId);

    await updateQueueStep(task, 'duplicate_check');
  await editOrSend(bot, job, '🔍 กำลังตรวจสอบสลิปซ้ำ...');
  // เช็คซ้ำจากไฟล์ในเครื่องก่อน (0 read quota) — ประหยัด OCR ด้วยถ้าเป็นสลิปที่เคยส่งแล้ว
  const localDup = findJobByHash(fileHash, { excludeId: jobId, statuses: ['done', 'duplicate'] });
  let dupCheck = localDup
    ? { duplicate: true, tabName: localDup.tabName || (localDup.last4 ? `บัญชี_${localDup.last4}` : '-') }
    : { duplicate: false };
  if (dupCheck.duplicate) {
    cleanup(downloadPath);
    markDone(jobId, {
      status: 'duplicate', step: 'duplicate', duplicateTabName: dupCheck.tabName,
      duplicateOfJobId: localDup ? localDup.id : '',
      duplicateOfDriveLink: localDup ? localDup.driveLink : '',
      duplicateOfDate: localDup && localDup.parsedData ? localDup.parsedData.date : '',
    });
    const origNote = localDup ? `\n📎 ซ้ำกับใบที่เคยส่ง (งาน ${localDup.id})` : '';
    await editOrSend(bot, job, `⚠️ สลิปซ้ำ งาน ${jobId}\nเคยบันทึกในแท็บ "${dupCheck.tabName}" แล้ว${origNote}`);
    return;
  }

  let parsedData = job.parsedData || null;
  let ocrStatus = job.ocrStatus || null;     // 'auto' | 'review' | 'manual'
  let ocrText = job.ocrText || null;          // ข้อความ OCR ดิบ (ไว้ prefill คิวรอตรวจ)
  let ocrProvider = job.ocrProvider || null;  // ค่าย/โมเดลที่จับได้
  if (!parsedData && ocrStatus !== 'manual') {
    await updateQueueStep(task, 'ocr');
    updateJob(jobId, { step: 'ocr' });
    await editOrSend(bot, job, '🧠 กำลังอ่านข้อมูลสลิป (AI)...');
    const ocrResult = await retryOperation('OCR', 3, async (attempt) => {
      updateJob(jobId, { step: attempt > 1 ? `ocr_retry_${attempt}` : 'ocr' });
      if (attempt > 1) {
        await updateQueueStep(task, `ocr_retry_${attempt}`);
        await editOrSend(bot, job, `🧠 OCR ไม่สำเร็จ กำลังลองใหม่รอบ ${attempt}/3...`);
      }
      return extractSlipData(downloadPath);
    });

    parsedData = parseSlipData(ocrResult ? ocrResult.data : null);
    ocrStatus = ocrResult ? ocrResult.status : 'manual';
    ocrText = ocrResult ? ocrResult.ocrText : null;
    ocrProvider = ocrResult && ocrResult.provider ? `${ocrResult.provider}/${ocrResult.model || ''}` : null;
    updateJob(jobId, {
      parsedData,
      ocrStatus,
      ocrText,
      ocrProvider,
      ocrTokens: ocrResult?.tokens || 0,
      step: 'ocr_done',
    });

    if (ocrResult && Array.isArray(ocrResult.attempts) && ocrResult.attempts.length && !job.tokenRecorded) {
      console.log(`[OCR] Job ${jobId}: ${ocrResult.attempts.map(a => `${a.provider}${a.ok ? '✓' : (a.error ? '✗' : '~')}`).join(' ')} (${ocrResult.tokens || 0} tok)`);
      await recordUsage(authClient, ocrResult.tokens || 0, ocrResult.attempts, ocrStatus);
      updateJob(jobId, { tokenRecorded: true });
    }
  }

  const hasLast4 = parsedData && parsedData.last4 && parsedData.last4 !== 'UNKNOWN' && parsedData.last4 !== 'null';

  // ── ตรวจวันที่น่าสงสัย (อาจ OCR อ่านเดือน/วันผิด) เทียบกับเวลาที่รับสลิป (job.createdAt) ──
  // window ปรับได้ผ่าน env SLIP_DATE_MAX_AGE_DAYS (ดีฟอลต์ 14 วัน) — สลิปเก่ากว่านี้/อนาคต จะถูกส่งเข้าคิวรอตรวจ
  // ผู้ใช้ส่งสลิป "วันต่อวัน" → วันที่ต่างจากวันรับเกิน N วัน (ดีฟอลต์ 1 = วันนี้/เมื่อวานผ่าน) ให้เข้ารอตรวจ
  const maxAgeDays = Number(process.env.SLIP_DATE_MAX_AGE_DAYS || 1);
  const dateWarn = (hasLast4 && parsedData && parsedData.date)
    ? slipDateWarning(parsedData.date, job.createdAt, maxAgeDays)
    : null;
  // ยอดเงินอ่านไม่ได้/≤0 = ถือว่าจับไม่ครบ ต้องตรวจก่อน
  const badAmount = hasLast4 && !(Number(parsedData.amount) > 0);
  // OCR บอกเองว่าไม่มั่นใจ (ตัวเลขจาง/เบลอ) → รอตรวจ
  const uncertain = hasLast4 && parsedData && parsedData.uncertain === true;

  // ── เข้าคิว "รอตรวจ" เมื่อ: ใช้ตัวสำรอง / จับไม่ครบ / วันที่ต่างวัน / ยอดผิด / ไม่มั่นใจ — ไม่บันทึกชีตทันที ──
  // (งานเก่าที่ค้างคิวจากก่อนอัปเดตจะมี ocrStatus = undefined → ถือว่า auto ถ้ามีเลขบัญชี เพื่อความเข้ากันได้ย้อนหลัง)
  if ((ocrStatus && ocrStatus !== 'auto') || !hasLast4 || dateWarn || badAmount || uncertain) {
    const isManual = ocrStatus === 'manual' || !hasLast4 || badAmount;
    if (dateWarn) console.log(`[date-guard] ${jobId}: ${dateWarn}`);
    if (badAmount) console.log(`[amount-guard] ${jobId}: ยอดเงินอ่านไม่ได้/≤0`);
    if (uncertain) console.log(`[confidence-guard] ${jobId}: OCR ไม่มั่นใจ (ตัวเลขจาง/เบลอ)`);
    // อัปโหลดรูปขึ้น Drive ก่อน (best-effort) เพื่อให้หน้าเว็บรอตรวจมีรูปให้ดู
    let driveLink = job.driveLink || null;
    if (!driveLink) {
      try {
        await updateQueueStep(task, 'upload_drive');
        const fileName = `review_${jobId}_${fileHash}.jpg`;
        driveLink = await retryOperation('Drive upload', 2, () => uploadSlip(authClient, downloadPath, fileName, {
          last4: hasLast4 ? parsedData.last4 : 'review', date: parsedData && parsedData.date,
        }));
        updateJob(jobId, { driveLink });
      } catch (e) { console.error('review drive upload failed:', e.message); }
    }

    const reviewItem = {
      id: jobId,
      createdAt: parsedData && parsedData.date ? parsedData.date : null,
      receivedAt: job.createdAt || new Date().toISOString(),
      last4: hasLast4 ? parsedData.last4 : '',
      amount: parsedData ? parsedData.amount : 0,
      fee: parsedData ? parsedData.fee : 0,
      tx_type: parsedData ? parsedData.tx_type : '',
      counterparty: parsedData ? parsedData.counterparty : '-',
      recipient_last4: parsedData ? (parsedData.recipient_last4 || '') : '',
      bank: parsedData ? parsedData.bank : '-',
      date: parsedData ? parsedData.date : '',
      driveLink: driveLink || '',
      ocrText: ocrText || '',
      provider: ocrProvider || '',
      reason: dateWarn ? `วันที่น่าสงสัย — ${dateWarn}` : (uncertain ? 'OCR ไม่มั่นใจยอด/เลขบัญชี (จาง/เบลอ) — โปรดตรวจ' : (isManual ? 'จับไม่ครบ — ต้องกรอกเอง' : 'ใช้ตัวสำรอง — รอยืนยัน')),
      senderTG: job.senderTG || '-',
      fileHash,
    };
    try {
      await retryOperation('Review queue', 3, () => addReviewItem(authClient, spreadsheetId, reviewItem));
    } catch (e) { console.error('addReviewItem failed:', e.message); }

    markDone(jobId, { status: 'review', step: 'review', last4: reviewItem.last4 });
    await updateQueueStep(task, 'review');
    cleanup(downloadPath);

    const msg = dateWarn
      ? [
          `🟠 งาน ${jobId}: วันที่บนสลิปน่าสงสัย`,
          `🔢 บัญชี: ****${reviewItem.last4}  💰 ${Number(reviewItem.amount).toLocaleString('en-US')} บาท  📅 ${reviewItem.date}`,
          `❓ ${dateWarn}`,
          '📝 เข้าคิว "รอตรวจ" บนเว็บแล้ว — โปรดตรวจ/แก้วันที่ก่อนยืนยันบันทึก',
        ].join('\n')
      : uncertain
      ? [
          `🟠 งาน ${jobId}: OCR ไม่มั่นใจ (ตัวเลขจาง/เบลอ)`,
          `🔢 บัญชี: ****${reviewItem.last4}  💰 ${Number(reviewItem.amount).toLocaleString('en-US')} บาท`,
          '📝 เข้าคิว "รอตรวจ" บนเว็บแล้ว — โปรดตรวจยอด/เลขบัญชีก่อนยืนยัน',
        ].join('\n')
      : isManual
      ? [
          `⚠️ งาน ${jobId}: อ่านสลิปไม่ครบ`,
          ocrProvider ? `🔎 ตรวจด้วย: ${ocrProvider}` : '',
          parsedData && parsedData.amount ? `💰 ยอดที่พออ่านได้: ${Number(parsedData.amount).toLocaleString('en-US')}` : '',
          '📝 เข้าคิว "รอตรวจ" บนเว็บแล้ว — กรุณาเปิดแดชบอร์ดเพื่อกรอก/แก้ไขแล้วยืนยันบันทึก',
        ].filter(Boolean).join('\n')
      : [
          `🟡 งาน ${jobId}: จับยอดได้ด้วยตัวสำรอง (${ocrProvider || '-'})`,
          `🔢 บัญชี: ****${reviewItem.last4}  💰 ${Number(reviewItem.amount).toLocaleString('en-US')} บาท`,
          '📝 เข้าคิว "รอตรวจ" บนเว็บแล้ว — กรุณายืนยัน/แก้ไขก่อนบันทึกลงชีต',
        ].join('\n');

    if (job.processingMessageId) { try { await bot.deleteMessage(job.chatId, job.processingMessageId); } catch (_) {} }
    try { await bot.sendMessage(job.chatId, msg, { reply_to_message_id: job.messageId }); }
    catch (_) { await editOrSend(bot, job, msg); }
    return;
  }

  let driveLink = job.driveLink || null;
  if (!driveLink) {
    await updateQueueStep(task, 'upload_drive');
    updateJob(jobId, { step: 'upload_drive' });
    await editOrSend(bot, job, '📤 กำลังอัปโหลดรูปไปยัง Google Drive...');
    const fileName = `slip_${jobId}_${fileHash}.jpg`;
    driveLink = await retryOperation('Drive upload', 2, () => uploadSlip(authClient, downloadPath, fileName, {
      last4: parsedData.last4,
      date: parsedData.date,
    }));
    updateJob(jobId, { driveLink, step: 'drive_done' });
  }

  await updateQueueStep(task, 'save_sheet');
  updateJob(jobId, { step: 'save_sheet' });
  await editOrSend(bot, job, '📝 กำลังบันทึกลง Google Sheets...');

  dupCheck = await retryOperation('Duplicate check', 4, () => checkDuplicate(authClient, spreadsheetId, fileHash, parsedData.last4));
  if (dupCheck.duplicate) {
    cleanup(downloadPath);
    const origDup = findJobByHash(fileHash, { excludeId: jobId, statuses: ['done', 'duplicate'] });
    markDone(jobId, {
      status: 'duplicate', step: 'duplicate', duplicateTabName: dupCheck.tabName,
      duplicateOfJobId: origDup ? origDup.id : '',
      duplicateOfDriveLink: origDup ? origDup.driveLink : '',
      duplicateOfDate: origDup && origDup.parsedData ? origDup.parsedData.date : '',
    });
    const origNote = origDup ? `\n📎 ซ้ำกับใบที่เคยส่ง (งาน ${origDup.id})` : '';
    await editOrSend(bot, job, `⚠️ งาน ${jobId} พบว่าบันทึกไว้แล้วในแท็บ "${dupCheck.tabName}"${origNote}`);
    return;
  }

  const tabName = await retryOperation('Create/Get tab', 4, () => getOrCreateAccountTab(authClient, spreadsheetId, parsedData.last4, parsedData.bank));
  const finalData = {
    ...parsedData,
    senderTG: job.senderTG || '-',
    driveLink: driveLink || 'อัปโหลดไม่สำเร็จ',
    hash: fileHash,
  };

  await retryOperation('Sheet save', 4, () => appendSlip(authClient, spreadsheetId, parsedData.last4, finalData));
  mirrorSlip(finalData); // สำรองลง SQLite ในเครื่อง (best-effort)
  markDone(jobId, { step: 'done', tabName, last4: parsedData.last4 });
  await updateQueueStep(task, 'done');
  cleanup(downloadPath);

  const amountStr = Number(parsedData.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const feeStr = Number(parsedData.fee || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const successText = [
    '✅ บันทึกสำเร็จ!',
    `🆔 Job: ${jobId}`,
    `🔢 บัญชี: ****${parsedData.last4} (${parsedData.bank})`,
    `💰 ยอด: ${amountStr} บาท`,
    `💸 ค่าธรรมเนียม: ${feeStr} บาท`,
    `🔄 ประเภท: ${parsedData.tx_type}`,
    `📅 วันที่: ${parsedData.date}`,
    `📂 แท็บ: "${tabName}"`,
  ].join('\n');

  // ตอบกลับ (reply) ที่รูปสลิปต้นทางโดยตรง เพื่อให้รู้ว่าผลลัพธ์เป็นของสลิปใบไหน
  // และลบข้อความสถานะระหว่างประมวลผลทิ้ง
  if (job.processingMessageId) {
    try { await bot.deleteMessage(job.chatId, job.processingMessageId); } catch (_) {}
  }
  try {
    await bot.sendMessage(job.chatId, successText, { reply_to_message_id: job.messageId });
  } catch (_) {
    await editOrSend(bot, job, successText);
  }
  } catch (error) {
    const latest = getJob(jobId) || job || {};
    markFailed(jobId, error, { step: latest.step || task.step || 'failed' });
    await updateQueueStep(task, 'failed');
    await notifyJob(bot, jobId, `❌ งาน ${jobId} ล้มเหลว: ${error.message || error}`);
    throw error;
  } finally {
    releaseLease(jobId, queueLeaseOwner);
  }
}

function persistSlipFile(tempPath, jobId) {
  const dir = path.join(process.cwd(), 'data', 'slips');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${jobId}.jpg`);
  if (fs.existsSync(target)) fs.unlinkSync(target);
  fs.renameSync(tempPath, target);
  return target;
}

async function editOrSend(bot, job, message) {
  try {
    if (job.processingMessageId) {
      await bot.editMessageText(message, { chat_id: job.chatId, message_id: job.processingMessageId });
      return;
    }
  } catch (_) {}
  try {
    const sent = await bot.sendMessage(job.chatId, message);
    if (sent?.message_id) updateJob(job.id, { processingMessageId: sent.message_id });
  } catch (e) {
    console.error('Failed to notify Telegram:', e.message);
  }
}

async function notifyJob(bot, jobId, message) {
  const job = getJob(jobId);
  if (!job) return;
  await editOrSend(bot, job, message);
}

async function recordUsage(authClient, tokens, attempts = null, status = '') {
  try {
    const usageFile = path.join(process.cwd(), 'ai_usage.json');
    let currentUsage = { totalTokens: 0, count: 0 };
    try {
      await fs.promises.access(usageFile);
      currentUsage = JSON.parse(await fs.promises.readFile(usageFile, 'utf-8'));
    } catch (_) {}
    currentUsage.totalTokens += Number(tokens || 0);
    currentUsage.count += 1;
    await fs.promises.writeFile(usageFile, JSON.stringify(currentUsage, null, 2));
    // มี attempts → บันทึกสถิติแยกค่าย (token/ครั้ง/สำเร็จ/error); ไม่มีก็ลงรวมแบบเดิม
    if (Array.isArray(attempts) && attempts.length) {
      await recordProviderUsage(authClient, spreadsheetId, attempts, true, status);
    } else {
      await recordTokenUsage(authClient, spreadsheetId, Number(tokens || 0), 1);
    }
  } catch (e) {
    console.error('Error saving usage:', e.message);
  }
}

function cleanup(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) { /* ignore */ }
}

async function updateQueueStep(task, step) {
  task.step = step;
  await slipQueue.publish(`step:${step}`);
}

function isQuotaError(e) {
  return e?.code === 429 || e?.response?.status === 429 ||
    /quota exceeded|rate.?limit|too many requests/i.test(e?.message || '');
}

async function retryOperation(label, maxAttempts, operation) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts) break;
      // quota (429) เป็นลิมิต "ต่อนาที" → ต้องรอนานกว่า error ทั่วไป
      const wait = isQuotaError(e) ? Math.min(65000, 20000 * attempt) : 1500 * attempt;
      console.warn(`${label} failed (${isQuotaError(e) ? 'quota/429' : 'error'}), retry ${attempt + 1}/${maxAttempts} in ${wait}ms: ${e.message}`);
      await delay(wait);
    }
  }
  throw lastError;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncLocalUsageToSheet(authClient, targetSpreadsheetId) {
  try {
    const usageFile = path.join(process.cwd(), 'ai_usage.json');
    if (!fs.existsSync(usageFile)) return;
    const data = JSON.parse(await fs.promises.readFile(usageFile, 'utf-8'));
    await setTokenUsage(authClient, targetSpreadsheetId, data.totalTokens || 0, data.count || 0);
  } catch (e) {
    console.error('Error syncing usage to sheet:', e.message);
  }
}

module.exports = { setupBot, getSpreadsheetId, enqueueSlipJob };
