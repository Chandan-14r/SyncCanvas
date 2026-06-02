'use strict';

// =============================================================================
// SyncCanvas — Structured JSON Logger & Metrics
// =============================================================================

const LOG_LEVEL = (process.env.LOG_LEVEL || 'debug').toLowerCase();

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LEVELS[LOG_LEVEL] ?? LEVELS.info;

/**
 * Emit a single JSON log line to the appropriate console stream.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event   — short, snake_case event name
 * @param {object} [data]  — arbitrary structured context
 */
function emit(level, event, data = {}) {
  if (LEVELS[level] < currentLevel) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };

  const line = JSON.stringify(entry);

  switch (level) {
    case 'error':
      console.error(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'debug':
      console.debug(line);
      break;
    default:
      console.log(line);
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = {
  /**
   * Log an informational event.
   * @param {string} event
   * @param {object} [data]
   */
  info(event, data) {
    emit('info', event, data);
  },

  /**
   * Log a warning event.
   * @param {string} event
   * @param {object} [data]
   */
  warn(event, data) {
    emit('warn', event, data);
  },

  /**
   * Log an error event.
   * @param {string} event
   * @param {object} [data]
   */
  error(event, data) {
    emit('error', event, data);
  },

  /**
   * Log a debug-level event (suppressed unless LOG_LEVEL=debug).
   * @param {string} event
   * @param {object} [data]
   */
  debug(event, data) {
    emit('debug', event, data);
  },
};

// ---------------------------------------------------------------------------
// Metrics — simple in-process counters
// ---------------------------------------------------------------------------

const _counters = {
  activeDocuments: 0,
  totalConnections: 0,
  reconnects: 0,
  failedSyncs: 0,
};

const metrics = {
  /**
   * Increment a named counter by 1.
   * @param {string} name
   */
  increment(name) {
    if (!(name in _counters)) {
      _counters[name] = 0;
    }
    _counters[name]++;
  },

  /**
   * Decrement a named counter by 1 (floor at 0).
   * @param {string} name
   */
  decrement(name) {
    if (!(name in _counters)) {
      _counters[name] = 0;
    }
    _counters[name] = Math.max(0, _counters[name] - 1);
  },

  /**
   * Return a shallow copy of all counters.
   * @returns {object}
   */
  get() {
    return { ..._counters };
  },
};

module.exports = { logger, metrics };
