const mongoose = require('mongoose');

// =============================================================================
// Extended Mongoose Schema for Room Model
// =============================================================================
const RoomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  // Document contents for Notepad Workspace
  content: {
    type: String,
    default: ''
  },
  // Document contents for Compiler Workspace (Persisted on explicit Save)
  codeContent: {
    type: String,
    default: ''
  },
  // Dropdown language choice for Compiler Workspace (Persisted on explicit Save)
  codeLanguage: {
    type: String,
    default: 'javascript'
  },
  // Stdin Program Input for Compiler Workspace (Persisted on explicit Save)
  codeStdin: {
    type: String,
    default: ''
  }
}, {
  timestamps: true // Automatically sets and manages updatedAt / createdAt
});

const Room = mongoose.model('Room', RoomSchema);

// =============================================================================
// In-Memory Temp State Store for Active Rooms (Live Collaboration Cache)
// Prevents heavy Mongoose/MongoDB update write-traffic on every client keystroke.
// =============================================================================
const activeRoomsCache = new Map();

/**
 * Socket.io events registration
 * Coordinates separated states for plain-text and code compiler.
 */
function registerSocketHandlers(io, socket) {
  let currentRoomId = null;

  // 1. Client joins a room
  socket.on('join-room', async ({ roomId, username }) => {
    currentRoomId = roomId;
    socket.join(roomId);

    try {
      let roomState = activeRoomsCache.get(roomId);

      if (!roomState) {
        // If not in cache, load the last saved state from MongoDB
        let room = await Room.findOne({ roomId });
        if (!room) {
          room = await Room.create({ roomId });
        }

        roomState = {
          plainText: room.content || '',
          codeContent: room.codeContent || '',
          codeLanguage: room.codeLanguage || 'javascript',
          codeStdin: room.codeStdin || ''
        };
        
        activeRoomsCache.set(roomId, roomState);
      }

      // Send the active state (either from live cache or db load) to the joined client
      socket.emit('init-state', {
        plainText: roomState.plainText,
        codeContent: roomState.codeContent,
        codeLanguage: roomState.codeLanguage,
        codeStdin: roomState.codeStdin
      });

      console.log(`👤 User "${username}" (${socket.id}) joined room "${roomId}"`);
    } catch (err) {
      console.error(`Socket join error in room "${roomId}":`, err.message);
    }
  });

  // 2. Client edits Plain Text Notepad (Autosaved to DB asynchronously)
  socket.on('plain-text-change', async ({ roomId, text }) => {
    if (!roomId) return;

    // Update memory cache
    const roomState = activeRoomsCache.get(roomId);
    if (roomState) roomState.plainText = text;

    // Broadcast the update immediately to other users in the room
    socket.to(roomId).emit('receive-plain-text', text);

    try {
      await Room.updateOne(
        { roomId },
        { $set: { content: text } }
      );
    } catch (err) {
      console.error(`Failed to save plain text changes for room "${roomId}":`, err.message);
    }
  });

  // 3. Client edits Collaborative Code Editor (Real-time sync only, NO database write)
  socket.on('code-change', ({ roomId, code }) => {
    if (!roomId) return;

    // Update in-memory live cache
    const roomState = activeRoomsCache.get(roomId);
    if (roomState) roomState.codeContent = code;

    // Broadcast change immediately to all other collaborators in the room
    socket.to(roomId).emit('receive-code-change', code);
  });

  // 4. Client changes Selected Compiler Language (Real-time sync only, NO database write)
  socket.on('language-change', ({ roomId, language }) => {
    if (!roomId) return;

    // Update in-memory live cache
    const roomState = activeRoomsCache.get(roomId);
    if (roomState) roomState.codeLanguage = language;

    // Broadcast the language swap to other clients in the room
    socket.to(roomId).emit('receive-language-change', language);
  });

  // 5. Client edits Program Input Stdin area (Real-time sync only, NO database write)
  socket.on('stdin-change', ({ roomId, stdin }) => {
    if (!roomId) return;

    // Update in-memory live cache
    const roomState = activeRoomsCache.get(roomId);
    if (roomState) roomState.codeStdin = stdin;

    // Broadcast standard input change to other clients
    socket.to(roomId).emit('receive-stdin-change', stdin);
  });

  // 6. Explicit Save Code Request (Writes live code, language, and stdin to MongoDB)
  socket.on('save-code', async ({ roomId, code, language, stdin }) => {
    if (!roomId) return;

    try {
      // 1. Update MongoDB document
      const updatedRoom = await Room.findOneAndUpdate(
        { roomId },
        { 
          $set: { 
            codeContent: code, 
            codeLanguage: language,
            codeStdin: stdin
          } 
        },
        { new: true, upsert: true }
      );

      // 2. Sync memory cache
      activeRoomsCache.set(roomId, {
        plainText: updatedRoom.content || '',
        codeContent: updatedRoom.codeContent || '',
        codeLanguage: updatedRoom.codeLanguage || 'javascript',
        codeStdin: updatedRoom.codeStdin || ''
      });

      // 3. Broadcast success and updated timestamps back to room clients
      io.in(roomId).emit('code-saved', { 
        roomId, 
        updatedAt: updatedRoom.updatedAt,
        code,
        language,
        stdin
      });

      console.log(`💾 Room "${roomId}" code successfully saved explicitly to DB.`);
    } catch (err) {
      console.error(`Failed to save code explicitly for room "${roomId}":`, err.message);
      socket.emit('code-save-error', { error: 'Database save failed. Please try again.' });
    }
  });

  // 7. Explicit Load Saved Code Request (Forces load from Database)
  socket.on('load-saved-code', async ({ roomId }) => {
    if (!roomId) return;

    try {
      const room = await Room.findOne({ roomId });
      if (room) {
        // Sync in-memory cache
        const roomState = activeRoomsCache.get(roomId) || { plainText: '' };
        roomState.codeContent = room.codeContent || '';
        roomState.codeLanguage = room.codeLanguage || 'javascript';
        roomState.codeStdin = room.codeStdin || '';
        activeRoomsCache.set(roomId, roomState);

        // Emit back to everyone in room to align editor content
        io.in(roomId).emit('receive-code-change', room.codeContent || '');
        io.in(roomId).emit('receive-language-change', room.codeLanguage || 'javascript');
        io.in(roomId).emit('receive-stdin-change', room.codeStdin || '');
      }
    } catch (err) {
      console.error(`Failed to load explicit code for room "${roomId}":`, err.message);
    }
  });

  // 8. Clean up on disconnect
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    if (currentRoomId) {
      socket.leave(currentRoomId);
      
      // Optional cache eviction if room becomes completely empty
      const clientsInRoom = io.sockets.adapter.rooms.get(currentRoomId);
      if (!clientsInRoom || clientsInRoom.size === 0) {
        // Evict from active cache to free up RAM since no one is connected
        activeRoomsCache.delete(currentRoomId);
        console.log(`🧹 Room "${currentRoomId}" cache evicted (0 active connections)`);
      }
    }
  });
}

module.exports = {
  Room,
  registerSocketHandlers
};
