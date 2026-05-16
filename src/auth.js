'use strict';

const crypto = require('crypto');
const logger = require('./logger');

/**
 * API key authentication middleware.
 * Reads key from x-api-key header or ?api_key query param.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function apiAuth(req, res, next) {
  const apiSecretKey = process.env.API_SECRET_KEY;

  if (!apiSecretKey) {
    logger.error('API_SECRET_KEY environment variable is not set');
    return res.status(500).json({
      success: false,
      message: 'Server misconfiguration: API key not set',
    });
  }

  const providedKey = req.headers['x-api-key'] || req.query.api_key;

  if (!providedKey) {
    return res.status(401).json({
      success: false,
      message: 'Missing API key. Provide via x-api-key header or ?api_key query param.',
    });
  }

  // Pad both to the same length for timingSafeEqual
  const secretBuffer = Buffer.from(apiSecretKey, 'utf8');
  const providedBuffer = Buffer.from(providedKey, 'utf8');

  // If lengths differ, we still do a comparison to avoid length-based timing leak
  const safeSecret = Buffer.alloc(Math.max(secretBuffer.length, providedBuffer.length));
  const safeProvided = Buffer.alloc(Math.max(secretBuffer.length, providedBuffer.length));

  secretBuffer.copy(safeSecret);
  providedBuffer.copy(safeProvided);

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(safeSecret, safeProvided);
  } catch (_err) {
    isValid = false;
  }

  // Also check original length equality to ensure exact match
  if (!isValid || secretBuffer.length !== providedBuffer.length) {
    logger.warn(`Unauthorized API access attempt from ${req.ip}`);
    return res.status(403).json({
      success: false,
      message: 'Invalid API key.',
    });
  }

  next();
}

module.exports = { apiAuth };
