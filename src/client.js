'use strict';

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const https = require('https');
const http  = require('http');
const logger = require('./logger');

const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || '10000', 10);
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '10', 10);

let clientInstance = null;
let isReady = false;
let qrCode = null;
let connectionStatus = 'disconnected';
let reconnectTimer = null;
let reconnectAttempts = 0;

function createClient() {
  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  };

  // Use system Chrome if path provided (Railway/VPS environments)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '..', 'sessions'),
    }),
    puppeteer: puppeteerConfig,
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1015898620-alpha.html',
    },
  });
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error(
      `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Manual intervention required.`
    );
    connectionStatus = 'failed';
    return;
  }

  reconnectAttempts++;
  // Exponential backoff capped at 60 seconds
  const delay = Math.min(RECONNECT_DELAY_MS * reconnectAttempts, 60000);

  logger.info(`Scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initialize();
  }, delay);
}

async function initialize() {
  // Clean up existing client before creating a new one
  if (clientInstance) {
    try {
      await clientInstance.destroy();
      logger.info('Previous WhatsApp client destroyed');
    } catch (err) {
      logger.warn(`Error destroying previous client: ${err.message}`);
    }
    clientInstance = null;
    isReady = false;
    qrCode = null;
  }

  logger.info('Initializing WhatsApp client...');
  connectionStatus = 'initializing';

  const client = createClient();
  clientInstance = client;

  // ── QR Code ────────────────────────────────────────────────────────────────
  client.on('qr', (qr) => {
    qrCode = qr;
    connectionStatus = 'qr_pending';
    logger.info('QR code generated. Scan with WhatsApp to authenticate.');
    qrcode.generate(qr, { small: true });
  });

  // ── Ready ──────────────────────────────────────────────────────────────────
  client.on('ready', () => {
    isReady = true;
    qrCode = null;
    reconnectAttempts = 0;
    connectionStatus = 'connected';

    const phone = client.info?.wid?.user || 'unknown';
    logger.info(`WhatsApp client ready. Connected as: ${phone}`);

    // Register client with the queue
    const queue = require('./queue');
    queue.setClient({
      isReady: true,
      sendMessage: (phone, message) => client.sendMessage(phone, message),
      sendPresenceAvailable: sendPresenceAvailable,
    });

    // Start processing any queued messages
    queue._process();
  });

  // ── Authenticated ──────────────────────────────────────────────────────────
  client.on('authenticated', () => {
    connectionStatus = 'authenticated';
    logger.info('WhatsApp client authenticated successfully');
  });

  // ── Auth Failure ───────────────────────────────────────────────────────────
  client.on('auth_failure', (message) => {
    connectionStatus = 'auth_failed';
    isReady = false;
    logger.error(`WhatsApp authentication failed: ${message}`);
    scheduleReconnect();
  });

  // ── Disconnected ───────────────────────────────────────────────────────────
  client.on('disconnected', (reason) => {
    isReady = false;
    connectionStatus = 'disconnected';
    logger.warn(`WhatsApp client disconnected: ${reason}`);

    // Nullify queue's client reference
    try {
      const queue = require('./queue');
      queue.setClient(null);
    } catch (_err) {
      // ignore
    }

    scheduleReconnect();
  });

  // ── Message Create (optional logging) ─────────────────────────────────────
  client.on('message_create', (msg) => {
    if (msg.fromMe) {
      logger.debug(`Message sent to ${msg.to}: ${msg.body.substring(0, 50)}...`);
    }
  });

  // ── Incoming messages → CRM lead capture ──────────────────────────────────
  client.on('message', async (msg) => {
    if (msg.fromMe) return; // ignore our own outgoing messages
    try {
      const raw   = msg.from || '';               // e.g. 919876543210@c.us
      const phone = raw.replace('@c.us', '').replace('@g.us', '');
      if (!phone || raw.includes('@g.us')) return; // skip group messages

      const contact = msg._data?.notifyName || '';
      const body    = typeof msg.body === 'string' ? msg.body.substring(0, 500) : '';

      logger.info(`Incoming message from ${phone} (${contact || 'unknown'}): "${body.substring(0, 60)}"`);

      const incomingUrl = process.env.WA_INCOMING_URL || '';
      if (!incomingUrl) {
        logger.warn('WA_INCOMING_URL not set — skipping lead capture and auto-reply');
        return;
      }

      const result = await notifyIncomingLead({ phone, name: contact, message: body });

      logger.info(`notifyIncomingLead result for ${phone}: is_new=${result?.is_new} auto_reply=${!!result?.auto_reply} keyword_reply=${!!result?.keyword_reply}`);

      // Send welcome auto-reply to first-time contacts after 2-second delay
      if (result && result.is_new && result.auto_reply) {
        setTimeout(() => {
          try {
            const queue = require('./queue');
            queue.add(phone, result.auto_reply, { priority: 5, orderId: 'AUTO_REPLY' });
            logger.info(`Auto-reply queued for new contact ${phone}`);
          } catch (qErr) {
            logger.warn(`Auto-reply queue error: ${qErr.message}`);
          }
        }, 2000);
      } else if (result && result.is_new && !result.auto_reply) {
        logger.info(`New lead ${phone} — auto-reply disabled or not configured in settings`);
      }

      // Send keyword-based reply to any contact whose message matches a rule
      if (result && result.keyword_reply) {
        const delay = (result.is_new && result.auto_reply) ? 5000 : 1500;
        setTimeout(() => {
          try {
            const queue = require('./queue');
            queue.add(phone, result.keyword_reply, { priority: 5, orderId: 'KEYWORD_REPLY' });
            logger.info(`Keyword auto-reply queued for ${phone}`);
          } catch (qErr) {
            logger.warn(`Keyword auto-reply queue error: ${qErr.message}`);
          }
        }, delay);
      }
    } catch (err) {
      logger.warn(`Incoming message handler error: ${err.message}`);
    }
  });

  try {
    await client.initialize();
  } catch (err) {
    logger.error(`Failed to initialize WhatsApp client: ${err.message}`);
    connectionStatus = 'error';
    scheduleReconnect();
  }
}

/**
 * Send a WhatsApp message.
 * @param {string} phone - Formatted phone (e.g. 919876543210@c.us)
 * @param {string} message - Message text
 */
async function sendMessage(phone, message) {
  if (!isReady || !clientInstance) {
    throw new Error('WhatsApp client is not ready');
  }
  return clientInstance.sendMessage(phone, message);
}

/**
 * Simulate typing presence before sending a message.
 * Silently ignores errors (non-critical).
 * @param {string} phone - Formatted phone number
 */
async function sendPresenceAvailable(phone) {
  try {
    if (!isReady || !clientInstance) return;
    const chat = await clientInstance.getChatById(phone);
    if (chat) {
      await chat.sendStateTyping();
    }
  } catch (_err) {
    // Non-critical — ignore silently
  }
}

/**
 * POST to the PHP wa-incoming endpoint to upsert a lead.
 * Returns parsed JSON response (or null on error).
 */
function notifyIncomingLead({ phone, name, message }) {
  const incomingUrl = process.env.WA_INCOMING_URL || '';
  if (!incomingUrl) return Promise.resolve(null);

  const apiKey = process.env.API_SECRET_KEY || '';
  const payload = JSON.stringify({ phone, name, message });

  return new Promise((resolve) => {
    const mod = incomingUrl.startsWith('https') ? https : http;
    const url = new URL(incomingUrl);

    const req = mod.request({
      hostname : url.hostname,
      port     : url.port || (incomingUrl.startsWith('https') ? 443 : 80),
      path     : url.pathname + url.search,
      method   : 'POST',
      headers  : {
        'Content-Type'  : 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key'     : apiKey,
      },
    }, (res) => {
      logger.debug(`wa-incoming response: ${res.statusCode} for ${phone}`);
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });

    req.on('error', (err) => {
      logger.warn(`wa-incoming POST failed: ${err.message}`);
      resolve(null);
    });

    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function getStatus() {
  return {
    status: connectionStatus,
    isReady,
    qrAvailable: !!qrCode,
    qrCode: qrCode,
    reconnectAttempts,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    phone: clientInstance?.info?.wid?.user || null,
  };
}

function getClient() {
  return clientInstance;
}

module.exports = { initialize, getStatus, sendMessage, sendPresenceAvailable, getClient };
