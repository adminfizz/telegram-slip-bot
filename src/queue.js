class SlipQueue {
  constructor() {
    this.queue = [];
    this.activeCount = 0;
    this.concurrency = 1; // จับทีละใบ (กัน Google API race / สร้างแท็บซ้ำ)
    this.nextId = 1;
    this.currentTask = null;
    this.processedCount = 0;
    this.failedCount = 0;
    this.lastSuccess = null;
    this.lastError = null;
    this.lastRetry = null;
    this.reporter = null;
  }

  add(task) {
    task.id = task.id || this.nextId++;
    task.createdAt = task.createdAt || new Date().toISOString();
    this.queue.push(task);
    this.publish('queued');
    this.processNext();
    return task.id;
  }

  setReporter(reporter) {
    this.reporter = reporter;
    this.publish('reporter_ready');
  }

  getState() {
    return {
      waiting: this.queue.length,
      active: this.activeCount,
      concurrency: this.concurrency,
      currentTaskId: this.currentTask?.id || '',
      currentChatId: this.currentTask?.chatId || '',
      currentStep: this.currentTask?.step || '',
      currentStartedAt: this.currentTask?.startedAt || '',
      processedCount: this.processedCount,
      failedCount: this.failedCount,
      lastSuccessAt: this.lastSuccess?.at || '',
      lastSuccessTaskId: this.lastSuccess?.taskId || '',
      lastErrorAt: this.lastError?.at || '',
      lastError: this.lastError?.message || '',
      lastErrorTaskId: this.lastError?.taskId || '',
      lastRetryAt: this.lastRetry?.at || '',
      lastRetry: this.lastRetry?.message || '',
      lastRetryTaskId: this.lastRetry?.taskId || '',
      updatedAt: new Date().toISOString(),
    };
  }

  async publish(event = 'update') {
    if (!this.reporter) return;
    try {
      await this.reporter({ event, ...this.getState() });
    } catch (e) {
      console.error('[Queue] Reporter failed:', e.message);
    }
  }

  async processNext() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
    
    this.activeCount++;

    const task = this.queue.shift();
    task.startedAt = new Date().toISOString();
    task.step = 'started';
    this.currentTask = task;
    await this.publish('started');

    try {
      await task.execute();
      this.processedCount++;
      this.lastSuccess = { at: new Date().toISOString(), taskId: task.id };
      await this.publish('done');
    } catch (e) {
      task.retries = (task.retries || 0) + 1;
      const maxRetries = Number.isInteger(task.maxRetries) ? task.maxRetries : 0;
      if (task.retries <= maxRetries) {
        this.lastRetry = { at: new Date().toISOString(), taskId: task.id, message: e.message };
        console.log(`[Queue] Task failed, retrying (${task.retries}/${maxRetries})... Error: ${e.message}`);
        await this.publish('retry');
        setTimeout(() => {
          this.queue.unshift(task); // Put back at the front of the queue
          this.processNext(); // Non-blocking trigger
        }, 3000);
      } else {
        this.failedCount++;
        this.lastError = { at: new Date().toISOString(), taskId: task.id, message: e.message };
        console.error('[Queue] Task failed permanently:', e.message);
        await this.publish('failed');
        if (task.onFail) {
          try { await task.onFail(e); } catch (_) {}
        }
      }
    }

    this.activeCount--;
    this.currentTask = null;
    await this.publish('idle');
    this.processNext(); // Process next item
  }
}

module.exports = new SlipQueue();
