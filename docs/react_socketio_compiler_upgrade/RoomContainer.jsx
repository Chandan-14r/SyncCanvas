import React, { useState } from 'react';
import WorkspaceTabs from './WorkspaceTabs';
import CodeCompilerPanel from './CodeCompilerPanel';
import OutputTerminal from './OutputTerminal';
import useEditorSocket from './useEditorSocket';
import { executeCode } from './codeRunner';

/**
 * RoomContainer Component
 * Main coordinator managing workspace tabs, socket state events,
 * and compiler executions.
 */
export default function RoomContainer({ roomId, username, userColor }) {
  const [activeTab, setActiveTab] = useState('plain-text');
  
  // Compiler Output UI states
  const [terminalOutput, setTerminalOutput] = useState('');
  const [terminalError, setTerminalError] = useState('');
  const [isRunningCode, setIsRunningCode] = useState(false);

  // Load state and socket emitter methods from useEditorSocket hook
  const {
    plainText,
    codeText,
    language,
    syncStatus,
    broadcastPlainText,
    broadcastCodeChange,
    broadcastLanguageChange
  } = useEditorSocket(roomId, username);

  // Execute current code through compiler runner
  const handleRunCode = async () => {
    setIsRunningCode(true);
    setTerminalOutput('');
    setTerminalError('');

    try {
      const result = await executeCode(codeText, language);
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
              className="flex-1 w-full bg-transparent border-0 outline-none text-slate-200 resize-none font-sans text-base leading-relaxed placeholder-slate-600 focus:ring-0"
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
              isRunning={isRunningCode}
              syncStatus={syncStatus}
            />
          </div>

          {/* Terminal Console Output Panel (1 column on wide screens) */}
          <div className="md:col-span-1 flex flex-col h-[250px] md:h-full">
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
  );
}
