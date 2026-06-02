import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';

/**
 * CodeCompilerPanel Component
 * Houses the collaborative CodeMirror editor, language selector, and controls.
 */
export default function CodeCompilerPanel({
  code,
  language,
  onChangeCode,
  onChangeLanguage,
  onRunCode,
  isRunning,
  syncStatus
}) {
  // Get corresponding language extensions for CodeMirror
  const getLanguageExtension = (lang) => {
    switch (lang) {
      case 'javascript':
        return [javascript({ jsx: true })];
      case 'python':
        return [python()];
      case 'c':
      case 'cpp':
      case 'csharp':
        return [cpp()];
      default:
        return [javascript()];
    }
  };

  return (
    <div className="flex flex-col flex-1 bg-slate-950/80 border border-white/5 rounded-xl overflow-hidden shadow-2xl">
      {/* Editor Control Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-3 bg-slate-900/90 border-b border-white/5 gap-2">
        <div className="flex items-center space-x-3">
          <span className="font-semibold text-white tracking-wide">💻 Coding Workspace</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            syncStatus === 'synced' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
            syncStatus === 'syncing' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
            'bg-slate-500/15 text-slate-400'
          }`}>
            {syncStatus === 'synced' ? '● Synced' : syncStatus === 'syncing' ? '● Syncing...' : 'Disconnected'}
          </span>
        </div>
        
        <div className="flex items-center space-x-3">
          {/* Language Selector Dropdown */}
          <div className="relative">
            <select
              value={language}
              onChange={(e) => onChangeLanguage(e.target.value)}
              className="appearance-none bg-slate-800 border border-white/10 text-slate-200 text-sm rounded-lg px-4 py-1.5 pr-8 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 cursor-pointer"
            >
              <option value="javascript">JavaScript (Node.js)</option>
              <option value="python">Python 3</option>
              <option value="c">C (GCC 10)</option>
              <option value="cpp">C++ (GCC 10)</option>
              <option value="csharp">C# (Mono 6.12)</option>
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
              <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/>
              </svg>
            </div>
          </div>

          {/* Run Code Button */}
          <button
            onClick={onRunCode}
            disabled={isRunning}
            className={`flex items-center space-x-1.5 px-4 py-1.5 text-sm font-semibold rounded-lg text-white shadow-lg transition-all duration-150 ${
              isRunning
                ? 'bg-slate-700/50 cursor-not-allowed text-slate-400'
                : 'bg-emerald-600 hover:bg-emerald-500 hover:shadow-emerald-600/15 active:scale-[0.98]'
            }`}
          >
            {isRunning ? (
              <>
                <svg className="animate-spin -ml-0.5 mr-1 h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Running...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4 fill-current text-white mr-0.5" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z"/>
                </svg>
                <span>Run Code</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code Editor Container */}
      <div className="flex-1 overflow-auto text-base">
        <CodeMirror
          value={code}
          height="100%"
          extensions={getLanguageExtension(language)}
          theme={vscodeDark}
          onChange={(val) => onChangeCode(val)}
          className="h-full focus:outline-none"
        />
      </div>
    </div>
  );
}
