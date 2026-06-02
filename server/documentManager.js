'use strict';

// =============================================================================
// SyncCanvas — Document Lifecycle Manager (In-Memory Cache over Disk)
// =============================================================================

const Y = require('yjs');
const persistence = require('./persistence');
const { logger, metrics } = require('./logger');

/**
 * @typedef {Object} CachedDoc
 * @property {Y.Doc}  ydoc
 * @property {number} connectionCount
 * @property {Date}   lastActivity
 * @property {number} memoryBytes
 */

/** @type {Map<string, CachedDoc>} */
const cache = new Map();

/** Garbage-collector interval handle. */
let _gcInterval = null;

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached Yjs document, or load it from disk (or create a fresh one).
 *
 * @param {string} docId
 * @returns {Promise<Y.Doc>}
 */
async function getOrCreateDoc(docId) {
  const existing = cache.get(docId);
  if (existing) {
    existing.lastActivity = new Date();
    return existing.ydoc;
  }

  const ydoc = new Y.Doc();

  try {
    const binary = await persistence.readDocument(docId);
    if (binary) {
      Y.applyUpdate(ydoc, binary);
      logger.info('document_cache_loaded', { docId, byteSize: binary.byteLength });
    } else {
      logger.info('document_cache_created', { docId });
    }
  } catch (err) {
    logger.error('document_cache_load_error', {
      docId,
      error: err.message,
    });
    // Continue with an empty doc rather than crashing.
  }

  const encoded = Y.encodeStateAsUpdate(ydoc);
  const entry = {
    ydoc,
    connectionCount: 0,
    lastActivity: new Date(),
    memoryBytes: encoded.byteLength,
  };

  cache.set(docId, entry);
  metrics.increment('activeDocuments');
  return ydoc;
}

/**
 * Track an externally-created Y.Doc in the cache (used by y-websocket
 * setPersistence integration, where y-websocket creates the doc itself).
 *
 * @param {string} docId
 * @param {Y.Doc}  ydoc
 */
function trackDoc(docId, ydoc) {
  if (cache.has(docId)) {
    // Already tracked — just refresh activity.
    cache.get(docId).lastActivity = new Date();
    return;
  }

  let memoryBytes = 0;
  try {
    memoryBytes = Y.encodeStateAsUpdate(ydoc).byteLength;
  } catch {
    // Doc may be in an intermediate state.
  }

  cache.set(docId, {
    ydoc,
    connectionCount: 0,
    lastActivity: new Date(),
    memoryBytes,
  });
  metrics.increment('activeDocuments');
  logger.debug('document_tracked', { docId, memoryBytes });
}

// ---------------------------------------------------------------------------
// Connection tracking
// ---------------------------------------------------------------------------

/**
 * Increment the connection count for a cached document.
 * @param {string} docId
 */
function incrementConnections(docId) {
  const entry = cache.get(docId);
  if (entry) {
    entry.connectionCount++;
    entry.lastActivity = new Date();
    logger.debug('connection_incremented', {
      docId,
      connectionCount: entry.connectionCount,
    });
  }
}

/**
 * Decrement the connection count for a cached document.
 * @param {string} docId
 */
function decrementConnections(docId) {
  const entry = cache.get(docId);
  if (entry) {
    entry.connectionCount = Math.max(0, entry.connectionCount - 1);
    entry.lastActivity = new Date();
    logger.debug('connection_decremented', {
      docId,
      connectionCount: entry.connectionCount,
    });
  }
}

/**
 * Get the current connection count for a document.
 * @param {string} docId
 * @returns {number}
 */
function getConnectionCount(docId) {
  const entry = cache.get(docId);
  return entry ? entry.connectionCount : 0;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/**
 * Persist a cached document's current state to disk.
 * @param {string} docId
 * @returns {Promise<void>}
 */
async function persistDocument(docId) {
  const entry = cache.get(docId);
  if (!entry) {
    logger.warn('persist_skip_not_cached', { docId });
    return;
  }

  try {
    const encoded = Y.encodeStateAsUpdate(entry.ydoc);
    entry.memoryBytes = encoded.byteLength;
    await persistence.writeDocument(docId, encoded);
    logger.info('document_persisted', { docId, byteSize: encoded.byteLength });
  } catch (err) {
    logger.error('document_persist_error', { docId, error: err.message });
    metrics.increment('failedSyncs');
  }
}

/**
 * Persist and then evict a document from the in-memory cache.
 * @param {string} docId
 * @returns {Promise<void>}
 */
async function evictDocument(docId) {
  await persistDocument(docId);

  const entry = cache.get(docId);
  if (entry) {
    try {
      entry.ydoc.destroy();
    } catch {
      // ydoc.destroy may throw if already destroyed.
    }
    cache.delete(docId);
    metrics.decrement('activeDocuments');
    logger.info('document_evicted', { docId });
  }
}

// ---------------------------------------------------------------------------
// Garbage Collector
// ---------------------------------------------------------------------------

/**
 * Start a periodic garbage collector that evicts idle, connectionless documents.
 *
 * @param {number} [intervalMs=60000]   — how often to run the GC sweep (ms).
 * @param {number} [maxIdleMs=300000]   — how long a zero-connection doc may be idle (ms).
 */
function startGarbageCollector(intervalMs = 60000, maxIdleMs = 300000) {
  if (_gcInterval) {
    clearInterval(_gcInterval);
  }

  _gcInterval = setInterval(async () => {
    const now = Date.now();
    let totalMemory = 0;
    const evictions = [];

    for (const [docId, entry] of cache) {
      totalMemory += entry.memoryBytes;

      if (entry.connectionCount === 0 && now - entry.lastActivity.getTime() > maxIdleMs) {
        evictions.push(docId);
      }
    }

    for (const docId of evictions) {
      try {
        await evictDocument(docId);
      } catch (err) {
        logger.error('gc_evict_error', { docId, error: err.message });
      }
    }

    if (evictions.length > 0 || cache.size > 0) {
      // Recalculate total memory after evictions.
      let postMemory = 0;
      for (const entry of cache.values()) {
        postMemory += entry.memoryBytes;
      }

      logger.info('gc_sweep', {
        evicted: evictions.length,
        remaining: cache.size,
        totalMemoryBytes: postMemory,
      });
    }
  }, intervalMs);

  // Allow the process to exit even if the timer is still pending.
  if (_gcInterval.unref) _gcInterval.unref();
  logger.info('gc_started', { intervalMs, maxIdleMs });
}

// ---------------------------------------------------------------------------
// Stats & lifecycle
// ---------------------------------------------------------------------------

/**
 * Return an overview of all cached documents.
 * @returns {{ activeDocuments: number, totalMemoryBytes: number, documents: Array }}
 */
function getStats() {
  let totalMemoryBytes = 0;
  const documents = [];

  for (const [docId, entry] of cache) {
    totalMemoryBytes += entry.memoryBytes;
    documents.push({
      docId,
      connectionCount: entry.connectionCount,
      lastActivity: entry.lastActivity.toISOString(),
      memoryBytes: entry.memoryBytes,
    });
  }

  return { activeDocuments: cache.size, totalMemoryBytes, documents };
}

/**
 * Persist every document currently in the cache.
 * Used during graceful shutdown.
 * @returns {Promise<void>}
 */
async function persistAll() {
  const ids = [...cache.keys()];
  logger.info('persist_all_start', { count: ids.length });

  const results = await Promise.allSettled(ids.map((id) => persistDocument(id)));

  let failed = 0;
  for (const r of results) {
    if (r.status === 'rejected') failed++;
  }

  logger.info('persist_all_complete', { total: ids.length, failed });
}

/**
 * Tear down the document manager: stop the GC, persist all docs, clear cache.
 * @returns {Promise<void>}
 */
async function destroy() {
  if (_gcInterval) {
    clearInterval(_gcInterval);
    _gcInterval = null;
  }

  await persistAll();

  for (const [, entry] of cache) {
    try {
      entry.ydoc.destroy();
    } catch {
      // Ignore destruction errors.
    }
  }
  cache.clear();
  logger.info('document_manager_destroyed');
}

module.exports = {
  getOrCreateDoc,
  trackDoc,
  incrementConnections,
  decrementConnections,
  getConnectionCount,
  persistDocument,
  evictDocument,
  startGarbageCollector,
  getStats,
  persistAll,
  destroy,
};
