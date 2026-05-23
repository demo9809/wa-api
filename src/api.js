'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const https = require('https');
const http  = require('http');
const { apiAuth } = require('./auth');
const { buildMessage, TEMPLATES } = require('./templates');
const logger = require('./logger');

const QRCode = require('qrcode');
const { MessageMedia } = require('whatsapp-web.js');
const whatsapp = require('./client');
const queue = require('./queue');

const router = express.Router();

// ── Security middleware ────────────────────────────────────────────────────
router.use(helmet());

// Rate limiting: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests — please slow down.' },
});
router.use(limiter);

// API key auth on all routes
router.use(apiAuth);

// ── Helper ─────────────────────────────────────────────────────────────────
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ── GET /status ────────────────────────────────────────────────────────────
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const waStatus = whatsapp.getStatus();
    const qStatus = queue.getStatus();

    res.json({
      success: true,
      whatsapp: waStatus,
      queue: qStatus,
      timestamp: new Date().toISOString(),
    });
  })
);

// ── POST /send ─────────────────────────────────────────────────────────────
router.post(
  '/send',
  asyncHandler(async (req, res) => {
    const { phone, message, priority, orderId } = req.body;

    if (!phone || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phone and message',
      });
    }

    const id = queue.add(phone, message, { priority: priority || 0, orderId: orderId || '' });

    logger.info(`API /send queued id=${id} phone=${phone} orderId=${orderId}`);

    res.json({ success: true, queued: true, id });
  })
);

// ── POST /send-template ───────────────────────────────────────────────────
router.post(
  '/send-template',
  asyncHandler(async (req, res) => {
    const { phone, templateId, vars, priority, orderId, message: preRendered } = req.body;

    if (!phone || !templateId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phone and templateId',
      });
    }

    let message;
    if (preRendered && typeof preRendered === 'string' && preRendered.trim()) {
      // Use the pre-rendered message from PHP (admin-edited templates take effect)
      message = preRendered.trim();
    } else {
      try {
        message = buildMessage(templateId, vars || {});
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
    }

    const id = queue.add(phone, message, {
      priority: priority || 0,
      orderId: orderId || '',
      templateId,
    });

    logger.info(`API /send-template queued id=${id} template=${templateId} phone=${phone}`);

    res.json({
      success: true,
      queued: true,
      id,
      templateId,
      preview: message.substring(0, 100),
    });
  })
);

// ── GET /templates ─────────────────────────────────────────────────────────
router.get(
  '/templates',
  asyncHandler(async (req, res) => {
    const list = Object.entries(TEMPLATES).map(([id, tpl]) => ({
      id,
      name: tpl.name,
    }));

    res.json({ success: true, templates: list });
  })
);

// ── GET /queue ─────────────────────────────────────────────────────────────
router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      status: queue.getStatus(),
      queue: queue.getQueue(),
    });
  })
);

// ── DELETE /queue/:id ──────────────────────────────────────────────────────
router.delete(
  '/queue/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const removed = queue.remove(id);

    if (!removed) {
      return res.status(404).json({
        success: false,
        message: `Message id=${id} not found in queue`,
      });
    }

    res.json({ success: true, removed: true, id });
  })
);

// ── POST /test ─────────────────────────────────────────────────────────────
router.post(
  '/test',
  asyncHandler(async (req, res) => {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: phone',
      });
    }

    // IST timestamp
    const now = new Date();
    const istTime = now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: true,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const message =
      `🔧 *illoo WhatsApp Service — Test Message*\n\n` +
      `✅ Connection is working!\n\n` +
      `🕐 Sent at: ${istTime} IST\n` +
      `📊 Queue status: ${queue.getStatus().todayCount}/${queue.getStatus().dailyLimit} messages today\n\n` +
      `This is an automated test from the illoo notification service.`;

    const id = queue.add(phone, message, { priority: 10, orderId: 'TEST' });

    logger.info(`API /test message queued id=${id} to ${phone}`);

    res.json({ success: true, queued: true, id, message: 'Test message queued with priority 10' });
  })
);

// ── GET /qr ────────────────────────────────────────────────────────────────
router.get(
  '/qr',
  asyncHandler(async (req, res) => {
    const status = whatsapp.getStatus();

    if (!status.qrAvailable || !status.qrCode) {
      return res.status(404).json({
        success: false,
        message: status.isReady
          ? 'Already connected — no QR code needed'
          : 'No QR code available. Client may not have started yet.',
        whatsappStatus: status.status,
      });
    }

    res.json({
      success: true,
      qrCode: status.qrCode,
      hint: 'Scan this QR code in WhatsApp → Linked Devices → Link a Device',
    });
  })
);

// ── GET /qr-image ──────────────────────────────────────────────────────────
router.get(
  '/qr-image',
  asyncHandler(async (req, res) => {
    const status = whatsapp.getStatus();

    if (!status.qrAvailable || !status.qrCode) {
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>${status.isReady ? '✅ WhatsApp Already Connected' : '⏳ QR Not Ready Yet'}</h2>
        <p>${status.isReady ? 'No QR needed — WhatsApp is connected.' : 'Please wait a few seconds and refresh.'}</p>
        <script>if(!${status.isReady})setTimeout(()=>location.reload(),3000)</script>
      </body></html>`);
    }

    const imgSrc = await QRCode.toDataURL(status.qrCode, { width: 300, margin: 2 });

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f4f8">
      <h2>📱 Scan with WhatsApp</h2>
      <p>Go to <b>WhatsApp → Linked Devices → Link a Device</b> and scan this QR code</p>
      <img src="${imgSrc}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:12px;margin:20px auto;display:block">
      <p style="color:#666;font-size:14px">QR expires in ~20 seconds. Page auto-refreshes.</p>
      <script>setTimeout(()=>location.reload(),18000)</script>
    </body></html>`);
  })
);

// ── GET /contacts ──────────────────────────────────────────────────────────
// Returns all recent 1-on-1 chat participants (skips groups, skips our own number)
router.get(
  '/contacts',
  asyncHandler(async (req, res) => {
    const status = whatsapp.getStatus();
    if (!status.isReady) {
      return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
    }

    // Access the underlying WA client to list chats
    const { getClient } = require('./client');
    const client = getClient();
    if (!client) {
      return res.status(503).json({ success: false, message: 'Client not available' });
    }

    const chats = await client.getChats();
    const contacts = [];
    const myNumber = client.info?.wid?.user || '';

    for (const chat of chats) {
      if (chat.isGroup) continue;
      const phone = chat.id?.user || '';
      if (!phone || phone === myNumber) continue;
      // Only include chats that have had messages
      if (!chat.lastMessage) continue;

      const name = chat.name || chat.pushname || '';
      const lastMsg = chat.lastMessage?.body || '';
      const lastTs  = chat.lastMessage?.timestamp || null; // Unix seconds
      contacts.push({
        phone,
        name,
        lastMessage    : lastMsg.substring(0, 200),
        lastMessageTime: lastTs,
      });
    }

    logger.info(`API /contacts returning ${contacts.length} contacts`);
    res.json({ success: true, contacts });
  })
);

// ── POST /bulk-send ────────────────────────────────────────────────────────
// Body: { phones: ["91...", ...], message: "...", refId: "BCAST-1" }
router.post(
  '/bulk-send',
  asyncHandler(async (req, res) => {
    const { phones, message, refId } = req.body;

    if (!Array.isArray(phones) || phones.length === 0 || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phones (array) and message',
      });
    }

    if (phones.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 500 recipients per request',
      });
    }

    let queued = 0;
    for (const phone of phones) {
      const id = queue.add(phone, message, { priority: 1, orderId: refId || 'BULK' });
      if (id) queued++;
    }

    logger.info(`API /bulk-send queued ${queued}/${phones.length} messages refId=${refId}`);

    res.json({ success: true, queued, total: phones.length });
  })
);

// ── POST /send-image ───────────────────────────────────────────────────────
// Body: { phone, imageUrl, caption }
router.post(
  '/send-image',
  asyncHandler(async (req, res) => {
    const { phone, imageUrl, caption } = req.body;

    if (!phone || !imageUrl) {
      return res.status(400).json({ success: false, message: 'Missing phone or imageUrl' });
    }

    const status = whatsapp.getStatus();
    if (!status.isReady) {
      return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
    }

    const { getClient } = require('./client');
    const client = getClient();
    if (!client) return res.status(503).json({ success: false, message: 'Client not available' });

    let media;
    try {
      media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
    } catch (dlErr) {
      return res.status(422).json({ success: false, message: `Could not download image: ${dlErr.message}` });
    }

    const formattedPhone = queue._formatPhone ? queue._formatPhone(phone) : phone + '@c.us';

    try {
      await client.sendMessage(formattedPhone, media, { caption: caption || '' });
      logger.info(`Image sent to ${phone}`);
      res.json({ success: true, imageSent: true });
    } catch (err) {
      logger.error(`Failed to send image to ${phone}: ${err.message}`);
      res.status(500).json({ success: false, message: err.message });
    }
  })
);

// ── POST /send-voice ───────────────────────────────────────────────────────
// Body: { phone, voiceUrl, message } — sends voice note + optional text
router.post(
  '/send-voice',
  asyncHandler(async (req, res) => {
    const { phone, voiceUrl, message } = req.body;

    if (!phone || !voiceUrl) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phone and voiceUrl',
      });
    }

    const status = whatsapp.getStatus();
    if (!status.isReady) {
      return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
    }

    const { getClient } = require('./client');
    const client = getClient();
    if (!client) {
      return res.status(503).json({ success: false, message: 'Client not available' });
    }

    // Download audio and create MessageMedia
    let media;
    try {
      media = await MessageMedia.fromUrl(voiceUrl, { unsafeMime: true });
    } catch (dlErr) {
      logger.warn(`Failed to download voice from ${voiceUrl}: ${dlErr.message}`);
      return res.status(422).json({ success: false, message: `Could not download voice file: ${dlErr.message}` });
    }

    const formattedPhone = queue._formatPhone ? queue._formatPhone(phone) : phone + (phone.includes('@') ? '' : '@c.us');

    try {
      // Send voice note first
      await client.sendMessage(formattedPhone, media, { sendAudioAsVoice: true });
      logger.info(`Voice note sent to ${phone}`);

      // Then send text message if provided
      if (message && message.trim()) {
        const msgId = queue.add(phone, message.trim(), { priority: 5, orderId: 'VOICE_MSG' });
        logger.info(`Text follow-up queued id=${msgId} after voice for ${phone}`);
      }

      res.json({ success: true, voiceSent: true });
    } catch (sendErr) {
      logger.error(`Failed to send voice to ${phone}: ${sendErr.message}`);
      res.status(500).json({ success: false, message: sendErr.message });
    }
  })
);

// ── POST /reconnect ────────────────────────────────────────────────────────
router.post(
  '/reconnect',
  asyncHandler(async (req, res) => {
    logger.info('Manual reconnect triggered via API');
    // Reset reconnect attempts for a clean restart
    whatsapp.initialize();
    res.json({ success: true, message: 'Reconnecting WhatsApp client...' });
  })
);

module.exports = router;
