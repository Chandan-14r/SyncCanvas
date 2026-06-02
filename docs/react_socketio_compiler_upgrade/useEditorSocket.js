import { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';

const SOCKET_SERVER = process.env.REACT_APP_SOCKET_URL || 'http://localhost:3000';

/**
 * Custom React Hook: useEditorSocket
 * Manages separate real-time sync states for the collaborative notepad
 * and the code compiler workspace via Socket.io.
 */
export default function useEditorSocket(roomId, username) {
  const [plainText, setPlainText] = useState('');
  const [codeText, setCodeText] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [syncStatus, setSyncStatus] = useState('disconnected');
  
  const socketRef = useRef(null);
  
  // Track last committed values from sockets to prevent infinite echo loops
  const lastPlainTextRef = useRef('');
  const lastCodeTextRef = useRef('');

  useEffect(() => {
    if (!roomId) return;

    // 1. Initialize socket connection
    const socket = io(SOCKET_SERVER, {
      transports: ['websocket'],
      reconnectionAttempts: 5
    });
    socketRef.current = socket;
    setSyncStatus('syncing');

    // Join room
    socket.emit('join-room', { roomId, username });

    // 2. Event Listeners: Connection Lifecycle
    socket.on('connect', () => {
      setSyncStatus('synced');
    });

    socket.on('disconnect', () => {
      setSyncStatus('disconnected');
    });

    // 3. Event Listeners: Workspace States Initialization
    socket.on('init-state', ({ plainText: initPlainText, codeContent: initCodeText, codeLanguage: initLang }) => {
      lastPlainTextRef.current = initPlainText || '';
      lastCodeTextRef.current = initCodeText || '';
      
      setPlainText(initPlainText || '');
      setCodeText(initCodeText || '');
      setLanguage(initLang || 'javascript');
      setSyncStatus('synced');
    });

    // 4. Event Listeners: Plain Text Collaboration
    socket.on('receive-plain-text', (updatedText) => {
      lastPlainTextRef.current = updatedText;
      setPlainText(updatedText);
    });

    // 5. Event Listeners: Code Editor Collaboration
    socket.on('receive-code-change', (updatedCode) => {
      lastCodeTextRef.current = updatedCode;
      setCodeText(updatedCode);
    });

    // 6. Event Listeners: Language Selector Sync
    socket.on('receive-language-change', (updatedLang) => {
      setLanguage(updatedLang);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('init-state');
      socket.off('receive-plain-text');
      socket.off('receive-code-change');
      socket.off('receive-language-change');
      socket.disconnect();
    };
  }, [roomId, username]);

  // --- State Broadcasters (Invoked by UI Inputs) ---

  /** Emits edits made in the plain text notepad */
  const broadcastPlainText = (newText) => {
    setPlainText(newText);
    // Bypasses socket emit if the text is identical to what was just received
    if (newText === lastPlainTextRef.current) return;
    
    lastPlainTextRef.current = newText;
    socketRef.current?.emit('plain-text-change', { roomId, text: newText });
  };

  /** Emits edits made in the CodeMirror editor */
  const broadcastCodeChange = (newCode) => {
    setCodeText(newCode);
    // Bypasses socket emit if the code is identical to what was just received
    if (newCode === lastCodeTextRef.current) return;

    lastCodeTextRef.current = newCode;
    socketRef.current?.emit('code-change', { roomId, code: newCode });
  };

  /** Emits selected compiler language dropdown changes */
  const broadcastLanguageChange = (newLang) => {
    setLanguage(newLang);
    socketRef.current?.emit('language-change', { roomId, language: newLang });
  };

  return {
    plainText,
    codeText,
    language,
    syncStatus,
    broadcastPlainText,
    broadcastCodeChange,
    broadcastLanguageChange
  };
}
