'use strict';

// =============================================================================
// SyncCanvas — Main Server (Express + ws + y-websocket)
// =============================================================================

const http = require('http');
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const Y = require('yjs');
const crypto = require('crypto');

// y-websocket server utility — official API
const { setupWSConnection, setPersistence, docs } = require('y-websocket/bin/utils');

const documentManager = require('./documentManager');
const snapshots = require('./snapshots');
const persistence = require('./persistence');
const {
  generateToken,
  verifyToken,
  checkOrigin,
  RateLimiter,
  validatePayloadSize,
} = require('./auth');
const { logger, metrics } = require('./logger');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : [];

// ---------------------------------------------------------------------------
// Express app & HTTP server
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const rateLimiter = new RateLimiter();

// ---------------------------------------------------------------------------
// y-websocket persistence hooks
// ---------------------------------------------------------------------------

setPersistence({
  /**
   * Called by y-websocket when a new document room is opened.
   * We load persisted state from disk and wire up the snapshot engine.
   */
  bindState: async (docName, ydoc) => {
    try {
      const state = await persistence.readDocument(docName);
      if (state) {
        Y.applyUpdate(ydoc, state);
        logger.info('document_loaded', {
          docId: docName,
          byteSize: state.byteLength,
        });
      } else {
        logger.info('document_created', { docId: docName });
      }
    } catch (err) {
      logger.error('document_load_error', {
        docId: docName,
        error: err.message,
      });
    }

    // Register in the document-manager cache.
    documentManager.trackDoc(docName, ydoc);

    // Record every mutation in the snapshot engine.
    ydoc.on('update', (update, origin) => {
      const userId = typeof origin === 'string' ? origin : null;
      snapshots.recordUpdate(docName, update, userId, ydoc).catch((err) => {
        logger.error('snapshot_record_error', {
          docId: docName,
          error: err.message,
        });
      });
    });
  },

  /**
   * Called by y-websocket when a document room is closed (all clients left).
   * We persist the final state to disk.
   */
  writeState: async (docName, ydoc) => {
    try {
      const encoded = Y.encodeStateAsUpdate(ydoc);
      await persistence.writeDocument(docName, encoded);
      logger.info('document_saved', {
        docId: docName,
        byteSize: encoded.byteLength,
      });
    } catch (err) {
      logger.error('document_save_error', {
        docId: docName,
        error: err.message,
      });
      metrics.increment('failedSyncs');
    }
  },
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/node_modules', express.static(path.join(__dirname, '..', 'node_modules'), {
  extensions: ['js', 'mjs'],
  index: 'index.js'
}));

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

/**
 * GET /api/documents — list all persisted documents.
 */
app.get('/api/documents', async (_req, res) => {
  try {
    const docs = await persistence.listDocuments();
    res.json({ ok: true, documents: docs });
  } catch (err) {
    logger.error('api_list_documents_error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Failed to list documents' });
  }
});

/**
 * GET /api/token/:docId — generate a room token.
 */
app.get('/api/token/:docId', (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.query.userId || crypto.randomUUID();
    const role = req.query.role || 'editor';

    const token = generateToken(docId, userId, role);
    logger.info('token_issued', { docId, userId, role });

    res.json({ ok: true, token, userId, docId, role });
  } catch (err) {
    logger.error('api_token_error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Failed to generate token' });
  }
});

/**
 * GET /api/checkpoints/:docId — list checkpoints for a document.
 */
app.get('/api/checkpoints/:docId', async (req, res) => {
  try {
    const checkpoints = await snapshots.getCheckpoints(req.params.docId);
    res.json({ ok: true, checkpoints });
  } catch (err) {
    logger.error('api_list_checkpoints_error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Failed to list checkpoints' });
  }
});

/**
 * GET /api/checkpoints/:docId/:checkpointId/preview — fetch read-only text preview.
 */
app.get('/api/checkpoints/:docId/:checkpointId/preview', async (req, res) => {
  try {
    const { docId, checkpointId } = req.params;
    const sequence = parseInt(checkpointId, 10);
    if (isNaN(sequence)) {
      return res.status(400).json({ ok: false, error: 'Invalid checkpoint ID' });
    }

    const ydoc = await snapshots.restoreToCheckpoint(docId, sequence);
    const ytext = ydoc.getText('quill');
    const textContent = ytext.toString();
    ydoc.destroy();

    // Convert plain text to simple previewable HTML
    const paragraphs = textContent
      .split('\n')
      .map(p => p.trim() ? `<p>${escapeHtml(p)}</p>` : '')
      .join('');

    const html = paragraphs || '<p><i>Empty document</i></p>';

    // Find checkpoint metadata for timestamp
    const checkpoints = await snapshots.getCheckpoints(docId);
    const checkpoint = checkpoints.find(c => c.sequence === sequence);
    const timestamp = checkpoint ? checkpoint.timestamp : new Date().toISOString();

    res.json({ ok: true, html, timestamp });
  } catch (err) {
    logger.error('api_checkpoint_preview_error', { docId: req.params.docId, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


/**
 * POST /api/rollback/:docId/:checkpointId — restore a document to a checkpoint.
 *
 * Expects an admin-role token in the Authorization header (Bearer <token>).
 */
app.post('/api/rollback/:docId/:checkpointId', async (req, res) => {
  try {
    const { docId, checkpointId } = req.params;
    const sequence = parseInt(checkpointId, 10);

    if (isNaN(sequence)) {
      return res.status(400).json({ ok: false, error: 'Invalid checkpoint ID' });
    }

    // Verify admin token.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      return res.status(401).json({ ok: false, error: 'Missing authorization token' });
    }

    const verification = verifyToken(token);
    if (!verification.valid) {
      return res.status(401).json({ ok: false, error: verification.error });
    }
    if (verification.payload.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin role required' });
    }

    // Restore checkpoint into a fresh Y.Doc.
    const restoredDoc = await snapshots.restoreToCheckpoint(docId, sequence);
    const restoredState = Y.encodeStateAsUpdate(restoredDoc);

    // Apply the restored state to the live y-websocket doc (if one exists).
    const liveDoc = docs.get(docId);
    if (liveDoc) {
      Y.applyUpdate(liveDoc, restoredState);
      logger.info('rollback_applied_live', { docId, sequence });
    }

    // Also persist the restored state to disk.
    await persistence.writeDocument(docId, restoredState);

    restoredDoc.destroy();

    logger.info('rollback_complete', {
      docId,
      sequence,
      byteSize: restoredState.byteLength,
    });

    res.json({
      ok: true,
      docId,
      restoredSequence: sequence,
      byteSize: restoredState.byteLength,
    });
  } catch (err) {
    logger.error('api_rollback_error', {
      docId: req.params.docId,
      error: err.message,
    });
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/save-code/:docId — Explicitly force save the document Yjs CRDT state to disk.
 */
app.post('/api/save-code/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const liveDoc = docs.get(docId);
    if (!liveDoc) {
      // If the room is not active in memory, it means the last client disconnected
      // and the writeState hook has already successfully written the latest CRDT state to disk.
      return res.json({ ok: true, message: 'Document is already up to date on disk' });
    }

    const encoded = Y.encodeStateAsUpdate(liveDoc);
    await persistence.writeDocument(docId, encoded);
    logger.info('document_explicitly_saved_to_disk', { docId, byteSize: encoded.byteLength });

    // Also trigger checkpoint creation immediately
    await snapshots.createCheckpoint(docId, liveDoc).catch((err) => {
      logger.error('save_code_checkpoint_creation_error', { docId, error: err.message });
    });

    res.json({ ok: true, message: 'Document persistently saved' });
  } catch (err) {
    logger.error('api_save_code_error', { docId: req.params.docId, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/compile — Proxy route to run code via EMKC Piston compilation engine.
 * Bypasses browser CORS policy and secures external requests.
 */
app.post('/api/compile', async (req, res) => {
  try {
    const { language, files } = req.body;

    if (!language || !files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ ok: false, error: 'Invalid compilation request payload' });
    }

    const code = files[0].content;
    if (typeof code !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing code content' });
    }

    // Map compiler IDs to Wandbox compilers
    const compilerMapping = {
      'python': 'cpython-3.12.7',
      'python3': 'cpython-3.12.7',
      'cpp': 'gcc-13.2.0',
      'c++': 'gcc-13.2.0',
      'c': 'gcc-13.2.0-c',
      'csharp': 'dotnetcore-6.0.425',
      'c#': 'dotnetcore-6.0.425'
    };

    const compilerId = compilerMapping[language.toLowerCase()];
    if (!compilerId) {
      return res.status(400).json({ ok: false, error: `Language '${language}' is not supported by the compile service.` });
    }

    const payload = {
      compiler: compilerId,
      code: code,
      stdin: req.body.stdin || ''
    };

    if (files.length > 1) {
      payload.codes = files.slice(1).map(file => ({
        file: file.name,
        code: file.content
      }));
    }

    // Set up a fetch call with an abort timeout of 15 seconds (C# template compilation can take up to 6 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch('https://wandbox.org/api/compile.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ ok: false, error: `Compiler API error: ${errText}` });
    }

    const data = await response.json();

    // Map Wandbox output back to Piston layout expected by client
    const runResult = {
      stdout: data.program_output || '',
      stderr: data.compiler_error || data.program_error || '',
      code: data.status !== undefined ? parseInt(data.status, 10) : 0
    };

    res.json({
      ok: true,
      data: {
        run: runResult
      }
    });

  } catch (err) {
    logger.error('backend_compiler_proxy_error', { error: err.message });
    res.status(500).json({
      ok: false,
      error: err.name === 'AbortError'
        ? 'Compiler API timeout (15 seconds expired)'
        : `Compiler Connection Failed: ${err.message}`
    });
  }
});

/**
 * POST /api/ai/stream — SSE endpoint to stream code generation from Gemini API.
 * Features automated character-by-character typing simulation fallback if process.env.GEMINI_API_KEY is not defined.
 */
app.post('/api/ai/stream', async (req, res) => {
  let intervalId = null;
  try {
    const { prompt, code, language } = req.body;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'Prompt is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const apiKey = process.env.GEMINI_API_KEY;

    if (apiKey) {
      const systemInstruction = "You are an expert programming copilot. Generate clean, functional code based on the instructions. Return ONLY the code block itself. DO NOT wrap it in markdown code blocks like ```python ... ```, write no explanations, and no descriptions.";
      
      const payload = {
        contents: [
          {
            parts: [{ text: `Language: ${language}\nExisting Code Context:\n${code}\n\nTask: ${prompt}` }]
          }
        ],
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        }
      };

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        res.write(`data: ${JSON.stringify({ error: `Gemini API error: ${errText}` })}\n\n`);
        res.end();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let lastIndex = 0;
      let textBuffer = '';

      req.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        textBuffer += decoder.decode(value, { stream: true });
        let match;
        textRegex.lastIndex = lastIndex;

        while ((match = textRegex.exec(textBuffer)) !== null) {
          lastIndex = textRegex.lastIndex;
          let textVal = '';
          try {
            textVal = JSON.parse(`"${match[1]}"`);
          } catch {
            textVal = match[1];
          }
          if (textVal) {
            res.write(`data: ${JSON.stringify({ text: textVal })}\n\n`);
          }
        }
      }

      res.write(`data: [DONE]\n\n`);
      res.end();

    } else {
      // Mock typing simulator fallback mode
      const promptLower = prompt.toLowerCase();
      const langLower = (language || 'javascript').toLowerCase();
      let codeTemplate = '';

      if (promptLower.includes('quicksort') || promptLower.includes('quick')) {
        if (langLower === 'python') {
          codeTemplate = `def quicksort(arr):\n    if len(arr) <= 1:\n        return arr\n    pivot = arr[len(arr) // 2]\n    left = [x for x in arr if x < pivot]\n    middle = [x for x in arr if x == pivot]\n    right = [x for x in arr if x > pivot]\n    return quicksort(left) + middle + quicksort(right)\n\n# Execution Test\nprint("Sorted list:", quicksort([3, 6, 8, 10, 1, 2, 1]))\n`;
        } else if (langLower === 'cpp' || langLower === 'c') {
          codeTemplate = `// Quicksort implementation in C/C++\nvoid swap(int* a, int* b) {\n    int t = *a;\n    *a = *b;\n    *b = t;\n}\n\nint partition(int arr[], int low, int high) {\n    int pivot = arr[high];\n    int i = (low - 1);\n    for (int j = low; j <= high - 1; j++) {\n        if (arr[j] < pivot) {\n            i++;\n            swap(&arr[i], &arr[j]);\n        }\n    }\n    swap(&arr[i + 1], &arr[high]);\n    return (i + 1);\n}\n\nvoid quicksort(int arr[], int low, int high) {\n    if (low < high) {\n        int pi = partition(arr, low, high);\n        quicksort(arr, low, pi - 1);\n        quicksort(arr, pi + 1, high);\n    }\n}\n`;
        } else {
          codeTemplate = `function quicksort(arr) {\n  if (arr.length <= 1) return arr;\n  const pivot = arr[Math.floor(arr.length / 2)];\n  const left = arr.filter(x => x < pivot);\n  const middle = arr.filter(x => x === pivot);\n  const right = arr.filter(x => x > pivot);\n  return [...quicksort(left), ...middle, ...quicksort(right)];\n}\n\nconsole.log("Sorted Array:", quicksort([3, 6, 8, 10, 1, 2, 1]));\n`;
        }
      } else if (promptLower.includes('bubble') || promptLower.includes('sort')) {
        if (langLower === 'python') {
          codeTemplate = `def bubblesort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n-i-1):\n            if arr[j] > arr[j+1]:\n                arr[j], arr[j+1] = arr[j+1], arr[j]\n    return arr\n\nprint(bubblesort([64, 34, 25, 12, 22, 11, 90]))\n`;
        } else {
          codeTemplate = `function bubbleSort(arr) {\n  let len = arr.length;\n  for (let i = 0; i < len; i++) {\n    for (let j = 0; j < len - i - 1; j++) {\n      if (arr[j] > arr[j + 1]) {\n        let temp = arr[j];\n        arr[j] = arr[j + 1];\n        arr[j + 1] = temp;\n      }\n    }\n  }\n  return arr;\n}\n\nconsole.log(bubbleSort([64, 34, 25, 12, 22, 11, 90]));\n`;
        }
      } else if (promptLower.includes('binary') || promptLower.includes('search')) {
        if (langLower === 'python') {
          codeTemplate = `def binary_search(arr, x):\n    low = 0\n    high = len(arr) - 1\n    while low <= high:\n        mid = (high + low) // 2\n        if arr[mid] < x:\n            low = mid + 1\n        elif arr[mid] > x:\n            high = mid - 1\n        else:\n            return mid\n    return -1\n\nprint("Element index:", binary_search([2, 3, 4, 10, 40], 10))\n`;
        } else {
          codeTemplate = `function binarySearch(arr, x) {\n  let low = 0, high = arr.length - 1;\n  while (low <= high) {\n    let mid = Math.floor((low + high) / 2);\n    if (arr[mid] < x) low = mid + 1;\n    else if (arr[mid] > x) high = mid - 1;\n    else return mid;\n  }\n  return -1;\n}\n\nconsole.log("Element index:", binarySearch([2, 3, 4, 10, 40], 10));\n`;
        }
      } else if (promptLower.includes('fibo') || promptLower.includes('fibonacci')) {
        if (langLower === 'python') {
          codeTemplate = `def fibonacci(n):\n    if n <= 0: return []\n    if n == 1: return [0]\n    fib = [0, 1]\n    while len(fib) < n:\n        fib.append(fib[-1] + fib[-2])\n    return fib\n\nprint(fibonacci(10))\n`;
        } else {
          codeTemplate = `function fibonacci(n) {\n  if (n <= 0) return [];\n  if (n === 1) return [0];\n  let fib = [0, 1];\n  while (fib.length < n) {\n    fib.push(fib[fib.length - 1] + fib[fib.length - 2]);\n  }\n  return fib;\n}\n\nconsole.log(fibonacci(10));\n`;
        }
      } else if (promptLower.includes('hello')) {
        if (langLower === 'python') {
          codeTemplate = `print("Hello from SyncCanvas AI Assistant!")\n`;
        } else if (langLower === 'cpp') {
          codeTemplate = `#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello from SyncCanvas AI Assistant!" << endl;\n    return 0;\n}\n`;
        } else if (langLower === 'c') {
          codeTemplate = `#include <stdio.h>\n\nint main() {\n    printf("Hello from SyncCanvas AI Assistant!\\\\n");\n    return 0;\n}\n`;
        } else if (langLower === 'csharp') {
          codeTemplate = `using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello from SyncCanvas AI Assistant!");\n    }\n}\n`;
        } else {
          codeTemplate = `console.log("Hello from SyncCanvas AI Assistant!");\n`;
        }
      } else {
        if (langLower === 'python') {
          codeTemplate = `# AI generated script for: ${prompt.replace(/\n/g, ' ')}\nprint("AI Task Complete: '${prompt.replace(/"/g, '\\"')}'")\n`;
        } else {
          codeTemplate = `// AI generated script for: ${prompt.replace(/\n/g, ' ')}\nconsole.log("AI Task Complete: '${prompt.replace(/"/g, '\\"')}'");\n`;
        }
      }

      let charIndex = 0;
      const charsPerChunk = 5;

      intervalId = setInterval(() => {
        if (charIndex >= codeTemplate.length) {
          clearInterval(intervalId);
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        }

        const chunk = codeTemplate.slice(charIndex, charIndex + charsPerChunk);
        charIndex += charsPerChunk;
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }, 25);

      req.on('close', () => {
        if (intervalId) clearInterval(intervalId);
      });
    }

  } catch (err) {
    if (intervalId) clearInterval(intervalId);
    logger.error('backend_ai_stream_error', { error: err.message });
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

/**
 * GET /api/stats — server observability endpoint.
 */
app.get('/api/stats', (_req, res) => {
  try {
    const docStats = documentManager.getStats();
    const metricSnapshot = metrics.get();
    const wsDocsCount = docs.size;

    res.json({
      ok: true,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      metrics: metricSnapshot,
      documents: docStats,
      wsActiveDocs: wsDocsCount,
    });
  } catch (err) {
    logger.error('api_stats_error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Failed to gather stats' });
  }
});

// SPA fallback routes
// Serves index.html for any route that does not match an API endpoint or a static file.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.includes('.')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => {
    if (err) {
      res.status(500).send('Error loading page.');
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade — security checks + y-websocket hand-off
// ---------------------------------------------------------------------------

server.on('upgrade', (request, socket, head) => {
  // 1. Extract client IP.
  const ip =
    request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    request.socket.remoteAddress ||
    'unknown';

  // 2. Rate-limit check.
  const rl = rateLimiter.check(ip);
  if (!rl.allowed) {
    logger.warn('ws_rate_limited', { ip });
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // 3. Origin check.
  const origin = request.headers.origin;
  if (!checkOrigin(origin, ALLOWED_ORIGINS)) {
    logger.warn('ws_origin_rejected', { origin, ip });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // 4. Extract room (doc) name from URL path.
  //    y-websocket clients connect to ws://host/{docName}?token=...
  const url = new URL(request.url, `http://${request.headers.host}`);
  const docName = url.pathname.slice(1).split('?')[0]; // strip leading /

  if (!docName) {
    logger.warn('ws_missing_doc_name', { ip });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // 5. Optional token verification (if provided in query string).
  const token = url.searchParams.get('token');
  if (token) {
    const result = verifyToken(token);
    if (!result.valid) {
      logger.warn('ws_token_invalid', { ip, error: result.error });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Optionally enforce that the token's docId matches the requested room.
    if (result.payload.docId !== docName) {
      logger.warn('ws_token_room_mismatch', {
        ip,
        tokenDoc: result.payload.docId,
        requestedDoc: docName,
      });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Attach user info to the request for downstream use.
    request._syncUser = result.payload;
  }

  // 6. All checks passed — upgrade.
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const docName = url.pathname.slice(1).split('?')[0];
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  logger.info('ws_connected', { docId: docName, ip });

  // Hand off to y-websocket.
  setupWSConnection(ws, req, { docName });

  // Track connection in document manager.
  documentManager.incrementConnections(docName);
  metrics.increment('totalConnections');

  ws.on('close', () => {
    documentManager.decrementConnections(docName);
    logger.info('ws_disconnected', { docId: docName, ip });
  });

  ws.on('error', (err) => {
    logger.error('ws_error', { docId: docName, ip, error: err.message });
  });
});

// ---------------------------------------------------------------------------
// Start server + background services
// ---------------------------------------------------------------------------

documentManager.startGarbageCollector();
snapshots.startPeriodicCheckpoints();

server.listen(PORT, () => {
  logger.info('server_started', { port: PORT });
  console.log(`\n  \u{1F680} SyncCanvas running at http://localhost:${PORT}\n`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  logger.info('server_shutting_down', { signal });
  console.log(`\n  Shutting down (${signal})…`);

  // Stop accepting new connections.
  server.close();

  // Close all WebSocket connections.
  for (const client of wss.clients) {
    try {
      client.close(1001, 'Server shutting down');
    } catch {
      // Ignore errors on already-closing sockets.
    }
  }

  try {
    await documentManager.persistAll();
  } catch (err) {
    logger.error('shutdown_persist_error', { error: err.message });
  }

  snapshots.destroy();
  rateLimiter.destroy();

  try {
    await persistence.close();
  } catch (err) {
    logger.error('shutdown_db_close_error', { error: err.message });
  }

  logger.info('server_stopped');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
