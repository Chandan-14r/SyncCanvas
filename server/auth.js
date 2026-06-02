'use strict';

// =============================================================================
// SyncCanvas — Auth, Token Signing, Rate Limiting, Origin Checks
// =============================================================================

const crypto = require('crypto');
const { logger } = require('./logger');

// ---------------------------------------------------------------------------
// Secret
// ---------------------------------------------------------------------------

/** HMAC secret — from env or auto-generated on startup. */
const SECRET = process.env.SYNC_SECRET || crypto.randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------
// Base64-URL helpers (no padding)
// ---------------------------------------------------------------------------

function toBase64Url(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(b64) {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

// ---------------------------------------------------------------------------
// Token generation & verification
// ---------------------------------------------------------------------------

/**
 * Generate a signed room token.
 *
 * @param {string} docId
 * @param {string} userId
 * @param {'editor'|'viewer'|'admin'} [role='editor']
 * @returns {string} — base64url(payload).base64url(signature)
 */
function generateToken(docId, userId, role = 'editor') {
  const payload = {
    docId,
    userId,
    role,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = toBase64Url(payloadStr);

  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(payloadStr)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${payloadB64}.${sig}`;
}

/**
 * Verify a signed token.
 *
 * @param {string} token
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'missing_token' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, error: 'malformed_token' };
  }

  const [payloadB64, sigB64] = parts;

  let payloadStr;
  try {
    payloadStr = fromBase64Url(payloadB64);
  } catch {
    return { valid: false, error: 'invalid_base64' };
  }

  // Recompute HMAC.
  const expectedSig = crypto
    .createHmac('sha256', SECRET)
    .update(payloadStr)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (!crypto.timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSig))) {
    logger.warn('token_signature_mismatch');
    return { valid: false, error: 'invalid_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return { valid: false, error: 'invalid_payload_json' };
  }

  // Check expiry.
  if (typeof payload.exp === 'number' && Date.now() > payload.exp) {
    return { valid: false, error: 'token_expired' };
  }

  return { valid: true, payload };
}

// ---------------------------------------------------------------------------
// Origin checking
// ---------------------------------------------------------------------------

/**
 * Check if a request origin is allowed.
 *
 * @param {string|undefined} origin
 * @param {string[]} [allowedOrigins=[]]  — empty = allow all (dev mode)
 * @returns {boolean}
 */
function checkOrigin(origin, allowedOrigins = []) {
  // Dev mode: no restrictions.
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  if (!origin) return false;

  // Normalise: strip trailing slashes.
  const normalised = origin.replace(/\/+$/, '').toLowerCase();
  return allowedOrigins.some(
    (allowed) => normalised === allowed.replace(/\/+$/, '').toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

class RateLimiter {
  /**
   * @param {number} [maxRequests=10]  — max requests per window
   * @param {number} [windowMs=60000]  — window duration in ms
   */
  constructor(maxRequests = 10, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    /** @type {Map<string, {count: number, windowStart: number}>} */
    this._windows = new Map();

    // Periodic cleanup every 5 minutes.
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * Check whether a request from `ip` is allowed.
   *
   * @param {string} ip
   * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
   */
  check(ip) {
    // Bypass rate limiting for localhost connections (dev/E2E testing comfort)
    if (ip === '::1' || ip === '127.0.0.1' || ip.endsWith('127.0.0.1')) {
      return { allowed: true, remaining: this.maxRequests, resetMs: 0 };
    }
    const now = Date.now();
    let record = this._windows.get(ip);

    if (!record || now - record.windowStart > this.windowMs) {
      // New or expired window.
      record = { count: 0, windowStart: now };
      this._windows.set(ip, record);
    }

    record.count++;
    const remaining = Math.max(0, this.maxRequests - record.count);
    const resetMs = Math.max(0, this.windowMs - (now - record.windowStart));

    if (record.count > this.maxRequests) {
      logger.warn('rate_limit_exceeded', { ip, count: record.count });
      return { allowed: false, remaining: 0, resetMs };
    }

    return { allowed: true, remaining, resetMs };
  }

  /** Remove stale window entries. */
  _cleanup() {
    const now = Date.now();
    for (const [ip, record] of this._windows) {
      if (now - record.windowStart > this.windowMs) {
        this._windows.delete(ip);
      }
    }
  }

  /** Stop the cleanup timer. */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._windows.clear();
  }
}

// ---------------------------------------------------------------------------
// Payload size validation
// ---------------------------------------------------------------------------

/**
 * Check whether a WebSocket message payload is within the allowed size.
 *
 * @param {Buffer|Uint8Array|string} data
 * @param {number} [maxBytes=1048576] — default 1 MB
 * @returns {boolean}
 */
function validatePayloadSize(data, maxBytes = 1_048_576) {
  if (!data) return true;
  const len =
    typeof data === 'string'
      ? Buffer.byteLength(data, 'utf-8')
      : data.byteLength ?? data.length ?? 0;
  return len <= maxBytes;
}

module.exports = {
  generateToken,
  verifyToken,
  checkOrigin,
  RateLimiter,
  validatePayloadSize,
};
