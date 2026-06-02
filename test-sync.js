const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');

const docId = 'test-sync-room-' + Date.now();
const wsUrl = 'ws://localhost:3000';

console.log(`Connecting to doc: ${docId} at ${wsUrl}`);

// Create Client 1
const doc1 = new Y.Doc();
const provider1 = new WebsocketProvider(wsUrl, docId, doc1, { WebSocketPolyfill: WebSocket });
const text1 = doc1.getText('quill');

// Create Client 2
const doc2 = new Y.Doc();
const provider2 = new WebsocketProvider(wsUrl, docId, doc2, { WebSocketPolyfill: WebSocket });
const text2 = doc2.getText('quill');

provider1.on('status', event => {
  console.log(`Client 1 Status: ${event.status}`);
});

provider2.on('status', event => {
  console.log(`Client 2 Status: ${event.status}`);
});

provider1.on('sync', isSynced => {
  console.log(`Client 1 Synced: ${isSynced}`);
});

provider2.on('sync', isSynced => {
  console.log(`Client 2 Synced: ${isSynced}`);
});

// Watch for changes in Client 2
text2.observe(event => {
  console.log(`Client 2 received text update: "${text2.toString()}"`);
});

// Wait a bit, then edit Client 1
setTimeout(() => {
  console.log('Client 1 typing...');
  text1.insert(0, 'Hello from Client 1!');
  
  // Wait again, check if Client 2 synced
  setTimeout(() => {
    const success = text2.toString() === 'Hello from Client 1!';
    console.log(`\nSync result: ${success ? 'SUCCESS ✅' : 'FAILED ❌'}`);
    console.log(`Client 1 text: "${text1.toString()}"`);
    console.log(`Client 2 text: "${text2.toString()}"`);
    
    // Clean up
    provider1.destroy();
    provider2.destroy();
    process.exit(success ? 0 : 1);
  }, 2000);
}, 2000);
