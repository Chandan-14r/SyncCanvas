import { showToast } from './app.js';

const PISTON_API_URL = 'https://emkc.org/api/v2/piston/execute';

const LANGUAGE_CONFIGS = {
  python: { language: 'python', version: '3.10.0', mode: 'python' },
  cpp: { language: 'c++', version: '10.2.0', mode: 'text/x-c++src' },
  c: { language: 'c', version: '10.2.0', mode: 'text/x-csrc' },
  csharp: { language: 'csharp', version: '6.12.0', mode: 'text/x-csharp' },
  javascript: { language: 'javascript', version: '18.15.0', mode: 'javascript' }
};

let editorInstance = null;

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
  const ycode = ydoc.getText('code');
  const ymeta = ydoc.getMap('metadata');

  // 3. Bind CodeMirror to Yjs for real-time collaboration
  let isSettingValue = false;

  // Update Yjs from CodeMirror inputs
  editor.on('change', (instance, changeObj) => {
    if (changeObj.origin === 'setValue') return;

    const fromIndex = instance.indexFromPos(changeObj.from);
    const textRemoved = changeObj.removed.join('\n');
    const textAdded = changeObj.text.join('\n');

    ydoc.transact(() => {
      if (textRemoved.length > 0) {
        ycode.delete(fromIndex, textRemoved.length);
      }
      if (textAdded.length > 0) {
        ycode.insert(fromIndex, textAdded);
      }
    });
  });

  // Update CodeMirror from Yjs sync events
  ycode.observe((event) => {
    if (event.transaction.local) return;

    isSettingValue = true;
    let index = 0;
    
    event.changes.delta.forEach((op) => {
      if (op.retain) {
        index += op.retain;
      } else if (op.insert) {
        const fromPos = editor.posFromIndex(index);
        editor.replaceRange(op.insert, fromPos, fromPos, 'setValue');
        index += op.insert.length;
      } else if (op.delete) {
        const fromPos = editor.posFromIndex(index);
        const toPos = editor.posFromIndex(index + op.delete);
        editor.replaceRange('', fromPos, toPos, 'setValue');
      }
    });
    isSettingValue = false;
  });

  // 4. Setup Language Selector Synchronization via Y.Map
  const languageDropdown = document.getElementById('compiler-language');
  
  languageDropdown.addEventListener('change', () => {
    const selectedLang = languageDropdown.value;
    ymeta.set('language', selectedLang);
  });

  // Listen to remote changes of editor language syntax
  ymeta.observe(() => {
    const remoteLanguage = ymeta.get('language') || 'javascript';
    if (languageDropdown.value !== remoteLanguage) {
      languageDropdown.value = remoteLanguage;
    }
    updateEditorMode(remoteLanguage);
  });

  function updateEditorMode(lang) {
    const config = LANGUAGE_CONFIGS[lang];
    if (config) {
      editor.setOption('mode', config.mode);
    }
  }

  // 5. Code Execution Controls
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

    // Interactive Inline Terminal Prompt if code expects input
    if (detectStdinExpectation(code, activeLang)) {
      runBtn.disabled = true;
      runBtn.innerHTML = `
        <svg class="animate-spin" style="width:14px;height:14px;border:2px solid transparent;border-top-color:#fff;border-radius:50%;display:inline-block;" viewBox="0 0 24 24"></svg>
        <span>Waiting for Input...</span>
      `;

      let inputs = null;
      if (activeLang === 'python') {
        const pythonPrompts = extractPythonPrompts(code);
        if (pythonPrompts.length > 0) {
          inputs = await getTerminalInputs(pythonPrompts, false);
        } else {
          inputs = await getTerminalInputs(
            ["This Python code expects standard input. Please enter your values:"], 
            true
          );
        }
      } else if (activeLang === 'javascript') {
        const jsPrompts = extractJsPrompts(code);
        if (jsPrompts.length > 0) {
          inputs = await getTerminalInputs(jsPrompts, false);
        } else {
          inputs = await getTerminalInputs(
            ["This JavaScript code expects standard input. Please enter your values:"], 
            true
          );
        }
      } else {
        // C, C++, C#
        const langNames = { cpp: 'C++', c: 'C', csharp: 'C#' };
        const langName = langNames[activeLang] || activeLang;
        inputs = await getTerminalInputs(
          [`This ${langName} program expects standard input (stdin).`], 
          true
        );
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
        result = await executeRemoteCompiler(code, activeLang, stdinValue);
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

  // 6. Save Code Control
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
          showToast('Code saved successfully to database!', 'success', 3000);
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

  // 6.5 Download Code Control
  const downloadBtn = document.getElementById('compiler-download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const codeText = window.codeMirrorInstance ? window.codeMirrorInstance.getValue() : '';
      const activeLang = document.getElementById('compiler-language')?.value || 'javascript';
      
      let fileExt = 'js';
      if (activeLang === 'python') fileExt = 'py';
      else if (activeLang === 'cpp') fileExt = 'cpp';
      else if (activeLang === 'c') fileExt = 'c';
      else if (activeLang === 'csharp') fileExt = 'cs';

      const blob = new Blob([codeText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `code_${docId}.${fileExt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showToast(`Code downloaded successfully as code_${docId}.${fileExt}!`, 'success', 3000);
    });
  }

  // 7. Stdin Synchronization via Yjs
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
 * Execute JS inside a secure client iframe sandbox.
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
 * Execute Python/C/C++/C# code via EMKC Piston Compilation API.
 */
async function executeRemoteCompiler(code, language, stdin = '') {
  const config = LANGUAGE_CONFIGS[language];
  if (!config) return { success: false, error: `Language configuration missing for: ${language}` };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 16000);

  try {
    const getFileName = (lang) => {
      switch (lang) {
        case 'cpp': return 'main.cpp';
        case 'c': return 'main.c';
        case 'csharp': return 'main.cs';
        case 'python': return 'main.py';
        default: return 'main.txt';
      }
    };

    const payload = {
      language: config.language,
      version: config.version,
      files: [{ name: getFileName(language), content: code }],
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
      const promptDiv = document.createElement('div');
      promptDiv.className = 'terminal-prompt-line';

      const label = document.createElement('span');
      label.style.color = '#3b82f6';
      label.style.fontWeight = 'bold';
      
      if (isMultiLine) {
        label.textContent = `[stdin required] Enter line ${inputs.length + 1} (leave empty and press Enter to run): `;
      } else {
        label.textContent = prompts[currentPromptIndex];
      }
      promptDiv.appendChild(label);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'terminal-inline-input';
      promptDiv.appendChild(input);

      terminalConsole.appendChild(promptDiv);
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
          promptDiv.removeChild(input);
          const valSpan = document.createElement('span');
          valSpan.style.color = '#10b981';
          valSpan.textContent = val;
          promptDiv.appendChild(valSpan);

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
