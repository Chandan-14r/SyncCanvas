import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { QuillBinding } from 'y-quill';

// Quill, QuillCursors, and DOMPurify are loaded as globals via script tags in index.html
const Quill = window.Quill;
const QuillCursors = window.QuillCursors;
const DOMPurify = window.DOMPurify;

let providerInstance = null;
let ydocInstance = null;

export async function initEditor(docId) {
  // 1. Initialize Yjs document
  const ydoc = new Y.Doc();
  ydocInstance = ydoc;

  // 2. Derive WebSocket URL and connect
  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProtocol}://${window.location.host}`;
  
  // Load signed room token if available
  const token = sessionStorage.getItem(`syncanvas-token-${docId}`);
  const options = token ? { params: { token } } : {};
  
  // Connect via WebsocketProvider. Scoped to room `docId`.
  const provider = new WebsocketProvider(wsUrl, docId, ydoc, options);
  providerInstance = provider;

  const ytext = ydoc.getText('quill');

  // 3. Register cursor module
  Quill.register('modules/cursors', QuillCursors);

  // 4. Instantiate Quill Editor
  const quill = new Quill('#editor-container', {
    theme: 'snow',
    modules: {
      toolbar: [
        [{ header: [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'code-block'],
        ['link'],
        ['clean']
      ],
      cursors: true
    },
    placeholder: 'Welcome to SyncCanvas. Start typing to sync in real-time...'
  });

  // 5. Hardened Security: paste sanitization on input entry points
  quill.clipboard.addMatcher(Node.ELEMENT_NODE, (node, delta) => {
    if (node.innerHTML) {
      // Clean HTML contents using DOMPurify before parsing delta
      const cleanHtml = DOMPurify.sanitize(node.innerHTML);
      node.innerHTML = cleanHtml;
    }
    return delta;
  });

  // 6. Bind Yjs to Quill Editor
  const binding = new QuillBinding(ytext, quill, provider.awareness);

  // 7. Track Connection Badges & Cold Start Warnings
  let isFirstConnection = true;
  let connectionTimeout = setTimeout(() => {
    if (isFirstConnection) {
      window.showToast?.('Waking up the cloud server (this can take 30-50s on Render free tier)...', 'info', 10000);
    }
  }, 4500);

  provider.on('status', ({ status }) => {
    if (status === 'connected') {
      isFirstConnection = false;
      clearTimeout(connectionTimeout);
    }
    updateConnectionUI(status);
  });

  return { provider, ydoc, quill, binding };
}

function updateConnectionUI(status) {
  const badge = document.getElementById('connection-badge');
  const dot = badge.querySelector('.connection-dot');
  const text = badge.querySelector('.connection-text');

  if (status === 'connected') {
    badge.className = 'connection-badge connected';
    text.textContent = 'Online';
    window.showToast?.('Connected — syncing real-time edits', 'success', 2500);
  } else if (status === 'connecting') {
    badge.className = 'connection-badge reconnecting';
    text.textContent = 'Reconnecting...';
    window.showToast?.('Connection lost — attempting reconnection', 'warning', 3000);
  } else {
    badge.className = 'connection-badge disconnected';
    text.textContent = 'Offline';
    window.showToast?.('Offline — saving changes locally', 'error', 4000);
  }
}

export function getProvider() {
  return providerInstance;
}

export function getYDoc() {
  return ydocInstance;
}
