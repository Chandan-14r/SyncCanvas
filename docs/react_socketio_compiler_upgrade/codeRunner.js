/**
 * Code Execution Utility for SyncCanvas Code Compiler.
 * Supports:
 * - JavaScript: Local sandboxed iframe execution with stdin prompt shim
 * - Python / C++ / C / C#: Remote execution via backend proxy `/api/compile` to Wandbox/Piston
 */

const COMPILE_API_URL = '/api/compile';

// Mapping local language names to backend/compiler payload specifications
const LANGUAGE_CONFIGS = {
  python: { language: 'python', version: '3.10.0' },
  cpp: { language: 'c++', version: '10.2.0' },
  c: { language: 'c', version: '10.2.0' },
  csharp: { language: 'csharp', version: '6.12.0' },
  javascript: { language: 'javascript', version: '18.15.0' }
};

/**
 * Execute script code based on active language.
 * 
 * @param {string} code - The source code to run
 * @param {string} language - Target language ('javascript', 'python', 'cpp', 'c', 'csharp')
 * @param {string} stdin - Standard input string for program
 * @returns {Promise<{ success: boolean, output: string, error: string }>}
 */
export async function executeCode(code, language, stdin = '') {
  if (!code || !code.trim()) {
    return {
      success: false,
      output: '',
      error: 'Terminal: No code input provided. Execution bypassed.'
    };
  }

  if (language === 'javascript') {
    return runJavaScriptSandboxed(code, stdin);
  } else {
    return runRemoteCompiler(code, language, stdin);
  }
}

/**
 * Run JavaScript inside a secure sandboxed iframe to capture logs.
 * Includes a synchronous mock implementation of window.prompt to read lines of stdin.
 */
function runJavaScriptSandboxed(code, stdin) {
  return new Promise((resolve) => {
    // 1. Create a hidden, sandboxed iframe
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    
    // allow-scripts is required to run the js code, but missing allow-same-origin 
    // prevents it from accessing parent window, DOM, localStorage, cookies, etc.
    iframe.setAttribute('sandbox', 'allow-scripts');
    
    // 2. Set up communication timeout (prevent infinite loops in user code)
    const executionTimeout = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        output: '',
        error: 'Execution Timeout: Code took longer than 4000ms to execute. Potential infinite loop detected.'
      });
    }, 4000);

    // Array to hold console logs
    const logs = [];

    // Message listener to receive outputs from inside the sandbox
    const messageListener = (event) => {
      if (!event.data || typeof event.data !== 'object') return;
      
      const { type, val, error } = event.data;

      if (type === 'log') {
        logs.push(val);
      } else if (type === 'error') {
        cleanup();
        resolve({
          success: false,
          output: logs.join('\n'),
          error: error || 'Runtime Error'
        });
      } else if (type === 'done') {
        cleanup();
        resolve({
          success: true,
          output: logs.join('\n') || 'Script executed successfully with no console logs.',
          error: ''
        });
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

    // Split stdin by lines for consumption by the prompt mock
    const stdinLines = stdin ? stdin.split('\n') : [];

    // 3. Inject script code wrapping console and executing inside sandboxed container
    const sandboxHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <script>
            (function() {
              const stdinLines = ${JSON.stringify(stdinLines)};
              let stdinIndex = 0;

              // Override console.log
              window.console.log = function(...args) {
                const formatted = args.map(arg => 
                  typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                ).join(' ');
                window.parent.postMessage({ type: 'log', val: formatted }, '*');
              };

              // Mock window.prompt to read stdin lines sequentially
              window.prompt = function(message) {
                if (stdinIndex < stdinLines.length) {
                  const input = stdinLines[stdinIndex++];
                  // Log prompt call visually in console
                  window.console.log("[stdin prompt]: " + (message || "") + " -> " + input);
                  return input;
                }
                window.console.log("[stdin prompt]: " + (message || "") + " -> [EOF / Empty Input]");
                return null; // EOF
              };

              // Catch unhandled runtime errors
              window.onerror = function(message, source, lineno, colno, error) {
                window.parent.postMessage({ 
                  type: 'error', 
                  error: message + ' (Line ' + lineno + ':' + colno + ')' 
                }, '*');
                return true;
              };

              window.onload = function() {
                try {
                  // Execute code in scoped container
                  (function() {
                    ${code}
                  })();
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

    document.body.appendChild(iframe);
    
    // Write sandbox content directly to the iframe
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(sandboxHtml);
    doc.close();
  });
}

/**
 * Execute Python, C++, C, or C# code using the backend compile proxy.
 */
async function runRemoteCompiler(code, language, stdin) {
  const config = LANGUAGE_CONFIGS[language];
  if (!config) {
    return {
      success: false,
      output: '',
      error: `Unsupported compile language: ${language}`
    };
  }

  // Set up 16s connection timeout wrapper (provides enough time for MSBuild and network hops)
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
      files: [
        {
          name: getFileName(language),
          content: code
        }
      ],
      stdin: stdin || ''
    };

    const response = await fetch(COMPILE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Compiler API returned status ${response.status}`);
    }

    const resData = await response.json();
    if (!resData.ok) {
      throw new Error(resData.error || 'Compilation proxy failed');
    }
    
    // Parse response format
    const runResult = resData.data.run;
    const stdout = runResult.stdout || '';
    const stderr = runResult.stderr || '';
    const codeStatus = runResult.code; // Exit code

    if (stderr || codeStatus !== 0) {
      return {
        success: false,
        output: stdout,
        error: stderr || `Process exited with code ${codeStatus}`
      };
    }

    return {
      success: true,
      output: stdout || 'Compilation succeeded. Process executed with empty return buffer.',
      error: ''
    };

  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Compiler run error:', err);
    return {
      success: false,
      output: '',
      error: err.name === 'AbortError' 
        ? 'Compilation Error: Connection timed out. The compile service did not respond in 16 seconds.'
        : `Network Error: Failed to execute code run. details: ${err.message}`
    };
  }
}
