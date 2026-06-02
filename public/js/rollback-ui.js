const DOMPurify = window.DOMPurify;

// Handlers for checkpoints lists and admin rollback previews

let selectedCheckpointSeq = null;

export function initRollbackUI(docId) {
  loadCheckpoints(docId);

  // Bind preview buttons
  document.getElementById('cancel-rollback')?.addEventListener('click', closePreview);
  document.getElementById('confirm-rollback')?.addEventListener('click', () => triggerRollback(docId));

  // Auto-refresh checkpoints lists every 30s
  setInterval(() => loadCheckpoints(docId), 30000);
}

async function loadCheckpoints(docId) {
  try {
    const response = await fetch(`/api/checkpoints/${docId}`);
    if (!response.ok) throw new Error('Checkpoints load failed');
    const data = await response.json();
    renderCheckpointsList(data.checkpoints || [], docId);
  } catch (err) {
    console.error('[RollbackUI] Error loading checkpoints:', err);
  }
}

function renderCheckpointsList(checkpoints, docId) {
  const listContainer = document.getElementById('checkpoint-list');
  if (!listContainer) return;

  if (!checkpoints || checkpoints.length === 0) {
    listContainer.innerHTML = '<div class="empty-state">No checkpoints saved yet. Checkpoints are automatically generated as you edit.</div>';
    return;
  }

  // Render recent checkpoints descending
  listContainer.innerHTML = checkpoints.map(cp => {
    const relativeTime = formatRelativeTime(cp.timestamp);
    const byteSize = formatBytes(cp.byteSize);
    return `
      <div class="checkpoint-item">
        <div class="checkpoint-info">
          <span class="checkpoint-time">Checkpoint #${cp.sequence} (${relativeTime})</span>
          <span class="checkpoint-meta">Size: ${byteSize} • Edits accumulated: ${cp.updateCount || 0}</span>
        </div>
        <button class="btn btn-ghost preview-checkpoint-btn" data-sequence="${cp.sequence}">
          Preview Checkpoint
        </button>
      </div>
    `;
  }).join('');

  // Attach preview events
  listContainer.querySelectorAll('.preview-checkpoint-btn').forEach(button => {
    button.addEventListener('click', (e) => {
      const seq = parseInt(e.target.dataset.sequence);
      previewCheckpoint(docId, seq);
    });
  });
}

async function previewCheckpoint(docId, sequence) {
  selectedCheckpointSeq = sequence;
  
  const modal = document.getElementById('rollback-preview');
  const timestampSpan = document.getElementById('preview-timestamp');
  const previewBox = document.getElementById('preview-content');

  timestampSpan.textContent = `Loading Checkpoint #${sequence}...`;
  previewBox.innerHTML = '<div style="opacity: 0.5; text-align: center;">Fetching snapshot binary content...</div>';
  modal.hidden = false;

  try {
    // We request the read-only preview HTML representing the state at checkpoint sequence
    const response = await fetch(`/api/checkpoints/${docId}/${sequence}/preview`);
    if (!response.ok) throw new Error('Preview fetch failed');
    const data = await response.json();
    
    // Safety check: sanitize html preview contents using DOMPurify
    const cleanHtml = DOMPurify.sanitize(data.html || '<p><i>No content in checkpoint</i></p>');
    previewBox.innerHTML = cleanHtml;
    timestampSpan.textContent = `Checkpoint #${sequence} (${formatRelativeTime(data.timestamp)})`;
  } catch (err) {
    console.error('[RollbackUI] Error loading preview:', err);
    previewBox.innerHTML = `<div style="color: var(--color-offline); text-align: center;">Failed to generate content preview. You can still confirm restore if needed.</div>`;
    timestampSpan.textContent = `Checkpoint #${sequence}`;
  }
}

async function triggerRollback(docId) {
  if (!selectedCheckpointSeq) return;

  window.showToast?.('Initiating restoration...', 'info', 2000);

  const token = sessionStorage.getItem(`syncanvas-token-${docId}`);
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`/api/rollback/${docId}/${selectedCheckpointSeq}`, {
      method: 'POST',
      headers: headers
    });

    if (response.ok) {
      window.showToast?.('Restoration completed successfully! Reloading session...', 'success', 3000);
      closePreview();
      // Reload current room session to reload clean document State from websocket server
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Restore failed');
    }
  } catch (err) {
    console.error('[RollbackUI] Error during rollback:', err);
    window.showToast?.(`Restoration failed: ${err.message}`, 'error', 5000);
  }
}

function closePreview() {
  const modal = document.getElementById('rollback-preview');
  if (modal) modal.hidden = true;
  selectedCheckpointSeq = null;
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
