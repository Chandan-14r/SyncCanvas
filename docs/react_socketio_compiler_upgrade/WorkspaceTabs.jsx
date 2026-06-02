import React from 'react';

/**
 * WorkspaceTabs Component
 * Modern glassmorphic tab switcher for SyncCanvas workspaces.
 */
export default function WorkspaceTabs({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'plain-text', label: '📝 Plain Text' },
    { id: 'code-compiler', label: '💻 Code Compiler' }
  ];

  return (
    <div className="flex items-center justify-start space-x-2 bg-slate-900/60 backdrop-blur-md border border-white/5 p-1 rounded-lg w-fit mx-4 my-2">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-all duration-200 ${
              isActive
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
