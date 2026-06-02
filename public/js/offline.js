import { IndexeddbPersistence } from 'y-indexeddb';

export function initOffline(docId, ydoc, provider) {
  // 1. Initialize IndexedDB Persistence for local-first operations
  const idbProvider = new IndexeddbPersistence(docId, ydoc);

  idbProvider.on('synced', () => {
    console.log(`[IndexedDB] Local cached document loaded for room: ${docId}`);
    window.showToast?.('Loaded local offline draft', 'success', 2000);
  });

  // 2. Track Offline/Online connection lifecycle states
  window.addEventListener('online', () => {
    window.showToast?.('Network re-established — syncing local edits', 'success', 3000);
  });

  window.addEventListener('offline', () => {
    window.showToast?.('Network disconnected — running offline mode safely', 'warning', 4000);
  });

  // 3. Monitor y-websocket server sync completes
  provider.on('sync', (isSynced) => {
    if (isSynced) {
      window.showToast?.('All changes successfully synced with server', 'success', 2000);
    }
  });

  return idbProvider;
}
