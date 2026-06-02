# MERN + Socket.io Auto-Save Debounce Implementation Guide

This guide details how to implement a robust, performance-optimized auto-save system for a real-time collaborative notepad using the **MERN stack** (MongoDB/Mongoose) and **Socket.io**.

To prevent exhausting database limits and CPU cycles under heavy typing, we implement:
1. **A Debounced Save Queue**: Database write operations are delayed by **2 seconds** after the last keystroke in a room.
2. **Immediate Disconnect Flush**: If the last client in a room disconnects or closes their window, any pending changes are immediately flushed to the database to prevent data loss.

---

## 💾 1. MongoDB Schema Design (Mongoose)

We define a Mongoose `RoomSchema` that tracks the room's unique string ID, the current text state, and standard timestamps.

Create a file named `models/Room.js`:

```javascript
const mongoose = require('mongoose');

const RoomSchema = new mongoose.Schema({
  // Unique room ID used in URLs (e.g., "meeting-notes")
  roomId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true // Indexed for rapid query lookup
  },
  // The raw text content of the document
  content: {
    type: String,
    default: ''
  }
}, {
  // Automatically creates and updates `createdAt` and `updatedAt` fields
  timestamps: true
});

module.exports = mongoose.model('Room', RoomSchema);
```

---

## ⚡ 2. Node.js + Socket.io Server Implementation

Here is the complete implementation of the WebSocket server, which manages in-memory room states, coordinates collaborative edits, runs debounced database writes, and flushes states on client disconnects.

Create a file named `server.js`:

```javascript
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const Room = require('./models/Room');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sync_canvas';

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' } // Adjust origins for production
});

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('🔌 Connected to MongoDB Database'))
  .catch(err => console.error('MongoDB connection error:', err));

// =============================================================================
// Auto-Save Debounce Manager
// =============================================================================

// Keeps track of the live in-memory document state per room
// Structure: RoomId -> { content: string, timer: TimeoutRef, dirty: boolean, connections: Set<socketId> }
const roomSessions = new Map();

// Helper: Save room content directly to MongoDB
async function saveRoomToDatabase(roomId, content) {
  try {
    await Room.updateOne(
      { roomId: roomId },
      { $set: { content: content } },
      { upsert: true }
    );
    console.log(`💾 [Auto-Save] Successfully saved room "${roomId}" to database.`);
  } catch (err) {
    console.error(`❌ [Auto-Save] Failed to save room "${roomId}" to database:`, err.message);
  }
}

// Trigger debounced save
function queueDebouncedSave(roomId) {
  const session = roomSessions.get(roomId);
  if (!session) return;

  // Mark session state as unsaved (dirty)
  session.dirty = true;

  // Clear any existing active timeout (typing resets the 2s timer)
  if (session.timer) {
    clearTimeout(session.timer);
  }

  // Set a new timer to execute save in 2 seconds
  session.timer = setTimeout(async () => {
    if (session.dirty) {
      await saveRoomToDatabase(roomId, session.content);
      session.dirty = false;
      session.timer = null;
    }
  }, 2000);
}

// Force immediate flush of pending changes
async function flushPendingChanges(roomId) {
  const session = roomSessions.get(roomId);
  if (session && session.dirty) {
    // Clear timer immediately to prevent duplicate saves
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }

    console.log(`⚡ [Flush] Flushing pending changes for room "${roomId}" before closure.`);
    await saveRoomToDatabase(roomId, session.content);
    session.dirty = false;
  }
}

// =============================================================================
// Socket.io Real-time Coordination
// =============================================================================

io.on('connection', (socket) => {
  let currentRoomId = null;

  console.log(`🔌 Client connected: ${socket.id}`);

  // 1. Client requests to join a room
  socket.on('join-room', async ({ roomId, username }) => {
    currentRoomId = roomId;
    socket.join(roomId);

    // Get or initialize the in-memory room session
    let session = roomSessions.get(roomId);

    if (!session) {
      // Cache miss: Load the room state from MongoDB
      let dbRoom = await Room.findOne({ roomId });
      
      session = {
        content: dbRoom ? dbRoom.content : '',
        timer: null,
        dirty: false,
        connections: new Set()
      };
      
      roomSessions.set(roomId, session);
      console.log(`🏠 Session initialized for room "${roomId}"`);
    }

    // Add this socket to active connections
    session.connections.add(socket.id);

    // Send the current room content back to the connecting client
    socket.emit('load-document', session.content);

    // Broadcast user join state to room presence list
    socket.to(roomId).emit('user-joined', { username, socketId: socket.id });
    console.log(`👤 User "${username}" joined room "${roomId}"`);
  });

  // 2. Client broadcasts character edits (keystrokes)
  socket.on('edit-document', (newContent) => {
    if (!currentRoomId) return;

    const session = roomSessions.get(currentRoomId);
    if (!session) return;

    // Update the in-memory content representation
    session.content = newContent;

    // Broadcast the updated content directly to other users in the room
    socket.to(currentRoomId).emit('document-update', newContent);

    // Queue the 2-second debounced database write
    queueDebouncedSave(currentRoomId);
  });

  // 3. User disconnects or closes the window
  socket.on('disconnect', async () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);

    if (currentRoomId) {
      const session = roomSessions.get(currentRoomId);
      if (session) {
        // Remove connection tracking
        session.connections.delete(socket.id);

        // If this was the last collaborator in the room, immediately save and flush to prevent data loss
        if (session.connections.size === 0) {
          console.log(`🧹 Room "${currentRoomId}" is now empty.`);
          await flushPendingChanges(currentRoomId);
          
          // Clear session from memory to prevent memory leaks
          roomSessions.delete(currentRoomId);
          console.log(`🗑️ Evicted empty room "${currentRoomId}" from memory.`);
        } else {
          // Tell remaining users that this client left
          socket.to(currentRoomId).emit('user-left', { socketId: socket.id });
        }
      }
    }
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`🚀 MERN + Socket.io Server running on port ${PORT}`);
});
```

---

## 💡 3. Design Tradeoffs & Edge Cases Explained

### Memory Eviction & GC
By checking `session.connections.size === 0` inside the `disconnect` event, we ensure that as soon as the last user leaves, the room state is **flushed immediately and deleted from server memory**. This prevents the Node server from running out of RAM if thousands of distinct rooms are created throughout the day.

### Keep-Alive Node Process
If the Node server process receives a shutdown signal (e.g. `SIGINT` or `SIGTERM` when Render redeploys or restarts), you should add a final flush for **all** active room sessions in your graceful shutdown handler to prevent losing changes:

```javascript
process.on('SIGINT', async () => {
  console.log('\nStopping server safely...');
  
  // Flush all active dirty rooms in memory to the database
  const flushPromises = [];
  for (const [roomId, session] of roomSessions.entries()) {
    if (session.dirty) {
      flushPromises.push(saveRoomToDatabase(roomId, session.content));
    }
  }
  
  await Promise.all(flushPromises);
  console.log('All rooms successfully flushed. Exiting.');
  process.exit(0);
});
```
