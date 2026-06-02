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
  // Document contents for Compiler Workspace
  codeContent: {
    type: String,
    default: ''
  },
  // Dropdown language choice for Compiler Workspace
  codeLanguage: {
    type: String,
    default: 'javascript'
  }
}, {
  timestamps: true // Automatically sets and manages updatedAt
});

const Room = mongoose.model('Room', RoomSchema);

// =============================================================================
// Socket.io Real-time Event Handlers
// =============================================================================

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
      // Find room in db, or create one if it doesn't exist
      let room = await Room.findOne({ roomId });
      if (!room) {
        room = await Room.create({ roomId });
      }

      // Initialize workspace states for the connecting client
      socket.emit('init-state', {
        plainText: room.content,
        codeContent: room.codeContent,
        codeLanguage: room.codeLanguage
      });

      console.log(`👤 User "${username}" (${socket.id}) joined room "${roomId}"`);
    } catch (err) {
      console.error(`Socket join error in room "${roomId}":`, err.message);
    }
  });

  // 2. Client edits Plain Text Notepad
  socket.on('plain-text-change', async ({ roomId, text }) => {
    if (!roomId) return;

    // Broadcast the update immediately to other users in the room
    socket.to(roomId).emit('receive-plain-text', text);

    try {
      // Save changes asynchronously to MongoDB Atlas (best practiced with a debounce)
      await Room.updateOne(
        { roomId },
        { $set: { content: text } }
      );
    } catch (err) {
      console.error(`Failed to save plain text changes for room "${roomId}":`, err.message);
    }
  });

  // 3. Client edits Collaborative Code Editor
  socket.on('code-change', async ({ roomId, code }) => {
    if (!roomId) return;

    // Broadcast the update immediately to other users in the room
    socket.to(roomId).emit('receive-code-change', code);

    try {
      // Save changes asynchronously to MongoDB Atlas
      await Room.updateOne(
        { roomId },
        { $set: { codeContent: code } }
      );
    } catch (err) {
      console.error(`Failed to save code changes for room "${roomId}":`, err.message);
    }
  });

  // 4. Client changes Selected Compiler Language
  socket.on('language-change', async ({ roomId, language }) => {
    if (!roomId) return;

    // Broadcast the language swap to other clients in the room
    socket.to(roomId).emit('receive-language-change', language);

    try {
      // Save changes to MongoDB Atlas
      await Room.updateOne(
        { roomId },
        { $set: { codeLanguage: language } }
      );
    } catch (err) {
      console.error(`Failed to save language change for room "${roomId}":`, err.message);
    }
  });

  // 5. Clean up on disconnect
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    if (currentRoomId) {
      socket.leave(currentRoomId);
    }
  });
}

module.exports = {
  Room,
  registerSocketHandlers
};
