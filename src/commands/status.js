const fs = require('fs');
const path = require('path');
const slipQueue = require('../queue');
const { getSystemState, formatDashboardSystemState } = require('../sheets');
const { listFailedJobs, resetFailedJob, getJob } = require('../persistent_queue');

function checkAccess(msg) {
  const allowed = process.env.ALLOWED_CHAT_IDS;
  if (!allowed) return true;
  const ids = allowed.split(',').map(id => id.trim());
  return ids.includes(msg.chat.id.toString());
}

function setupStatusCommand(bot, authClient, getSpreadsheetId, enqueueJob) {
  bot.onText(/\/status|\/tokens|📊 สถานะระบบ|📋 Token Usage/, async (msg) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const status = await loadStatus(authClient, getSpreadsheetId);

    const reply = [
      'สถานะระบบ Slip Bot',
      `Bot: ${status.botOnline ? 'ออนไลน์' : 'ไม่พบ heartbeat ล่าสุด'}`,
      status.botLastSeen ? `Heartbeat ล่าสุด: ${formatDateTime(status.botLastSeen)} (${formatAge(status.botLastSeenAgeMs)})` : 'Heartbeat ล่าสุด: ยังไม่มีข้อมูล',
      `เครื่อง: ${status.botHost || '-'} / PID: ${status.botPid || '-'}`,
      `OCR สำเร็จ: ${status.usage.count.toLocaleString('en-US')} ใบ`,
      `Token Gemini: ${status.usage.totalTokens.toLocaleString('en-US')} Tokens`,
      '',
      formatQueueLines(status.queue).join('\n'),
    ].join('\n');

    bot.sendMessage(chatId, reply);
  });

  bot.onText(/\/queue|⏱️ ดูคิว OCR/, async (msg) => {
    if (!checkAccess(msg)) return;
    const chatId = msg.chat.id;
    const status = await loadStatus(authClient, getSpreadsheetId);
    bot.sendMessage(chatId, ['สถานะคิว OCR', ...formatQueueLines(status.queue)].join('\n'));
  });

  bot.onText(/\/failed|⚠️ งานล้มเหลว/, async (msg) => {
    if (!checkAccess(msg)) return;
    const failed = listFailedJobs().slice(-10).reverse();
    if (failed.length === 0) {
      return bot.sendMessage(msg.chat.id, 'ไม่มีงานสลิปที่ล้มเหลว');
    }

    const lines = ['งานสลิปที่ล้มเหลวล่าสุด'];
    failed.forEach(job => {
      lines.push([
        `ID: ${job.id}`,
        `Step: ${job.step || '-'}`,
        `Error: ${job.lastError || '-'}`,
        `Updated: ${formatDateTime(job.updatedAt)}`,
      ].join('\n'));
    });
    bot.sendMessage(msg.chat.id, lines.join('\n\n'));
  });

  bot.onText(/(?:\/retry_failed(?:\s+(.+))?|🔁 Retry Failed All)/, async (msg, match) => {
    if (!checkAccess(msg)) return;
    const target = msg.text === '🔁 Retry Failed All' ? 'all' : String(match?.[1] || '').trim();
    if (!target) {
      return bot.sendMessage(msg.chat.id, 'ใช้รูปแบบ /retry_failed <job_id|all>');
    }

    if (target.toLowerCase() === 'all') {
      const failed = listFailedJobs();
      for (const job of failed) {
        resetFailedJob(job.id);
        if (enqueueJob) await enqueueJob(job.id);
      }
      return bot.sendMessage(msg.chat.id, `สั่ง retry งาน failed แล้ว ${failed.length} งาน`);
    }

    const job = getJob(target);
    if (!job) return bot.sendMessage(msg.chat.id, `ไม่พบ job: ${target}`);
    if (job.status !== 'failed') return bot.sendMessage(msg.chat.id, `job ${target} ไม่ได้อยู่สถานะ failed`);
    resetFailedJob(target);
    if (enqueueJob) await enqueueJob(target);
    bot.sendMessage(msg.chat.id, `สั่ง retry job ${target} แล้ว`);
  });
}

async function loadStatus(authClient, getSpreadsheetId) {
  const spreadsheetId = typeof getSpreadsheetId === 'function' ? getSpreadsheetId() : null;
  if (authClient && spreadsheetId) {
    try {
      return formatDashboardSystemState(await getSystemState(authClient, spreadsheetId));
    } catch (e) {
      console.error('Error reading system status:', e.message);
    }
  }

  const localUsage = readLocalUsage();
  const localQueue = slipQueue.getState();
  return {
    botOnline: true,
    botLastSeen: new Date().toISOString(),
    botLastSeenAgeMs: 0,
    botHost: require('os').hostname(),
    botPid: process.pid,
    usage: localUsage,
    queue: {
      waiting: localQueue.waiting,
      active: localQueue.active,
      concurrency: localQueue.concurrency,
      currentTaskId: localQueue.currentTaskId,
      currentStep: localQueue.currentStep,
      processedCount: localQueue.processedCount,
      failedCount: localQueue.failedCount,
      lastSuccessAt: localQueue.lastSuccessAt,
      lastErrorAt: localQueue.lastErrorAt,
      lastError: localQueue.lastError,
      lastRetryAt: localQueue.lastRetryAt,
      lastRetry: localQueue.lastRetry,
    },
  };
}

function readLocalUsage() {
  try {
    const usageFile = path.join(process.cwd(), 'ai_usage.json');
    if (!fs.existsSync(usageFile)) return { totalTokens: 0, count: 0 };
    const data = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
    return {
      totalTokens: Number(data.totalTokens || 0),
      count: Number(data.count || 0),
    };
  } catch (e) {
    console.error('Error reading usage:', e.message);
    return { totalTokens: 0, count: 0 };
  }
}

function formatQueueLines(queue = {}) {
  const lines = [
    `คิวรอ: ${Number(queue.waiting || 0)} ใบ`,
    `กำลังประมวลผล: ${Number(queue.active || 0)} ใบ`,
    `จำกัด OCR พร้อมกัน: ${Number(queue.concurrency || 1)} ใบ`,
    `งานค้างถาวร: ${Number(queue.persistedRecoverable || 0)} ใบ`,
    `งาน failed ถาวร: ${Number(queue.persistedFailed || 0)} ใบ`,
    `ขั้นตอนปัจจุบัน: ${queue.currentStep || '-'}`,
    `สำเร็จสะสม: ${Number(queue.processedCount || 0).toLocaleString('en-US')} ใบ`,
    `ล้มเหลวสะสม: ${Number(queue.failedCount || 0).toLocaleString('en-US')} ใบ`,
  ];

  if (queue.lastRetry) {
    lines.push(`Retry ล่าสุด: ${queue.lastRetry}`);
  }
  if (queue.lastError) {
    lines.push(`Error ล่าสุด: ${queue.lastError}`);
  }
  if (queue.lastSuccessAt) {
    lines.push(`สำเร็จล่าสุด: ${formatDateTime(queue.lastSuccessAt)}`);
  }

  return lines;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
}

function formatAge(ms) {
  if (ms === null || ms === undefined || ms < 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} วินาทีที่แล้ว`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`;
  return `${Math.round(minutes / 60)} ชั่วโมงที่แล้ว`;
}

module.exports = { setupStatusCommand };
