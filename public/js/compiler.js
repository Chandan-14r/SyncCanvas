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
export function initCompiler(provider, ydoc, quill) {
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
  
  runBtn.addEventListener('click', async () => {
    const code = editor.getValue();
    const activeLang = languageDropdown.value;

    if (!code || !code.trim()) {
      showTerminalOutput('', 'Terminal Alert: No code script input provided to compile.', 'info');
      return;
    }

    setTerminalRunning(true);
    
    try {
      let result;
      if (activeLang === 'javascript') {
        result = await executeJavaScriptSandboxed(code);
      } else {
        result = await executeRemoteCompiler(code, activeLang);
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
      const pre = document.createElement('pre');
      pre.className = 'terminal-stderr';
      pre.textContent = stderr || 'Compilation / Runtime execution failed.';
      terminalConsole.appendChild(pre);
    } else {
      const div = document.createElement('div');
      div.className = 'terminal-info';
      div.textContent = stderr;
      terminalConsole.appendChild(div);
    }
  }
}

/**
 * Execute JS inside a secure client iframe sandbox.
 */
function executeJavaScriptSandboxed(code) {
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
      document.body.removeChild(iframe);
    }

    const sandboxHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <script>
            window.console.log = function(...args) {
              const formatted = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
              window.parent.postMessage({ type: 'log', val: formatted }, '*');
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
          </script>
        </head>
        <body></body>
      </html>
    `;

    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(sandboxHtml);
    doc.close();
  });
}

/**
 * Execute Python/C/C++/C# code via EMKC Piston Compilation API.
 */
async function executeRemoteCompiler(code, language) {
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
      files: [{ name: getFileName(language), content: code }]
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
