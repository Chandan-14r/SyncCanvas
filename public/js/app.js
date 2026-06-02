// Import all modules
import { initEditor } from './editor.js';
import { initPresence } from './presence.js';
import { initOffline } from './offline.js';
import { initRollbackUI } from './rollback-ui.js';
import { initDebugPanel } from './debug.js';
import { initCompiler } from './compiler.js';
import { initWhiteboard } from './whiteboard.js';

// --- URL Router ---
// Parse location.pathname to get the document ID directly from the path (e.g. /my-custom-name).
// If empty, return null (homepage portal).
function getDocId() {
  const path = window.location.pathname;
  // Match any alphanumeric or hyphen string at the root level or under /doc/ (for compatibility)
  const match = path.match(/^\/(?:doc\/)?([a-zA-Z0-9\-]+)/);
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

// --- Toast System ---
// Creates a toast element, appends to the container, and handles decay
export function showToast(message, type = 'info', durationMs = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;

  container.appendChild(toast);

  // Auto-remove after duration
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => {
      if (toast.parentNode === container) {
        container.removeChild(toast);
      }
    }, 300);
  }, durationMs);
}

// Expose toast system globally for non-module components
window.showToast = showToast;

// --- Theme Toggle ---
function initTheme() {
  const themeToggle = document.getElementById('theme-toggle');
  const themeIcon = themeToggle.querySelector('.theme-icon');
  
  const savedTheme = localStorage.getItem('syncanvas-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeIcon.textContent = savedTheme === 'dark' ? '🌙' : '☀️';

  themeToggle.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('syncanvas-theme', nextTheme);
    themeIcon.textContent = nextTheme === 'dark' ? '🌙' : '☀️';
    showToast(`Switched to ${nextTheme} theme`, 'info', 2000);
  });
}

// --- Bottom Drawer Toggle ---
function initDrawer() {
  const drawer = document.getElementById('bottom-drawer');
  const toggle = document.getElementById('drawer-toggle');

  toggle.addEventListener('click', () => {
    drawer.classList.toggle('open');
  });
}

// --- Keyboard Shortcuts ---
// Ctrl + Shift + D toggles the hidden network debug panel
function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      if (window.toggleDebugPanel) {
        window.toggleDebugPanel();
      }
    }
  });
}

// --- Initialize All Modules ---
async function init() {
  const docId = getDocId();

  if (!docId) {
    // Show portal and hide editor layout elements
    document.getElementById('portal-container').hidden = false;
    document.getElementById('topbar').hidden = true;
    document.querySelector('.app-layout').style.display = 'none';
    document.getElementById('bottom-drawer').style.display = 'none';

    // Show current hostname prefix
    document.getElementById('portal-prefix').textContent = `${window.location.host}/`;

    // Handle form submit
    const portalForm = document.getElementById('portal-form');
    const roomInput = document.getElementById('portal-room-input');
    const usernameInput = document.getElementById('portal-username-input');

    // Pre-populate username if already saved
    const savedUser = localStorage.getItem('syncanvas-username');
    if (savedUser) {
      usernameInput.value = savedUser;
    }
    
    // Focus appropriate input
    if (!roomInput.value) {
      roomInput.focus();
    } else {
      usernameInput.focus();
    }

    portalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const roomVal = roomInput.value.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-]/g, '').toLowerCase();
      const userVal = usernameInput.value.trim();

      if (roomVal && userVal) {
        // Store user login info
        localStorage.setItem('syncanvas-username', userVal);
        
        // Redirect
        window.location.href = `/${roomVal}`;
      }
    });

    return;
  }

  document.getElementById('doc-id').textContent = docId;

  // Initialize UI layout features
  initTheme();
  initDrawer();
  initShortcuts();

  showToast('Initializing collaborative session...', 'info', 2000);

  // Get or issue room token (we request admin role so rollback works for review)
  let token = sessionStorage.getItem(`syncanvas-token-${docId}`);
  if (!token) {
    try {
      const res = await fetch(`/api/token/${docId}?role=admin`);
      if (res.ok) {
        const data = await res.json();
        token = data.token;
        sessionStorage.setItem(`syncanvas-token-${docId}`, token);
      }
    } catch (e) {
      console.warn('Failed to fetch authentication token:', e);
    }
  }

  // Initialize Quill + Yjs binding
  const { provider, ydoc, quill } = await initEditor(docId);

  // Initialize Native Presence Cursors
  initPresence(provider, quill);

  // Initialize Offline IndexedDB Cache
  initOffline(docId, ydoc, provider);

  // Initialize Snapshots and Rollback UI
  initRollbackUI(docId, ydoc);

  // Initialize Live Network Jitter Simulation
  initDebugPanel(provider);

  // Initialize Collaborative Code Compiler
  initCompiler(provider, ydoc, quill, docId);

  // Initialize Collaborative Whiteboard
  initWhiteboard(provider, ydoc, docId);

  // Initialize Workspace Tab Switcher
  initWorkspaceTabs(quill);
}

// --- Workspace Tabs Navigation ---
function initWorkspaceTabs(quill) {
  const tabsContainer = document.getElementById('workspace-tabs');
  const tabPlainText = document.getElementById('tab-plain-text');
  const tabCodeCompiler = document.getElementById('tab-code-compiler');
  const tabWhiteboard = document.getElementById('tab-whiteboard');
  
  const notepadWorkspace = document.getElementById('notepad-workspace');
  const compilerWorkspace = document.getElementById('compiler-workspace');
  const whiteboardWorkspace = document.getElementById('whiteboard-workspace');

  if (!tabsContainer || !tabPlainText || !tabCodeCompiler || !tabWhiteboard ||
      !notepadWorkspace || !compilerWorkspace || !whiteboardWorkspace) return;

  // Show tabs container
  tabsContainer.hidden = false;

  const tabs = [
    { button: tabPlainText, pane: notepadWorkspace, onSelect: () => quill && quill.update() },
    { button: tabCodeCompiler, pane: compilerWorkspace, onSelect: () => window.codeMirrorInstance && window.codeMirrorInstance.refresh() },
    { button: tabWhiteboard, pane: whiteboardWorkspace, onSelect: () => {} }
  ];

  tabs.forEach(tabItem => {
    tabItem.button.addEventListener('click', () => {
      tabs.forEach(item => {
        if (item === tabItem) {
          item.button.classList.add('active');
          item.pane.style.display = 'flex';
          item.onSelect();
        } else {
          item.button.classList.remove('active');
          item.pane.style.display = 'none';
        }
      });
    });
  });
}

// Global error boundaries
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled Promise Rejection:', event.reason);
  showToast(`Unexpected failure: ${event.reason.message || event.reason}`, 'error', 6000);
});

init().catch(err => {
  console.error('Initialization failed:', err);
  showToast('SyncCanvas initialization failed. Please refresh your browser.', 'error', 10000);
});
