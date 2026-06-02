# Architectural Decisions & Integration Guide: Code Compiler Workspace

This document outlines the system architecture, design decisions, and data flows required to upgrade **SyncCanvas** with a real-time collaborative Code Compiler workspace alongside the existing collaborative plain-text editor.

---

## 🏗️ 1. Architecture Decisions

### State Separation Strategy
* **Double-Buffer State Model**: The plain-text notepad and the code editor must exist as completely isolated data states in both React memory and the database schema.
* **Component Mount/Visibility Handling**: Switching tabs does not destroy the state of either editor; instead, it toggles visibility (e.g., using `hidden` classes or conditional CSS displays) to preserve user selections, undo histories, and caret positions.
* **Database Representation**: The `Room` schema is extended to contain distinct `content` (plain text) and `codeContent` / `codeLanguage` fields.

```
                   +------------------------+
                   |  Room State (Database) |
                   +-----------+------------+
                               |
            +------------------+------------------+
            |                                     |
+-----------v------------+            +-----------v------------+
|  plainTextContent      |            |  codeContent           |
|  (Notepad Workspace)   |            |  (Compiler Workspace)  |
+------------------------+            +------------------------+
```

### Socket Event Design
To prevent state contamination and race conditions, we split communications into highly specific Socket.io event scopes. General updates are never blended.

| Event Name | Direction | Payload Structure | Purpose |
| :--- | :--- | :--- | :--- |
| `join-room` | Client -> Server | `{ roomId, username }` | Joins room and receives initial states. |
| `init-state` | Server -> Client | `{ plainText, code, language }` | Dispatches loaded room values to new connection. |
| `plain-text-change` | Client -> Server | `{ roomId, text }` | Emits character edits from the plain-text notepad. |
| `receive-plain-text` | Server -> Client | `text` (String) | Syncs notepad updates to remote collaborators. |
| `code-change` | Client -> Server | `{ roomId, code }` | Emits character edits from the CodeMirror editor. |
| `receive-code-change` | Server -> Client | `code` (String) | Syncs code updates to remote collaborators. |
| `language-change` | Client -> Server | `{ roomId, language }` | Syncs code compiler dropdown selections. |
| `receive-language-change` | Server -> Client | `language` (String) | Updates remote clients' active editor mode. |

### Code Execution Design (Security)
* **Python and C++**: Executed via the public, isolated **Piston API** (`https://emkc.org/api/v2/piston`). To prevent CORS errors and secure request routing, all calls go through a lightweight backend proxy `/api/compile` on the SyncCanvas server. This keeps credentials secure and allows backend rate-limiting.
* **JavaScript**: Executed in a **browser-side sandboxed iframe**.
  * The iframe is initialized with `sandbox="allow-scripts"`, preventing it from accessing the parent window's DOM, cookies, local storage, or executing redirect exploits.
  * Console logs are captured by overriding `window.console.log` inside the iframe and relaying stringified outputs back via `window.parent.postMessage`.
  * If execution hangs, a timeout mechanism terminates the runner.

### Output Syncing Philosophy
* **Output remains strictly Local**.
* *Rationale*: Real-time syncing of run results triggers visual noise and disrupts other collaborators. For example, if User A compiles code while User B is writing an unrelated function, User B's output terminal should not suddenly refresh with User A's compilation logs. 

---

## 📁 2. Recommended Frontend Component Structure

Add these files to your React `src/` directory:

```text
src/
├── components/
│   ├── WorkspaceTabs.jsx         # Selector buttons for Plain Text vs Code Compiler
│   ├── CodeCompilerPanel.jsx     # Editor container, toolbars, and selectors
│   ├── OutputTerminal.jsx        # Command-line dark output dashboard
│   └── PlainTextEditor.jsx       # Collaborative notepad panel
├── hooks/
│   └── useEditorSocket.js        # Manages all WS listeners and editor debounces
├── utils/
│   └── codeRunner.js             # Client runner sandbox & Piston fetch wrappers
└── RoomContainer.jsx             # Coordinates active states and workspace toggles
```

---

## ⚠️ 3. Edge Cases Handled

1. **Tab Switching While Typing**: The UI uses CSS display properties (`display: none` / `hidden`) rather than unmounting components. This preserves the undo/redo buffer, selection caret coordinates, and active local edits for both workspaces.
2. **Language Changes during Collaborative Typing**: When a collaborator modifies the language selector, `language-change` broadcasts to all clients. The CodeMirror instance dynamically swaps its language syntax extensions (e.g. `javascript()`, `python()`, `cpp()`) without clearing or altering the text editor buffer.
3. **Execution Network Failures**: The code runner implements a `5000ms` fetch timeout. If Piston is offline or the client loses connection, the interface prints a formatted red terminal error: `[Network Error: Execution request timed out. Please check your internet connection.]`
4. **Race Condition Typing Loops**: Controlled input loops are broken by keeping local editor refs and verifying that outgoing WebSocket events are only fired on actual keyboard/input mutations (using state change tracking flags) while incoming socket changes bypass state-driven re-renders when inputs are identical.
5. **Empty Code Submissions**: If a user hits "Run Code" on an empty document, the engine short-circuits and prints a warning: `[Terminal: No code input provided. Execution bypassed.]` to save network bandwidth.
