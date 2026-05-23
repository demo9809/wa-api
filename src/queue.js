'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_DAILY_MESSAGES = parseInt(process.env.MAX_DAILY_MESSAGES || '300', 10);
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '4000', 10);
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '10000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const TYPING_MIN_MS = parseInt(process.env.TYPING_MIN_MS || '1000', 10);
const TYPING_MAX_MS = parseInt(process.env.TYPING_MAX_MS || '3000', 10);

class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.todayCount = 0;
    this.lastResetDate = new Date().toDateString();
    this.sent = [];
    this.failed = [];
    this.client = null;
    this.maxDailyMessages = DEFAULT_DAILY_MESSAGES;

    this._ensureDirs();
    this._loadState();
  }

  _ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      logger.info(`Created data directory: ${DATA_DIR}`);
    }
  }

  _loadState() {
    try {
      if (fs.existsSync(QUEUE_FILE)) {
        const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
        const data = JSON.parse(raw);
        // Restore pending items only; reset status so they can be retried
        this.queue = (data.queue || []).map((item) => ({ ...item, status: 'pending' }));
        this.sent = (data.sent || []).slice(-500);
        this.failed = (data.failed || []).slice(-500);
        logger.info(`Loaded ${this.queue.length} pending items from queue file`);
      }
    } catch (err) {
      logger.error(`Failed to load queue file: ${err.message}`);
      this.queue = [];
      this.sent = [];
      this.failed = [];
    }

    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.todayCount = data.todayCount || 0;
        this.lastResetDate = data.lastResetDate || new Date().toDateString();
        this._checkDailyReset();
        logger.info(`Loaded state: todayCount=${this.todayCount}, lastResetDate=${this.lastResetDate}`);
      }
    } catch (err) {
      logger.error(`Failed to load state file: ${err.message}`);
    }
  }

  _saveState() {
    try {
      // Keep only last 500 sent/failed records
      const savedSent = this.sent.slice(-500);
      const savedFailed = this.failed.slice(-500);

      fs.writeFileSync(
        QUEUE_FILE,
        JSON.stringify({ queue: this.queue, sent: savedSent, failed: savedFailed }, null, 2),
        'utf8'
      );

      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({ todayCount: this.todayCount, lastResetDate: this.lastResetDate }, null, 2),
        'utf8'
      );
    } catch (err) {
      logger.error(`Failed to save queue state: ${err.message}`);
    }
  }

  _checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      logger.info(`Daily reset: count was ${this.todayCount}, resetting to 0`);
      this.todayCount = 0;
      this.lastResetDate = today;
    }
  }

  _randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  _formatPhone(phone) {
    const s = String(phone);

    // If already a full WhatsApp ID (contains @lid or @c.us), use as-is
    if (s.includes('@')) {
      return s;
    }

    // Strip everything except digits
    const digits = s.replace(/\D/g, '');

    // If 10 digits (Indian mobile without country code), add '91'
    if (digits.length === 10) {
      return `91${digits}@c.us`;
    }

    // If already has country code (12 digits starting with 91)
    if (digits.length === 12 && digits.startsWith('91')) {
      return `${digits}@c.us`;
    }

    // Otherwise append @c.us as-is
    return `${digits}@c.us`;
  }

  setClient(clientObj) {
    this.client = clientObj;
    logger.info('WhatsApp client set on queue');
  }

  add(phone, message, options = {}) {
    const id = uuidv4();
    const formattedPhone = this._formatPhone(phone);

    const item = {
      id,
      phone: formattedPhone,
      rawPhone: phone,
      message,
      priority: options.priority || 0,
      retries: 0,
      maxRetries: options.maxRetries || MAX_RETRIES,
      status: 'pending',
      templateId: options.templateId || null,
      orderId: options.orderId || null,
      scheduledAt: options.scheduledAt || null,
      createdAt: new Date().toISOString(),
    };

    this.queue.push(item);

    // Sort by priority descending (higher priority = sent first)
    this.queue.sort((a, b) => b.priority - a.priority);

    this._saveState();
    logger.info(`Queued message id=${id} phone=${formattedPhone} priority=${item.priority} orderId=${item.orderId}`);

    // Kick off processing if not already running
    if (!this.processing) {
      this._process();
    }

    return id;
  }

  remove(id) {
    const idx = this.queue.findIndex((item) => item.id === id);
    if (idx === -1) return false;

    this.queue.splice(idx, 1);
    this._saveState();
    logger.info(`Removed queued message id=${id}`);
    return true;
  }

  async _process() {
    if (this.processing) return;
    this.processing = true;

    logger.info('Queue processor started');

    while (this.queue.length > 0) {
      this._checkDailyReset();

      // Check daily limit
      if (this.todayCount >= this.maxDailyMessages) {
        logger.warn(`Daily limit reached (${this.todayCount}/${this.maxDailyMessages}). Queue paused until midnight.`);
        break;
      }

      // Check if client is ready
      if (!this.client || !this.client.isReady) {
        logger.warn('WhatsApp client not ready. Waiting for connection...');
        await this._sleep(10000);
        continue;
      }

      const item = this.queue[0];

      // Check if message is scheduled for the future
      if (item.scheduledAt) {
        const scheduled = new Date(item.scheduledAt).getTime();
        const now = Date.now();
        if (scheduled > now) {
          const waitMs = scheduled - now;
          logger.info(`Message id=${item.id} scheduled for ${item.scheduledAt}, waiting ${Math.round(waitMs / 1000)}s`);
          await this._sleep(Math.min(waitMs, 30000));
          continue;
        }
      }

      item.status = 'sending';

      try {
        // Simulate typing presence
        const typingDelay = this._randomDelay(TYPING_MIN_MS, TYPING_MAX_MS);
        await this.client.sendPresenceAvailable(item.phone);
        await this._sleep(typingDelay);

        // Send the message
        await this.client.sendMessage(item.phone, item.message);

        // Success
        item.status = 'sent';
        item.sentAt = new Date().toISOString();
        this.todayCount++;

        this.queue.shift();
        this.sent.push(item);
        this._saveState();

        logger.info(
          `Sent message id=${item.id} to ${item.rawPhone} orderId=${item.orderId} [${this.todayCount}/${this.maxDailyMessages} today]`
        );
      } catch (err) {
        item.retries++;
        logger.error(`Failed to send message id=${item.id} attempt=${item.retries}/${item.maxRetries}: ${err.message}`);

        if (item.retries >= item.maxRetries) {
          item.status = 'failed';
          item.failedAt = new Date().toISOString();
          item.lastError = err.message;

          this.queue.shift();
          this.failed.push(item);
          this._saveState();

          logger.error(`Message id=${item.id} permanently failed after ${item.retries} attempts`);
        } else {
          // Exponential backoff: 15s, 30s, 60s
          const backoffMs = 15000 * Math.pow(2, item.retries - 1);
          logger.info(`Retrying message id=${item.id} in ${backoffMs / 1000}s (attempt ${item.retries + 1}/${item.maxRetries})`);
          item.status = 'pending';
          await this._sleep(backoffMs);
        }
      }

      // Anti-ban: random delay between messages
      if (this.queue.length > 0) {
        const delay = this._randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
        logger.debug(`Anti-ban delay: ${delay}ms before next message`);
        await this._sleep(delay);
      }
    }

    this.processing = false;
    logger.info('Queue processor finished');
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setDailyLimit(n) {
    const limit = Math.max(10, Math.min(2000, parseInt(n, 10) || DEFAULT_DAILY_MESSAGES));
    this.maxDailyMessages = limit;
    logger.info(`Daily message limit updated to ${limit}`);
    return limit;
  }

  getStatus() {
    this._checkDailyReset();
    return {
      pending: this.queue.length,
      processing: this.processing,
      todayCount: this.todayCount,
      dailyLimit: this.maxDailyMessages,
      remaining: Math.max(0, this.maxDailyMessages - this.todayCount),
      recentSent: this.sent.slice(-10),
      recentFailed: this.failed.slice(-10),
    };
  }

  getQueue() {
    return this.queue.map((item) => ({
      id: item.id,
      rawPhone: item.rawPhone,
      phone: item.phone,
      priority: item.priority,
      retries: item.retries,
      maxRetries: item.maxRetries,
      status: item.status,
      templateId: item.templateId,
      orderId: item.orderId,
      scheduledAt: item.scheduledAt,
      createdAt: item.createdAt,
      messagePreview: item.message ? item.message.substring(0, 80) + '...' : '',
    }));
  }
}

// Export singleton
const queue = new MessageQueue();
module.exports = queue;
