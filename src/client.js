'use strict';

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
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
  return new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '..', 'sessions'),
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process',
      ],
    },
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

module.exports = { initialize, getStatus, sendMessage, sendPresenceAvailable };
