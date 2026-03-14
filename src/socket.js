// src/socket.js — Real-time Socket.IO event handling
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { socketAuth } = require("./auth");
const { executeCommand } = require("./commands");

// userId -> Set<socketId>
const onlineUsers = new Map();

function setupSockets(io) {
  io.use(socketAuth);

  io.on("connection", (socket) => {
    const user = socket.user;

    if (!onlineUsers.has(user.id)) onlineUsers.set(user.id, new Set());
    onlineUsers.get(user.id).add(socket.id);

    // Personal room for targeted events (kicks, promotions)
    socket.join(`user:${user.id}`);

    console.log(`[+] ${user.username} (${user.role}) connected [${socket.id}]`);
    broadcastOnlineList(io);

    // ── Join a room ────────────────────────────────────────────────────────
    socket.on("room:join", ({ roomId }, ack) => {
      const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
      if (!room) return ack?.({ error: "Room not found" });

      db.prepare(
        "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)"
      ).run(roomId, user.id);

      socket.join(`room:${roomId}`);

      const messages = db
        .prepare(
          `SELECT id, room_id, user_id, username, content, type, created_at
           FROM messages WHERE room_id = ?
           ORDER BY created_at DESC LIMIT 50`
        )
        .all(roomId)
        .reverse();

      const members = db
        .prepare(
          `SELECT u.id, u.username, u.role FROM users u
           INNER JOIN room_members rm ON rm.user_id = u.id
           WHERE rm.room_id = ? ORDER BY u.username`
        )
        .all(roomId);

      ack?.({ ok: true, messages, members, room });
    });

    // ── Leave a room ───────────────────────────────────────────────────────
    socket.on("room:leave", ({ roomId }) => {
      socket.leave(`room:${roomId}`);
    });

    // ── Send a message ─────────────────────────────────────────────────────
    socket.on("message:send", ({ roomId, content }, ack) => {
      if (!roomId || !content) return ack?.({ error: "roomId and content required" });

      const trimmed = content.trim();
      if (!trimmed || trimmed.length > 2000)
        return ack?.({ error: "Message must be 1–2000 characters" });

      const isMember = db
        .prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?")
        .get(roomId, user.id);
      if (!isMember) return ack?.({ error: "You are not a member of this room" });

      // Command handling
      if (trimmed.startsWith("/")) {
        const result = executeCommand({ content: trimmed, user, roomId, io });

        if (result) {
          const now = Math.floor(Date.now() / 1000);
          const sysId = uuidv4();

          if (result.systemMessage) {
            const sysMsg = {
              id: sysId,
              room_id: roomId,
              user_id: "system",
              username: "System",
              content: result.systemMessage,
              type: "system",
              created_at: now,
            };

            if (result.broadcast) {
              db.prepare(
                `INSERT INTO messages (id, room_id, user_id, username, content, type, created_at)
                 VALUES (?, ?, 'system', 'System', ?, 'system', ?)`
              ).run(sysId, roomId, result.systemMessage, now);
              io.to(`room:${roomId}`).emit("message:new", sysMsg);
            } else {
              socket.emit("message:new", sysMsg);
            }
          }

          if (result.newRoom)      io.emit("room:created", result.newRoom);
          if (result.deletedRoomId) io.emit("room:deleted", { id: result.deletedRoomId });
          if (result.updatedTopic) {
            io.to(`room:${roomId}`).emit("room:topicUpdated", {
              roomId,
              description: result.updatedTopic,
            });
          }

          return ack?.({ ok: true, isCommand: true });
        }
      }

      // Regular message
      const msgId = uuidv4();
      const now = Math.floor(Date.now() / 1000);

      db.prepare(
        `INSERT INTO messages (id, room_id, user_id, username, content, type, created_at)
         VALUES (?, ?, ?, ?, ?, 'message', ?)`
      ).run(msgId, roomId, user.id, user.username, trimmed, now);

      const message = {
        id: msgId,
        room_id: roomId,
        user_id: user.id,
        username: user.username,
        content: trimmed,
        type: "message",
        created_at: now,
      };

      io.to(`room:${roomId}`).emit("message:new", message);
      ack?.({ ok: true, message });
    });

    // ── Typing indicators ──────────────────────────────────────────────────
    socket.on("typing:start", ({ roomId }) => {
      socket
        .to(`room:${roomId}`)
        .emit("typing:update", { userId: user.id, username: user.username, typing: true });
    });

    socket.on("typing:stop", ({ roomId }) => {
      socket
        .to(`room:${roomId}`)
        .emit("typing:update", { userId: user.id, username: user.username, typing: false });
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      const sockets = onlineUsers.get(user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) onlineUsers.delete(user.id);
      }
      console.log(`[-] ${user.username} disconnected [${socket.id}]`);
      broadcastOnlineList(io);
    });
  });
}

function broadcastOnlineList(io) {
  io.emit("users:online", { userIds: [...onlineUsers.keys()] });
}

module.exports = { setupSockets };