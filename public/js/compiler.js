import { showToast } from './app.js';
import * as Y from 'yjs';

const PISTON_API_URL = 'https://emkc.org/api/v2/piston/execute';

const LANGUAGE_CONFIGS = {
  python: { language: 'python', version: '3.10.0', mode: 'python' },
  cpp: { language: 'c++', version: '10.2.0', mode: 'text/x-c++src' },
  c: { language: 'c', version: '10.2.0', mode: 'text/x-csrc' },
  csharp: { language: 'csharp', version: '6.12.0', mode: 'text/x-csharp' },
  javascript: { language: 'javascript', version: '18.15.0', mode: 'javascript' }
};

let editorInstance = null;
let activeFile = null;
let openTabs = [];
let yfiles = null;
let ydocRef = null;
let currentObserveFn = null;
let currentChangeFn = null;
let currentTextObject = null;

/**
 * Helper to determine file icon matching extension
 */
function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  switch (ext) {
    case 'py': return '🐍';
    case 'js': return '🟨';
    case 'c': return '🇨';
    case 'cpp': return '➕';
    case 'cs': return '♯';
    default: return '📄';
  }
}

/**
 * Helper to determine mode from extension
 */
function getModeFromExtension(ext) {
  switch (ext) {
    case 'py': return 'python';
    case 'js': return 'javascript';
    case 'c': return 'text/x-csrc';
    case 'cpp':
    case 'h':
    case 'hpp':
      return 'text/x-c++src';
    case 'cs': return 'text/x-csharp';
    default: return 'javascript';
  }
}

/**
 * Gets extension for language dropdown selection
 */
function getLanguageExtension(lang) {
  switch (lang) {
    case 'python': return 'py';
    case 'cpp': return 'cpp';
    case 'c': return 'c';
    case 'csharp': return 'cs';
    case 'javascript': return 'js';
    default: return 'txt';
  }
}

/**
 * Initializes the collaborative Code Compiler workspace.
 * 
 * @param {object} provider - The y-websocket provider instance
 * @param {object} ydoc - The shared Y.Doc document
 * @param {object} quill - The active Quill editor instance (for size refreshes)
 */
export function initCompiler(provider, ydoc, quill, docId) {
  const codeTextarea = document.getElementById('code-textarea');
  if (!codeTextarea) return;

  ydocRef = ydoc;

  // 1. Initialize CodeMirror 5 editor
  const editor = window.CodeMirror.fromTextArea(codeTextarea, {
    lineNumbers: true,
    theme: 'dracula',
    mode: 'javascript',
    tabSize: 2,
    lineWrapping: true
  });
  editorInstance = editor;
  window.codeMirrorInstance = editor;

  // 2. Obtain Yjs Shared Types
  yfiles = ydoc.getMap('workspace_files');
  const ymeta = ydoc.getMap('metadata');
  const ycode = ydoc.getText('code'); // for backward compatibility/migration

  // 3. Migrate single-file code if yfiles is empty
  const languageDropdown = document.getElementById('compiler-language');
  const initialLang = languageDropdown?.value || 'javascript';
  
  if (yfiles.size === 0) {
    ydoc.transact(() => {
      const ext = getLanguageExtension(initialLang);
      const defaultName = `main.${ext}`;
      const defaultText = ycode.toString().trim() || `// Write your ${initialLang} code here...\n`;
      const fileText = new Y.Text();
      fileText.insert(0, defaultText);
      yfiles.set(defaultName, fileText);
    });
  }

  // Set default active file
  const filenames = Array.from(yfiles.keys());
  activeFile = filenames.includes(`main.${getLanguageExtension(initialLang)}`) 
    ? `main.${getLanguageExtension(initialLang)}` 
    : filenames[0];

  if (!openTabs.includes(activeFile)) {
    openTabs.push(activeFile);
  }

  // 4. Bind initial file
  bindFileToEditor(activeFile);

  // 5. Watch for dynamic remote file list modifications
  yfiles.observe((event) => {
    renderFileTree();
    renderTabs();

    // If active file was deleted, switch to another
    if (activeFile && !yfiles.has(activeFile)) {
      const remaining = Array.from(yfiles.keys());
      if (remaining.length > 0) {
        selectFile(remaining[0]);
      }
    }
  });

  // Render initial panels
  renderFileTree();
  renderTabs();

  // 6. Setup Language Selector Synchronization via Y.Map
  languageDropdown.addEventListener('change', () => {
    const selectedLang = languageDropdown.value;
    ymeta.set('language', selectedLang);

    // If active file is main.[old_ext], rename it to main.[new_ext]
    const currentExt = activeFile.split('.').pop();
    const newExt = getLanguageExtension(selectedLang);
    if (activeFile.startsWith('main.') && currentExt !== newExt) {
      const newName = `main.${newExt}`;
      renameFile(activeFile, newName);
    }
  });

  // Listen to remote changes of workspace compiler language
  ymeta.observe(() => {
    const remoteLanguage = ymeta.get('language') || 'javascript';
    if (languageDropdown.value !== remoteLanguage) {
      languageDropdown.value = remoteLanguage;
    }
  });

  // 7. Setup file creation listener
  const addFileBtn = document.getElementById('btn-add-file');
  addFileBtn.addEventListener('click', () => {
    const filename = prompt('Enter new file name (e.g. utils.py, data.js):');
    if (!filename) return;

    const cleanName = filename.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_\-\.]/g, '');
    if (!cleanName) {
      showToast('Invalid file name characters.', 'error');
      return;
    }

    if (yfiles.has(cleanName)) {
      showToast('File name already exists.', 'error');
      return;
    }

    ydoc.transact(() => {
      const fileText = new Y.Text();
      fileText.insert(0, '');
      yfiles.set(cleanName, fileText);
    });

    selectFile(cleanName);
  });

  // 8. Code Execution Controls
  const runBtn = document.getElementById('compiler-run-btn');
  const terminalConsole = document.getElementById('terminal-console');
  const stdinContainer = document.getElementById('stdin-container');
  const stdinWarningMsg = document.getElementById('stdin-warning-msg');
  const stdinTextarea = document.getElementById('compiler-stdin');

  function clearStdinWarning() {
    if (stdinContainer) stdinContainer.classList.remove('warning-highlight');
    if (stdinWarningMsg) stdinWarningMsg.style.display = 'none';
  }

  // Clear validation styling when user types or changes language
  stdinTextarea?.addEventListener('input', clearStdinWarning);
  languageDropdown?.addEventListener('change', clearStdinWarning);
  
  runBtn.addEventListener('click', async () => {
    const code = editor.getValue();
    const activeLang = languageDropdown.value;

    if (!code || !code.trim()) {
      showTerminalOutput('', 'Terminal Alert: No code script input provided to compile.', 'info');
      return;
    }

    let stdinValue = '';

    // Interactive Inline Terminal Prompt if active file expects input
    if (detectStdinExpectation(code, activeLang)) {
      runBtn.disabled = true;
      runBtn.innerHTML = `
        <svg class="animate-spin" style="width:14px;height:14px;border:2px solid transparent;border-top-color:#fff;border-radius:50%;display:inline-block;" viewBox="0 0 24 24"></svg>
        <span>Waiting for Input...</span>
      `;

      let inputs = null;
      const inputCount = Math.max(1, countStdinExpectations(code, activeLang));

      if (activeLang === 'python') {
        const pythonPrompts = extractPythonPrompts(code);
        if (pythonPrompts.length > 0) {
          inputs = await getTerminalInputs(pythonPrompts, false);
        } else {
          const cPrompts = extractCStylePrompts(code, activeLang);
          const prompts = [];
          for (let i = 0; i < inputCount; i++) {
            const customPrompt = cPrompts[i];
            prompts.push(customPrompt || `[stdin required] Enter value ${i + 1} for Python program:`);
          }
          inputs = await getTerminalInputs(prompts, false);
        }
      } else if (activeLang === 'javascript') {
        const jsPrompts = extractJsPrompts(code);
        if (jsPrompts.length > 0) {
          inputs = await getTerminalInputs(jsPrompts, false);
        } else {
          const cPrompts = extractCStylePrompts(code, activeLang);
          const prompts = [];
          for (let i = 0; i < inputCount; i++) {
            const customPrompt = cPrompts[i];
            prompts.push(customPrompt || `[stdin required] Enter value ${i + 1} for JavaScript program:`);
          }
          inputs = await getTerminalInputs(prompts, false);
        }
      } else {
        // C, C++, C#
        const langNames = { cpp: 'C++', c: 'C', csharp: 'C#' };
        const langName = langNames[activeLang] || activeLang;
        const cPrompts = extractCStylePrompts(code, activeLang);
        const prompts = [];
        for (let i = 0; i < inputCount; i++) {
          const customPrompt = cPrompts[i];
          prompts.push(customPrompt || `[stdin required] Enter value ${i + 1} for ${langName} program:`);
        }
        inputs = await getTerminalInputs(prompts, false);
      }

      runBtn.disabled = false;
      runBtn.innerHTML = '⚡ Run Code';

      if (inputs === null) {
        showTerminalOutput('', 'Execution Cancelled: Stdin inputs were not provided.', 'info');
        return;
      }

      stdinValue = inputs.join('\n');
      if (stdinTextarea) {
        stdinTextarea.value = stdinValue;
        stdinTextarea.dispatchEvent(new Event('input'));
      }
    }

    setTerminalRunning(true);
    clearStdinWarning();
    
    try {
      let result;
      if (activeLang === 'javascript') {
        result = await executeJavaScriptSandboxed(code, stdinValue);
      } else {
        // Compile all workspace files, passing active file first (entry point)
        const filesPayload = [];
        yfiles.forEach((ytext, filename) => {
          filesPayload.push({
            name: filename,
            content: filename === activeFile ? code : ytext.toString()
          });
        });

        // Sort activeFile to the front
        const activeIdx = filesPayload.findIndex(f => f.name === activeFile);
        if (activeIdx !== -1) {
          const [activeFileObj] = filesPayload.splice(activeIdx, 1);
          filesPayload.unshift(activeFileObj);
        }

        result = await executeRemoteCompilerMultiFile(filesPayload, activeLang, stdinValue);
      }

      if (result.success) {
        showTerminalOutput(result.stdout, '', 'stdout');
      } else {
        showTerminalOutput('', result.stderr || result.error, 'stderr');
      }
    } catch (err) {
      showTerminalOutput('', `Execution Error: ${err.message}`, 'stderr');
    } finally {
      setTerminalRunning(false);
    }
  });

  // Clear Terminal Controls
  const clearBtn = document.getElementById('terminal-clear-btn');
  clearBtn.addEventListener('click', () => {
    terminalConsole.innerHTML = '<div class="terminal-placeholder">Logs cleared. Click "Run Code" to compile and execute.</div>';
  });

  // Helper inside workspace toggler
  function setTerminalRunning(isRunning) {
    if (isRunning) {
      runBtn.disabled = true;
      runBtn.innerHTML = `
        <svg class="animate-spin" style="width:14px;height:14px;border:2px solid transparent;border-top-color:#fff;border-radius:50%;display:inline-block;" viewBox="0 0 24 24"></svg>
        <span>Running...</span>
      `;
      terminalConsole.innerHTML = '<div class="terminal-info">Compiling and staging virtual environment...</div>';
    } else {
      runBtn.disabled = false;
      runBtn.innerHTML = '⚡ Run Code';
    }
  }

  function showTerminalOutput(stdout, stderr, type) {
    terminalConsole.innerHTML = '';
    if (type === 'stdout') {
      const pre = document.createElement('pre');
      pre.className = 'terminal-stdout';
      pre.textContent = stdout || 'Script completed successfully with empty output buffer.';
      terminalConsole.appendChild(pre);
    } else if (type === 'stderr') {
      const isEofError = /EOFError|EndOfStream|EOF when reading|ios_base::failure/i.test(stderr);
      
      if (isEofError) {
        const friendlyDiv = document.createElement('div');
        friendlyDiv.style.background = 'rgba(239, 68, 68, 0.05)';
        friendlyDiv.style.border = '1px solid rgba(239, 68, 68, 0.15)';
        friendlyDiv.style.padding = '12px';
        friendlyDiv.style.borderRadius = '8px';
        friendlyDiv.style.marginBottom = '12px';
        friendlyDiv.style.lineHeight = '1.5';
        friendlyDiv.innerHTML = `
          <strong style="color: #ef4444; display: block; margin-bottom: 4px;">⚠️ Execution Crashed (Missing Inputs)</strong>
          <span>Your code attempted to read from standard input (stdin), but the Program Input panel was empty.</span>
          <div style="margin-top: 8px; color: var(--text-secondary); font-size: 0.8rem;">
            <strong>Tip:</strong> Type your input values inside the <strong>Program Input (stdin)</strong> panel on the right, and click <strong>Run Code</strong> again.
          </div>
          <button class="terminal-clear" style="margin-top: 12px; text-decoration: underline; display: block; font-weight: 500;" onclick="document.getElementById('raw-traceback').style.display='block'; this.style.display='none';">Show Technical Traceback</button>
        `;
        terminalConsole.appendChild(friendlyDiv);

        const pre = document.createElement('pre');
        pre.id = 'raw-traceback';
        pre.className = 'terminal-stderr';
        pre.style.display = 'none';
        pre.style.marginTop = '8px';
        pre.style.fontSize = '0.8rem';
        pre.textContent = stderr || 'Compilation / Runtime execution failed.';
        terminalConsole.appendChild(pre);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'terminal-stderr';
        pre.textContent = stderr || 'Compilation / Runtime execution failed.';
        terminalConsole.appendChild(pre);
      }
    } else if (type === 'warning-info') {
      const div = document.createElement('div');
      div.className = 'terminal-stderr';
      div.style.color = '#f59e0b';
      div.style.background = 'rgba(245, 158, 11, 0.05)';
      div.style.padding = '12px';
      div.style.borderRadius = '8px';
      div.style.border = '1px solid rgba(245, 158, 11, 0.1)';
      div.style.whiteSpace = 'pre-wrap';
      div.textContent = stderr;
      terminalConsole.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'terminal-info';
      div.textContent = stderr;
      terminalConsole.appendChild(div);
    }
  }

  // 9. Save Code Control
  const saveBtn = document.getElementById('compiler-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const originalText = saveBtn.innerHTML;
      saveBtn.innerHTML = '💾 Saving...';
      
      try {
        const response = await fetch(`/api/save-code/${docId}`, {
          method: 'POST'
        });
        const data = await response.json();
        if (data.ok) {
          showToast('All workspace files saved to server!', 'success', 3000);
        } else {
          showToast(`Save failed: ${data.error}`, 'error', 4000);
        }
      } catch (err) {
        showToast(`Save error: ${err.message}`, 'error', 4000);
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalText;
      }
    });
  }

  // 10. Download Code Control
  const downloadBtn = document.getElementById('compiler-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const codeText = window.codeMirrorInstance ? window.codeMirrorInstance.getValue() : '';
      
      const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = activeFile;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showToast(`Downloaded active file ${activeFile}!`, 'success', 3000);
    });
  }

  // 11. Stdin Synchronization via Yjs
  const ystdin = ydoc.getText('stdin');
  if (stdinTextarea) {
    let isSettingStdin = false;

    // Local changes to Yjs
    stdinTextarea.addEventListener('input', () => {
      if (isSettingStdin) return;
      const text = stdinTextarea.value;
      ydoc.transact(() => {
        ystdin.delete(0, ystdin.length);
        ystdin.insert(0, text);
      });
    });

    // Remote changes to textarea
    ystdin.observe((event) => {
      if (event.transaction.local) return;
      isSettingStdin = true;
      const val = ystdin.toString();
      if (stdinTextarea.value !== val) {
        stdinTextarea.value = val;
      }
      isSettingStdin = false;
    });
  }
}

/**
 * Bind CodeMirror to a specific file's Y.Text representation
 */
function bindFileToEditor(filename) {
  if (!yfiles || !yfiles.has(filename)) return;

  const ytext = yfiles.get(filename);

  // Unsubscribe old listeners
  if (currentChangeFn) {
    editorInstance.off('change', currentChangeFn);
  }
  if (currentObserveFn && currentTextObject) {
    currentTextObject.unobserve(currentObserveFn);
  }

  currentTextObject = ytext;

  // Swap content
  editorInstance.setValue(ytext.toString());

  // Set proper syntax mode highlight
  const ext = filename.split('.').pop().toLowerCase();
  editorInstance.setOption('mode', getModeFromExtension(ext));

  // local changes -> Yjs
  currentChangeFn = (instance, changeObj) => {
    if (changeObj.origin === 'setValue') return;

    const fromIndex = instance.indexFromPos(changeObj.from);
    const textRemoved = changeObj.removed.join('\n');
    const textAdded = changeObj.text.join('\n');

    ydocRef.transact(() => {
      if (textRemoved.length > 0) {
        ytext.delete(fromIndex, textRemoved.length);
      }
      if (textAdded.length > 0) {
        ytext.insert(fromIndex, textAdded);
      }
    });
  };
  editorInstance.on('change', currentChangeFn);

  // Yjs sync -> editor
  currentObserveFn = (event) => {
    if (event.transaction.local) return;

    // Apply granular deltas to preserve cursor position
    let index = 0;
    event.changes.delta.forEach((op) => {
      if (op.retain) {
        index += op.retain;
      } else if (op.insert) {
        const fromPos = editorInstance.posFromIndex(index);
        editorInstance.replaceRange(op.insert, fromPos, fromPos, 'setValue');
        index += op.insert.length;
      } else if (op.delete) {
        const fromPos = editorInstance.posFromIndex(index);
        const toPos = editorInstance.posFromIndex(index + op.delete);
        editorInstance.replaceRange('', fromPos, toPos, 'setValue');
      }
    });
  };
  ytext.observe(currentObserveFn);
}

/**
 * Selection helper
 */
function selectFile(filename) {
  if (activeFile === filename) return;
  activeFile = filename;
  if (!openTabs.includes(filename)) {
    openTabs.push(filename);
  }
  bindFileToEditor(filename);
  renderFileTree();
  renderTabs();
}

/**
 * Rename workspace file
 */
function renameFile(oldName, newName) {
  if (!newName || oldName === newName) return;
  const cleanName = newName.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!cleanName) {
    showToast('Invalid file name.', 'error');
    return;
  }

  if (yfiles.has(cleanName)) {
    showToast('File already exists.', 'error');
    return;
  }

  ydocRef.transact(() => {
    const oldText = yfiles.get(oldName);
    const newText = new Y.Text();
    newText.insert(0, oldText.toString());
    yfiles.set(cleanName, newText);
    yfiles.delete(oldName);
  });

  // Switch tab target
  openTabs = openTabs.map(t => t === oldName ? cleanName : t);
  if (activeFile === oldName) {
    activeFile = cleanName;
    bindFileToEditor(cleanName);
  }

  renderFileTree();
  renderTabs();
  showToast(`Renamed ${oldName} to ${cleanName}`, 'success');
}

/**
 * Delete workspace file
 */
function deleteFile(filename) {
  if (yfiles.size <= 1) {
    showToast('Cannot delete the last remaining file.', 'warning');
    return;
  }

  if (!confirm(`Are you sure you want to delete "${filename}"?`)) return;

  ydocRef.transact(() => {
    yfiles.delete(filename);
  });

  openTabs = openTabs.filter(t => t !== filename);
  if (activeFile === filename) {
    const remaining = Array.from(yfiles.keys());
    selectFile(remaining[0]);
  } else {
    renderFileTree();
    renderTabs();
  }
  showToast(`Deleted ${filename}`, 'info');
}

/**
 * Close tab helper
 */
function closeTab(filename) {
  openTabs = openTabs.filter(t => t !== filename);
  if (activeFile === filename) {
    if (openTabs.length > 0) {
      selectFile(openTabs[0]);
    } else {
      const remaining = Array.from(yfiles.keys());
      selectFile(remaining[0]);
    }
  } else {
    renderTabs();
  }
}

/**
 * Redraw file tree DOM elements
 */
function renderFileTree() {
  const fileList = document.getElementById('ide-file-list');
  if (!fileList) return;
  fileList.innerHTML = '';

  const filenames = Array.from(yfiles.keys()).sort();
  filenames.forEach(filename => {
    const li = document.createElement('li');
    li.className = `file-item ${filename === activeFile ? 'active' : ''}`;

    const left = document.createElement('div');
    left.className = 'file-item-left';

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = getFileIcon(filename);
    left.appendChild(icon);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = filename;
    left.appendChild(nameSpan);

    li.appendChild(left);

    // Actions block
    const actions = document.createElement('div');
    actions.className = 'file-item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'file-action-btn';
    editBtn.innerHTML = '✏️';
    editBtn.title = 'Rename File';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = prompt(`Rename "${filename}" to:`, filename);
      if (newName) renameFile(filename, newName);
    });
    actions.appendChild(editBtn);

    if (filenames.length > 1) {
      const delBtn = document.createElement('button');
      delBtn.className = 'file-action-btn';
      delBtn.innerHTML = '🗑️';
      delBtn.title = 'Delete File';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteFile(filename);
      });
      actions.appendChild(delBtn);
    }

    li.appendChild(actions);

    li.addEventListener('click', () => {
      selectFile(filename);
    });

    fileList.appendChild(li);
  });
}

/**
 * Redraw open file tabs
 */
function renderTabs() {
  const tabsBar = document.getElementById('ide-tabs-bar');
  if (!tabsBar) return;
  tabsBar.innerHTML = '';

  openTabs.forEach(filename => {
    if (!yfiles.has(filename)) return; // safety check

    const tab = document.createElement('div');
    tab.className = `ide-tab ${filename === activeFile ? 'active' : ''}`;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = filename;
    tab.appendChild(nameSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ide-tab-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(filename);
    });
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => {
      selectFile(filename);
    });

    tabsBar.appendChild(tab);
  });
}

/**
 * Execute JS inside client-side sandboxed iframe
 */
function executeJavaScriptSandboxed(code, stdin = '') {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.setAttribute('sandbox', 'allow-scripts');
    
    const executionTimeout = setTimeout(() => {
      cleanup();
      resolve({ success: false, error: 'Timeout Error: JavaScript execution timed out (4000ms).' });
    }, 4000);

    const logs = [];
    const messageListener = (event) => {
      if (!event.data || typeof event.data !== 'object') return;
      const { type, val, error } = event.data;

      if (type === 'log') {
        logs.push(val);
      } else if (type === 'error') {
        cleanup();
        resolve({ success: false, stderr: error || 'Runtime Error' });
      } else if (type === 'done') {
        cleanup();
        resolve({ success: true, stdout: logs.join('\n') });
      }
    };

    window.addEventListener('message', messageListener);
    
    function cleanup() {
      clearTimeout(executionTimeout);
      window.removeEventListener('message', messageListener);
      if (document.body.contains(iframe)) {
        document.body.removeChild(iframe);
      }
    }

    const stdinLines = stdin ? stdin.split('\n') : [];

    const sandboxHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <script>
            (function() {
              const stdinLines = ${JSON.stringify(stdinLines)};
              let stdinIndex = 0;

              window.console.log = function(...args) {
                const formatted = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
                window.parent.postMessage({ type: 'log', val: formatted }, '*');
              };

              window.prompt = function(message) {
                if (stdinIndex < stdinLines.length) {
                  const input = stdinLines[stdinIndex++];
                  window.console.log("[stdin prompt]: " + (message || "") + " -> " + input);
                  return input;
                }
                window.console.log("[stdin prompt]: " + (message || "") + " -> [EOF / Empty Input]");
                return null;
              };

              window.onerror = function(message, source, lineno, colno, error) {
                window.parent.postMessage({ type: 'error', error: message + ' (Line ' + lineno + ':' + colno + ')' }, '*');
                return true;
              };

              window.onload = function() {
                try {
                  (function() { ${code} })();
                  window.parent.postMessage({ type: 'done' }, '*');
                } catch (err) {
                  window.parent.postMessage({ type: 'error', error: err.message }, '*');
                }
              };
            })();
          </script>
        </head>
        <body></body>
      </html>
    `;

    iframe.srcdoc = sandboxHtml;
    document.body.appendChild(iframe);
  });
}

/**
 * Execute Python/C/C++/C# code via backend Wandbox proxy with multi-file support
 */
async function executeRemoteCompilerMultiFile(files, language, stdin = '') {
  const config = LANGUAGE_CONFIGS[language];
  if (!config) return { success: false, error: `Language configuration missing for: ${language}` };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 16000);

  try {
    const payload = {
      language: config.language,
      version: config.version,
      files: files,
      stdin: stdin
    };

    const response = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Compiler API error status ${response.status}`);
    }

    const resData = await response.json();
    if (!resData.ok) {
      throw new Error(resData.error || 'Compilation proxy failed');
    }
    
    const data = resData.data;
    const runResult = data.run;
    const stdout = runResult.stdout || '';
    const stderr = runResult.stderr || '';
    const codeStatus = runResult.code;

    if (stderr || codeStatus !== 0) {
      return { success: false, stderr: stderr || `Exit Code: ${codeStatus}`, stdout };
    }
    return { success: true, stdout };

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Compiler run error:', err);
    return {
      success: false,
      error: err.name === 'AbortError' 
        ? 'Connection Timeout: Wandbox compiler proxy did not respond in 16 seconds.'
        : `Execution Connection Failed: ${err.message}`
    };
  }
}

/**
 * Strip comments from code to avoid false positives in detection and extraction.
 */
function cleanComments(code, language) {
  if (!code) return '';
  if (language === 'python') {
    return code.replace(/#.*$/gm, '');
  }
  return code.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
}

/**
 * Extract prompt strings from python input("prompt") calls.
 */
function extractPythonPrompts(code) {
  const cleanCode = cleanComments(code, 'python');
  const prompts = [];
  const regex = /input\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;
  let match;
  while ((match = regex.exec(cleanCode)) !== null && prompts.length < 10) {
    let p = match[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'");
    prompts.push(p);
  }
  return prompts;
}

/**
 * Extract prompt strings from javascript prompt("prompt") calls.
 */
function extractJsPrompts(code) {
  const cleanCode = cleanComments(code, 'javascript');
  const prompts = [];
  const regex = /prompt\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;
  let match;
  while ((match = regex.exec(cleanCode)) !== null && prompts.length < 10) {
    let p = match[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'");
    prompts.push(p);
  }
  return prompts;
}

/**
 * Lightweight helper to detect if a source code string likely expects standard inputs.
 */
function detectStdinExpectation(code, language) {
  if (!code) return false;
  const cleanCode = cleanComments(code, language);

  switch (language) {
    case 'python':
      return /input\s*\(|sys\.stdin/.test(cleanCode);
    case 'cpp':
    case 'c':
      return /std::cin|cin\s*>>|scanf\s*\(|gets\s*\(|fgets\s*\(\s*[a-zA-Z0-9_]+,\s*[a-zA-Z0-9_]+,\s*stdin\)/.test(cleanCode);
    case 'csharp':
      return /Console\.ReadLine|Console\.Read/.test(cleanCode);
    case 'javascript':
      return /prompt\s*\(|readline|process\.stdin/.test(cleanCode);
    default:
      return false;
  }
}

/**
 * Counts how many standard input operations are statically expected in the code.
 */
function countStdinExpectations(code, language) {
  if (!code) return 0;
  const cleanCode = cleanComments(code, language);
  let count = 0;
  
  if (language === 'c' || language === 'cpp') {
    const scanfRegex = /scanf\s*\(/g;
    const cinRegex = /cin\s*>>/g;
    const stdCinRegex = /std::cin/g;
    const getsRegex = /gets\s*\(/g;
    const fgetsRegex = /fgets\s*\(\s*[a-zA-Z0-9_]+,\s*[a-zA-Z0-9_]+,\s*stdin\)/g;
    
    count += (cleanCode.match(scanfRegex) || []).length;
    count += (cleanCode.match(cinRegex) || []).length;
    count += (cleanCode.match(stdCinRegex) || []).length;
    count += (cleanCode.match(getsRegex) || []).length;
    count += (cleanCode.match(fgetsRegex) || []).length;
  } else if (language === 'csharp') {
    const readLineRegex = /Console\.ReadLine\s*\(/g;
    const readRegex = /Console\.Read\s*\(/g;
    
    count += (cleanCode.match(readLineRegex) || []).length;
    count += (cleanCode.match(readRegex) || []).length;
  } else if (language === 'python') {
    const inputRegex = /input\s*\(/g;
    const stdinRegex = /sys\.stdin/g;
    
    count += (cleanCode.match(inputRegex) || []).length;
    count += (cleanCode.match(stdinRegex) || []).length;
  } else if (language === 'javascript') {
    const promptRegex = /prompt\s*\(/g;
    const readlineRegex = /readline/g;
    const stdinRegex = /process\.stdin/g;
    
    count += (cleanCode.match(promptRegex) || []).length;
    count += (cleanCode.match(readlineRegex) || []).length;
    count += (cleanCode.match(stdinRegex) || []).length;
  }
  
  return count;
}

/**
 * Extracts printing prompts that statically precede input operations.
 */
function extractCStylePrompts(code, language) {
  if (!code) return [];
  const cleanCode = cleanComments(code, language);
  
  let printRegex;
  let inputRegex;
  
  if (language === 'c' || language === 'cpp') {
    printRegex = /(?:std::)?cout\s*<<\s*(["'])([\s\S]*?)\1|printf\s*\(\s*(["'])([\s\S]*?)\3\s*(?:,[^)]*)?\)|puts\s*\(\s*(["'])([\s\S]*?)\5\s*\)/g;
    inputRegex = /scanf\s*\(|cin\s*>>|std::cin|gets\s*\(|fgets\s*\(\s*[a-zA-Z0-9_]+,\s*[a-zA-Z0-9_]+,\s*stdin\)/g;
  } else if (language === 'csharp') {
    printRegex = /Console\.(?:Write|WriteLine)\s*\(\s*(["'])([\s\S]*?)\1\s*(?:,[^)]*)?\)/g;
    inputRegex = /Console\.ReadLine|Console\.Read/g;
  } else if (language === 'python') {
    printRegex = /print\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;
    inputRegex = /input\s*\(|sys\.stdin/g;
  } else if (language === 'javascript') {
    printRegex = /(?:console\.log|alert)\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;
    inputRegex = /prompt\s*\(|readline|process\.stdin/g;
  } else {
    return [];
  }

  const elements = [];
  let match;
  
  while ((match = printRegex.exec(cleanCode)) !== null) {
    const text = match[2] || match[4] || match[6] || match[0];
    const cleanText = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
    if (cleanText) {
      elements.push({ type: 'print', index: match.index, text: cleanText });
    }
  }
  
  while ((match = inputRegex.exec(cleanCode)) !== null) {
    elements.push({ type: 'input', index: match.index });
  }
  
  elements.sort((a, b) => a.index - b.index);
  
  const inputPrompts = [];
  let lastPrintText = null;
  
  for (const el of elements) {
    if (el.type === 'print') {
      lastPrintText = el.text;
    } else if (el.type === 'input') {
      if (lastPrintText !== null) {
        inputPrompts.push(lastPrintText);
        lastPrintText = null;
      } else {
        inputPrompts.push(null);
      }
    }
  }
  
  return inputPrompts;
}

/**
 * Simple HTML escaping helper.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Dynamically displays a modern overlay modal to collect program inputs.
 */
function showCustomInputModal(prompts, title, isMultiLine = false) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'custom-prompt-modal-overlay';
    
    let fieldsHtml = '';
    if (isMultiLine) {
      fieldsHtml = `
        <div class="custom-prompt-field">
          <label class="custom-prompt-label">${escapeHtml(prompts[0])}</label>
          <textarea class="custom-prompt-textarea" id="prompt-input-area" placeholder="Enter input values here (separate multiple lines with newlines)..." rows="4"></textarea>
        </div>
      `;
    } else {
      prompts.forEach((promptText, index) => {
        fieldsHtml += `
          <div class="custom-prompt-field">
            <label class="custom-prompt-label">${escapeHtml(promptText)}</label>
            <input type="text" class="custom-prompt-input" id="prompt-input-${index}" autocomplete="off" required />
          </div>
        `;
      });
    }

    modal.innerHTML = `
      <div class="custom-prompt-card">
        <div class="custom-prompt-header">
          <span class="custom-prompt-title">⚡ ${escapeHtml(title)}</span>
        </div>
        <form id="custom-prompt-form">
          <div class="custom-prompt-body">
            ${fieldsHtml}
          </div>
          <div class="custom-prompt-actions">
            <button type="submit" class="btn btn-primary">Submit Inputs</button>
            <button type="button" class="btn btn-ghost" id="custom-prompt-cancel">Cancel</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(modal);

    const focusEl = isMultiLine ? modal.querySelector('#prompt-input-area') : modal.querySelector('#prompt-input-0');
    if (focusEl) {
      setTimeout(() => focusEl.focus(), 50);
    }

    const form = modal.querySelector('#custom-prompt-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (isMultiLine) {
        const value = modal.querySelector('#prompt-input-area').value;
        cleanup();
        resolve([value]);
      } else {
        const values = [];
        prompts.forEach((_, index) => {
          const inputVal = modal.querySelector(`#prompt-input-${index}`).value;
          values.push(inputVal);
        });
        cleanup();
        resolve(values);
      }
    });

    const cancelBtn = modal.querySelector('#custom-prompt-cancel');
    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    function cleanup() {
      window.removeEventListener('keydown', handleKeyDown);
      if (document.body.contains(modal)) {
        document.body.removeChild(modal);
      }
    }
  });
}

/**
 * Prompts the user inline inside the Terminal Console for standard inputs.
 */
function getTerminalInputs(prompts, isMultiLine = false) {
  return new Promise((resolve) => {
    const terminalConsole = document.getElementById('terminal-console');
    if (!terminalConsole) return resolve(null);

    // Clear logs for input collection
    terminalConsole.innerHTML = '';

    const inputs = [];
    let currentPromptIndex = 0;

    function renderNextPrompt() {
      const containerDiv = document.createElement('div');
      containerDiv.className = 'terminal-prompt-container';

      const label = document.createElement('div');
      label.className = 'terminal-prompt-label';
      label.style.color = '#3b82f6';
      label.style.fontWeight = 'bold';
      
      if (isMultiLine) {
        label.textContent = `[stdin required] Enter line ${inputs.length + 1} (leave empty and press Enter to run):`;
      } else {
        label.textContent = prompts[currentPromptIndex];
      }
      containerDiv.appendChild(label);

      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'terminal-input-wrapper';
      inputWrapper.style.display = 'flex';
      inputWrapper.style.alignItems = 'center';
      inputWrapper.style.marginTop = '4px';

      const promptChar = document.createElement('span');
      promptChar.className = 'terminal-prompt-char';
      promptChar.style.color = '#10b981';
      promptChar.style.marginRight = '8px';
      promptChar.style.fontWeight = 'bold';
      promptChar.textContent = '>';
      inputWrapper.appendChild(promptChar);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'terminal-inline-input';
      inputWrapper.appendChild(input);

      containerDiv.appendChild(inputWrapper);
      terminalConsole.appendChild(containerDiv);
      
      terminalConsole.scrollTop = terminalConsole.scrollHeight;
      input.focus();

      // Ensure click on terminal re-focuses the input
      const clickHandler = () => input.focus();
      terminalConsole.addEventListener('click', clickHandler);

      function cleanupListeners() {
        terminalConsole.removeEventListener('click', clickHandler);
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          cleanupListeners();
          const val = input.value;
          
          // Replace input element with static text
          inputWrapper.removeChild(input);
          const valSpan = document.createElement('span');
          valSpan.style.color = '#10b981';
          valSpan.textContent = val;
          inputWrapper.appendChild(valSpan);

          if (isMultiLine) {
            if (val === '') {
              // Pressing empty Enter ends multi-line collection
              resolve(inputs);
            } else {
              inputs.push(val);
              renderNextPrompt();
            }
          } else {
            inputs.push(val);
            currentPromptIndex++;
            if (currentPromptIndex < prompts.length) {
              renderNextPrompt();
            } else {
              resolve(inputs);
            }
          }
        } else if (e.key === 'Escape') {
          cleanupListeners();
          resolve(null);
        }
      });
    }

    renderNextPrompt();
  });
}
