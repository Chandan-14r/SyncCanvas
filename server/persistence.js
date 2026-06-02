'use strict';

// =============================================================================
// SyncCanvas — Binary Persistence Layer (MongoDB / File Hybrid)
// =============================================================================

const fs = require('fs/promises');
const path = require('path');
const { MongoClient, Binary } = require('mongodb');
const { logger } = require('./logger');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const MONGODB_URI = process.env.MONGODB_URI;

/** Track whether we've already ensured the data directory exists. */
let _dirReady = false;

// MongoDB Connection State
let mongoClient = null;
let dbInstance = null;
let connectionPromise = null;

/**
 * Initialize MongoDB connection if MONGODB_URI is provided.
 * @returns {Promise<Db|null>}
 */
async function getDb() {
  if (!MONGODB_URI) return null;
  if (dbInstance) return dbInstance;

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      logger.info('db_connecting', { uri: MONGODB_URI.replace(/:([^@:]+)@/, ':****@') });
      mongoClient = new MongoClient(MONGODB_URI, {
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000,
      });
      await mongoClient.connect();
      dbInstance = mongoClient.db();
      logger.info('db_connected');
      console.log('  🔌 Connected to MongoDB Atlas for cloud persistence');
      return dbInstance;
    } catch (err) {
      logger.error('db_connection_failed', { error: err.message });
      connectionPromise = null; // Let next attempt retry
      throw err;
    }
  })();

  return connectionPromise;
}

/**
 * Ensure the local data directory exists, creating it if necessary.
 */
async function ensureDataDir() {
  if (_dirReady) return;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    _dirReady = true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    _dirReady = true;
  }
}

// ---------------------------------------------------------------------------
// Document I/O
// ---------------------------------------------------------------------------

/**
 * Read a persisted Yjs document.
 * @param {string} docId
 * @returns {Promise<Uint8Array|null>} The raw binary, or null if not found.
 */
async function readDocument(docId) {
  try {
    const db = await getDb();
    if (db) {
      const doc = await db.collection('documents').findOne({ _id: docId });
      if (!doc) return null;
      return new Uint8Array(doc.update.buffer);
    }
  } catch (err) {
    logger.error('db_read_document_error', { docId, error: err.message });
  }

  // File fallback
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, `${docId}.bin`);
  try {
    const buf = await fs.readFile(filePath);
    return new Uint8Array(buf);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write a Yjs state update (overwrites any existing record).
 * @param {string} docId
 * @param {Uint8Array} update
 * @returns {Promise<void>}
 */
async function writeDocument(docId, update) {
  try {
    const db = await getDb();
    if (db) {
      const buffer = Buffer.from(update);
      await db.collection('documents').updateOne(
        { _id: docId },
        {
          $set: {
            update: new Binary(buffer),
            size: buffer.byteLength,
            modified: new Date(),
          },
        },
        { upsert: true }
      );
      return;
    }
  } catch (err) {
    logger.error('db_write_document_error', { docId, error: err.message });
  }

  // File fallback
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, `${docId}.bin`);
  await fs.writeFile(filePath, Buffer.from(update));
}

/**
 * List all persisted documents, returning id, size, and last-modified timestamp.
 * @returns {Promise<Array<{id: string, size: number, modified: Date}>>}
 */
async function listDocuments() {
  try {
    const db = await getDb();
    if (db) {
      const docs = await db.collection('documents').find({}).toArray();
      return docs.map((doc) => ({
        id: doc._id,
        size: doc.size,
        modified: doc.modified,
      }));
    }
  } catch (err) {
    logger.error('db_list_documents_error', { error: err.message });
  }

  // File fallback
  await ensureDataDir();
  try {
    const entries = await fs.readdir(DATA_DIR);
    const results = [];
    for (const entry of entries) {
      if (!entry.endsWith('.bin') || entry.includes('.ckpt.')) continue;
      const filePath = path.join(DATA_DIR, entry);
      try {
        const stat = await fs.stat(filePath);
        results.push({
          id: entry.replace(/\.bin$/, ''),
          size: stat.size,
          modified: stat.mtime,
        });
      } catch {
        // File may have been deleted — skip.
      }
    }
    return results;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Delete a persisted document and all associated data.
 * @param {string} docId
 * @returns {Promise<void>}
 */
async function deleteDocument(docId) {
  try {
    const db = await getDb();
    if (db) {
      await Promise.all([
        db.collection('documents').deleteOne({ _id: docId }),
        db.collection('meta').deleteOne({ _id: docId }),
        db.collection('checkpoints').deleteMany({ '_id.docId': docId }),
      ]);
      return;
    }
  } catch (err) {
    logger.error('db_delete_document_error', { docId, error: err.message });
  }

  // File fallback
  await ensureDataDir();
  const mainFile = path.join(DATA_DIR, `${docId}.bin`);
  await _unlinkSafe(mainFile);
  const metaFile = path.join(DATA_DIR, `${docId}.meta.json`);
  await _unlinkSafe(metaFile);

  try {
    const entries = await fs.readdir(DATA_DIR);
    const prefix = `${docId}.ckpt.`;
    const toDelete = entries.filter((e) => e.startsWith(prefix) && e.endsWith('.bin'));
    await Promise.all(toDelete.map((f) => _unlinkSafe(path.join(DATA_DIR, f))));
  } catch {
    // Data dir may no longer exist — nothing to clean up.
  }
}

// ---------------------------------------------------------------------------
// Checkpoint I/O
// ---------------------------------------------------------------------------

/**
 * Read a checkpoint binary for a given document and sequence number.
 * @param {string} docId
 * @param {number} sequence
 * @returns {Promise<Uint8Array|null>}
 */
async function readCheckpoint(docId, sequence) {
  try {
    const db = await getDb();
    if (db) {
      const cp = await db.collection('checkpoints').findOne({ _id: { docId, sequence } });
      if (!cp) return null;
      return new Uint8Array(cp.data.buffer);
    }
  } catch (err) {
    logger.error('db_read_checkpoint_error', { docId, sequence, error: err.message });
  }

  // File fallback
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, `${docId}.ckpt.${sequence}.bin`);
  try {
    const buf = await fs.readFile(filePath);
    return new Uint8Array(buf);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write a checkpoint binary.
 * @param {string} docId
 * @param {number} sequence
 * @param {Uint8Array} data
 * @returns {Promise<void>}
 */
async function writeCheckpoint(docId, sequence, data) {
  try {
    const db = await getDb();
    if (db) {
      const buffer = Buffer.from(data);
      await db.collection('checkpoints').updateOne(
        { _id: { docId, sequence } },
        { $set: { data: new Binary(buffer) } },
        { upsert: true }
      );
      return;
    }
  } catch (err) {
    logger.error('db_write_checkpoint_error', { docId, sequence, error: err.message });
  }

  // File fallback
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, `${docId}.ckpt.${sequence}.bin`);
  await fs.writeFile(filePath, Buffer.from(data));
}

// ---------------------------------------------------------------------------
// Metadata I/O (JSON)
// ---------------------------------------------------------------------------

/**
 * Read the per-document metadata JSON.
 * @param {string} docId
 * @returns {Promise<Object|null>}
 */
async function readMeta(docId) {
  try {
    const db = await getDb();
    if (db) {
      const meta = await db.collection('meta').findOne({ _id: docId });
      if (!meta) return null;
      // Strip DB internal id to match standard format
      const cleaned = { ...meta };
      delete cleaned._id;
      return cleaned;
    }
  } catch (err) {
    logger.error('db_read_meta_error', { docId, error: err.message });
  }

  // File fallback
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, `${docId}.meta.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Write (overwrite) the per-document metadata JSON.
 * @param {string} docId
 * @param {Object} meta
 * @returns {Promise<void>}
 */
async function writeMeta(docId, meta) {
  try {
    const db = await getDb();
    if (db) {
      await db.collection('meta').replaceOne(
        { _id: docId },
        { ...meta },
        { upsert: true }
      );
      return;
    }
  } catch (err) {
    logger.error('db_write_meta_error', { docId, error: err.message });
  }

  // File fallback
  await ensureDataDir();
  const filePath = path.join(DATA_DIR, `${docId}.meta.json`);
  await fs.writeFile(filePath, JSON.stringify(meta, null, 2), 'utf-8');
}

/**
 * List all checkpoints for a document, sourced from its metadata.
 * @param {string} docId
 * @returns {Promise<Array<{sequence: number, timestamp: string, byteSize: number}>>}
 */
async function listCheckpoints(docId) {
  const meta = await readMeta(docId);
  if (!meta || !Array.isArray(meta.checkpoints)) return [];
  return meta.checkpoints.map((cp) => ({
    sequence: cp.sequence,
    timestamp: cp.timestamp,
    byteSize: cp.byteSize,
  }));
}

// ---------------------------------------------------------------------------
// Lifecycle Connection Cleanup
// ---------------------------------------------------------------------------

/**
 * Safely disconnect MongoDB client on app shutdown.
 * @returns {Promise<void>}
 */
async function close() {
  if (mongoClient) {
    try {
      await mongoClient.close();
      logger.info('db_disconnected');
      console.log('  🔌 Closed MongoDB connections');
    } catch (err) {
      logger.error('db_disconnect_error', { error: err.message });
    } finally {
      mongoClient = null;
      dbInstance = null;
      connectionPromise = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely unlink a file, ignoring ENOENT errors.
 * @param {string} filePath
 */
async function _unlinkSafe(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  readDocument,
  writeDocument,
  listDocuments,
  deleteDocument,
  readCheckpoint,
  writeCheckpoint,
  readMeta,
  writeMeta,
  listCheckpoints,
  close,
};
