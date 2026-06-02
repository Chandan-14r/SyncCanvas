import React from 'react';

/**
 * OutputTerminal Component
 * Dark command-line themed outputs display box.
 */
export default function OutputTerminal({ output, error, isRunning, onClear }) {
  return (
    <div className="flex flex-col bg-slate-950 border border-white/5 rounded-xl overflow-hidden shadow-2xl h-full font-mono text-sm">
      {/* Terminal Title Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-white/5">
        <span className="text-slate-400 font-semibold tracking-wider text-xs uppercase flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-slate-700 inline-block animate-pulse"></span>
          Terminal Output
        </span>
        <button
          onClick={onClear}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors py-0.5 px-2 rounded hover:bg-white/5 focus:outline-none"
        >
          Clear Logs
        </button>
      </div>

      {/* Output Console Log Screen */}
      <div className="flex-1 p-4 overflow-y-auto min-h-[160px] max-h-[300px] md:max-h-none bg-black/40 text-slate-300 select-text leading-relaxed">
        {isRunning ? (
          <div className="flex items-center space-x-2 text-blue-400">
            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="italic">Running script. Compiling and staging environment...</span>
          </div>
        ) : error ? (
          <div className="whitespace-pre-wrap text-rose-500 bg-rose-500/5 p-3 rounded-lg border border-rose-500/10">
            <span className="font-bold block mb-1">⚠️ Compilation / Runtime Error:</span>
            {error}
          </div>
        ) : output ? (
          <div className="whitespace-pre-wrap text-emerald-400 bg-emerald-500/5 p-3 rounded-lg border border-emerald-500/10">
            {output}
          </div>
        ) : (
          <div className="text-slate-600 italic select-none">
            Click "Run Code" above to execute your scripts. Output will appear here...
          </div>
        )}
      </div>
    </div>
  );
}
