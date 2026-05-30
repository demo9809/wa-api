'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const whatsapp = require('./client');
const apiRoutes = require('./api');

const PORT = parseInt(process.env.PORT || '3001', 10);

// ── Ensure required directories exist ─────────────────────────────────────
const dirs = [
  path.join(__dirname, '..', 'logs'),
  path.join(__dirname, '..', 'sessions'),
  path.join(__dirname, '..', 'data'),
];

dirs.forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created directory: ${dir}`);
  }
});

// ── Express App ────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy (for rate limiting behind Nginx)
app.set('trust proxy', 1);

// ── CORS — allow PHP admin panel and localhost dev ─────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = ['http://localhost:8080', 'https://illoo.store', 'https://wa-api.illoo.store'];
  if (allowed.includes(origin) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health check (no auth) ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    pid: process.pid,
    memory: {
      rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(mem.external / 1024 / 1024)}MB`,
      raw: mem,
    },
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
    aiSupport: true,
    deployedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
});

// ── API routes ─────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.path}`,
  });
});

// ── Global error handler ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error(`Unhandled route error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { error: err.message }),
  });
});

// ── Start server ───────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`illoo WhatsApp Service listening on 0.0.0.0:${PORT}`);
  logger.info(`Health check: http://127.0.0.1:${PORT}/health`);
  logger.info(`API base: http://127.0.0.1:${PORT}/api`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// ── Initialize WhatsApp ────────────────────────────────────────────────────
whatsapp.initialize().catch((err) => {
  logger.error(`WhatsApp initialization error: ${err.message}`);
  // Don't exit — scheduleReconnect handles retries
});

// ── Process-level error handling ───────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`, { stack: err.stack });
  // Log and continue — don't crash the service
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled Promise Rejection: ${msg}`);
  // Log and continue — don't crash the service
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down gracefully');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

module.exports = app;
