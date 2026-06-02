import React, { useState, useCallback } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import CodeCompilerPanel from './CodeCompilerPanel';
import OutputTerminal from './OutputTerminal';
import useEditorSocket from './useEditorSocket';
import { executeCode } from './codeRunner';

/**
 * RoomContainer Component
 * Main coordinator managing workspace tabs, socket state events,
 * compiler executions, program input (stdin), and persistent saves.
 */
export default function RoomContainer({ roomId, username, userColor }) {
  const [activeTab, setActiveTab] = useState('plain-text');
  
  // Compiler Output UI states
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalError, setTerminalError] = useState('');
  const [isRunningCode, setIsRunningCode] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  // Handle save completion toast
  const handleCodeSaved = useCallback(() => {
    setToastMessage('Code persisted to database successfully!');
    setTimeout(() => {
      setToastMessage('');
    }, 3000);
  }, []);

  // Load state and socket emitter methods from useEditorSocket hook
  const {
    plainText,
    codeText,
    language,
    stdin,
    syncStatus,
    lastSaved,
    broadcastPlainText,
    broadcastCodeChange,
    broadcastLanguageChange,
    broadcastStdinChange,
    saveCodeState
  } = useEditorSocket(roomId, username, handleCodeSaved);

  // Execute current code through compiler runner
  const handleRunCode = async () => {
    setIsRunningCode(true);
    setTerminalOutput('');
    setTerminalError('');

    try {
      const result = await executeCode(codeText, language, stdin);
      if (result.success) {
        setTerminalOutput(result.output);
      } else {
        setTerminalError(result.error);
      }
    } catch (err) {
      setTerminalError(`Execution Error: ${err.message}`);
    } finally {
      setIsRunningCode(false);
    }
  };

  const handleClearTerminal = () => {
    setTerminalOutput('');
    setTerminalError('');
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100 font-sans">
      {/* 1. Workspace Tab Switcher Header */}
      <div className="flex items-center justify-between border-b border-white/5 px-4 bg-slate-900/50">
        <WorkspaceTabs activeTab={activeTab} onTabChange={setActiveTab} />
        
        {/* Connection status indicator */}
        <div className="text-xs text-slate-500 font-mono hidden sm:block mr-4">
          Room: <span className="text-slate-300 font-semibold">{roomId}</span>
        </div>
      </div>

      {/* 2. Workspace Viewport Layout */}
      <div className="flex-1 flex flex-col p-4 md:p-6 overflow-hidden">
        
        {/* --- Tab 1: Plain Text Editor Notepad Workspace --- */}
        <div 
          className={`flex-1 flex flex-col ${activeTab === 'plain-text' ? '' : 'hidden'}`}
        >
          <div className="flex flex-col flex-1 bg-slate-900/40 border border-white/5 rounded-xl overflow-hidden p-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/5">
              <span className="font-semibold text-white tracking-wide">📝 Plain Text Document</span>
              <span className="text-xs text-slate-500">Collaborative Scratchpad</span>
            </div>
            
            <textarea
              value={plainText}
              onChange={(e) => broadcastPlainText(e.target.value)}
              className="flex-1 w-full bg-transparent border-0 outline-none text-slate-200 resize-none font-sans text-base leading-relaxed placeholder-slate-600 focus:ring-0 focus:outline-none"
              placeholder="Start drafting document notes here... edits sync in real-time across users."
            />
          </div>
        </div>

        {/* --- Tab 2: Collaborative Coding & Execution Workspace --- */}
        <div 
          className={`flex-1 flex flex-col gap-6 md:grid md:grid-cols-3 ${
            activeTab === 'code-compiler' ? '' : 'hidden'
          }`}
        >
          {/* Main Code Editor Panel (2 columns on wide screens) */}
          <div className="md:col-span-2 flex flex-col h-[450px] md:h-full">
            <CodeCompilerPanel
              code={codeText}
              language={language}
              onChangeCode={broadcastCodeChange}
              onChangeLanguage={broadcastLanguageChange}
              onRunCode={handleRunCode}
              onSaveCode={saveCodeState}
              lastSaved={lastSaved}
              isRunning={isRunningCode}
              syncStatus={syncStatus}
            />
          </div>

          {/* Stdin Input and Terminal Output Panel (1 column on wide screens) */}
          <div className="md:col-span-1 flex flex-col gap-6 h-full min-h-[400px] md:min-h-0">
            
            {/* Stdin Program Input Panel */}
            <div className="flex-1 flex flex-col bg-slate-950 border border-white/5 rounded-xl overflow-hidden shadow-2xl h-1/2">
              <div className="flex items-center px-4 py-2 bg-slate-900 border-b border-white/5">
                <span className="text-slate-400 font-semibold tracking-wider text-xs uppercase flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block animate-pulse"></span>
                  Program Input (stdin)
                </span>
              </div>
              <div className="flex-1 flex flex-col p-4 bg-black/40 text-slate-300">
                <textarea
                  value={stdin}
                  onChange={(e) => broadcastStdinChange(e.target.value)}
                  placeholder="Provide multi-line input for your program execution here (e.g., values for Python's input() or C++'s cin)."
                  className="flex-1 w-full bg-transparent outline-none resize-none border-0 p-0 font-mono text-sm leading-relaxed placeholder-slate-600 focus:ring-0 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500 mt-2 font-mono italic">
                  * Live-synchronized with collaborators. Separate values with newlines.
                </span>
              </div>
            </div>

            {/* Terminal Console Output Panel */}
            <div className="flex-1 flex flex-col h-1/2">
              <OutputTerminal
                output={terminalOutput}
                error={terminalError}
                isRunning={isRunningCode}
                onClear={handleClearTerminal}
              />
            </div>
            
          </div>
        </div>

      </div>

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-blue-600 text-white px-4 py-3 rounded-xl shadow-2xl border border-white/10 text-sm font-semibold flex items-center space-x-2 animate-bounce">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
