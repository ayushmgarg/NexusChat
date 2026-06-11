// src/socket.js — Real-time Socket.IO events (async DB calls)
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { socketAuth } = require("./auth");
const { executeCommand } = require("./commands");

const onlineUsers = new Map(); // userId -> Set<socketId>
let ioRef;

function getIO() {
  return ioRef;
}

function setupSockets(io) {
  ioRef = io;
  io.use(socketAuth);

  io.on("connection", async (socket) => {
    const user = socket.user;

    if (!onlineUsers.has(user.id)) onlineUsers.set(user.id, new Set());
    onlineUsers.get(user.id).add(socket.id);

    socket.join(`user:${user.id}`);
    console.log(`[+] ${user.username} (${user.role_name || user.role}) connected`);
    broadcastOnlineList(io);

    // ── Join room ──────────────────────────────────────────────────────────
    socket.on("room:join", async ({ roomId }, ack) => {
      try {
        const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
        if (!room) return ack?.({ error: "Room not found" });

        // Check membership — user must already be a member via REST API
        const membership = await db.prepare(
          "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?"
        ).get(roomId, user.id);
        if (!membership) return ack?.({ error: "You are not a member of this room" });

        socket.join(`room:${roomId}`);

        // Update last_read_at
        const now = Math.floor(Date.now() / 1000);
        await db.prepare(
          "INSERT INTO user_room_state (user_id, room_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT (user_id, room_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at"
        ).run(user.id, roomId, now);

        const messages = (await db.prepare(
          `SELECT m.id, m.room_id, m.user_id, m.username, u.display_name,
                  r.name as role_name, r.color as role_color,
                  m.content, m.type, m.created_at, m.attachment, m.mentions
           FROM messages m
           LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN roles r ON r.id = u.role_id
           WHERE m.room_id = ?
           ORDER BY m.created_at DESC LIMIT 50`
        ).all(roomId)).reverse();

        // Parse attachment and mentions JSON for each message
        for (const msg of messages) {
          if (msg.attachment && typeof msg.attachment === 'string') {
            try { msg.attachment = JSON.parse(msg.attachment); } catch { /* keep as string */ }
          }
          if (msg.mentions && typeof msg.mentions === 'string') {
            try { msg.mentions = JSON.parse(msg.mentions); } catch { msg.mentions = []; }
          }
        }

        const members = await db.prepare(
          `SELECT u.id, u.username, u.display_name, r.name as role_name, r.color as role_color
           FROM users u
           INNER JOIN room_members rm ON rm.user_id = u.id
           LEFT JOIN roles r ON r.id = u.role_id
           WHERE rm.room_id = ? ORDER BY r.level DESC, u.username`
        ).all(roomId);

        ack?.({ ok: true, messages, members, room });
      } catch (e) {
        console.error("[room:join]", e);
        ack?.({ error: "Failed to join room" });
      }
    });

    // ── Leave room ─────────────────────────────────────────────────────────
    socket.on("room:leave", ({ roomId }) => {
      socket.leave(`room:${roomId}`);
    });

    // ── Send message ───────────────────────────────────────────────────────
    socket.on("message:send", async ({ roomId, content, attachment }, ack) => {
      try {
        if (!roomId || (!content && !attachment))
          return ack?.({ error: "roomId and content or attachment required" });

        const trimmed = (content || "").trim();
        if (!attachment && (!trimmed || trimmed.length > 2000))
          return ack?.({ error: "Message must be 1–2000 characters" });

        const isMember = await db.prepare(
          "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?"
        ).get(roomId, user.id);
        if (!isMember) return ack?.({ error: "You are not a member of this room" });

        // Command handling
        if (trimmed.startsWith("/")) {
          const result = await executeCommand({ content: trimmed, user, roomId, io });
          if (result) {
            const now   = Math.floor(Date.now() / 1000);
            const sysId = uuidv4();

            if (result.systemMessage) {
              const sysMsg = {
                id: sysId, room_id: roomId, user_id: "system",
                username: "System", display_name: null, role_name: null, role_color: null,
                content: result.systemMessage,
                type: "system", created_at: now, attachment: null, mentions: null,
              };
              if (result.broadcast) {
                await db.prepare(
                  `INSERT INTO messages (id, room_id, user_id, username, content, type, created_at)
                   VALUES (?, ?, 'system', 'System', ?, 'system', ?)`
                ).run(sysId, roomId, result.systemMessage, now);
                io.to(`room:${roomId}`).emit("message:new", sysMsg);
              } else {
                socket.emit("message:new", sysMsg);
              }
            }

            if (result.newRoom)       io.emit("room:created", result.newRoom);
            if (result.deletedRoomId) io.emit("room:deleted", { id: result.deletedRoomId });
            if (result.updatedTopic)  io.to(`room:${roomId}`).emit("room:topicUpdated", { roomId, description: result.updatedTopic });
            if (result.memberLeft)    io.to(`room:${roomId}`).emit("member:left", result.memberLeft);
            if (result.memberUpdated) io.emit("member:updated", result.memberUpdated);

            return ack?.({ ok: true, isCommand: true });
          }
        }

        // Validate attachment if present
        let attachmentJson = null;
        if (attachment) {
          const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];
          if (!allowedTypes.includes(attachment.type)) {
            return ack?.({ error: "File type not allowed" });
          }
          if (!attachment.data || typeof attachment.data !== 'string') {
            return ack?.({ error: "Invalid attachment data" });
          }
          // Check decoded size (base64 to bytes)
          const sizeInBytes = Buffer.from(attachment.data, 'base64').length;
          if (sizeInBytes > 3 * 1024 * 1024) {
            return ack?.({ error: "Attachment too large (max 3MB)" });
          }
          attachmentJson = JSON.stringify({
            name: attachment.name,
            type: attachment.type,
            size: attachment.size || sizeInBytes,
            data: attachment.data,
          });
        }

        // Parse @mentions from content
        let mentionsJson = null;
        const mentionedUserIds = [];
        if (trimmed) {
          const mentionRegex = /(?:^|\s)@([a-zA-Z0-9_-]+)/g;
          const mentionedUsernames = new Set();
          let match;
          while ((match = mentionRegex.exec(trimmed)) !== null) {
            mentionedUsernames.add(match[1]);
          }
          if (mentionedUsernames.size > 0) {
            for (const uname of mentionedUsernames) {
              const mentionedUser = await db.prepare(
                "SELECT id FROM users WHERE username = ?"
              ).get(uname);
              if (mentionedUser) {
                mentionedUserIds.push(mentionedUser.id);
              }
            }
            if (mentionedUserIds.length > 0) {
              mentionsJson = JSON.stringify(mentionedUserIds);
            }
          }
        }

        // Regular message
        const msgId = uuidv4();
        const now   = Math.floor(Date.now() / 1000);

        await db.prepare(
          `INSERT INTO messages (id, room_id, user_id, username, content, type, created_at, attachment, mentions)
           VALUES (?, ?, ?, ?, ?, 'message', ?, ?, ?)`
        ).run(msgId, roomId, user.id, user.username, trimmed || "", now, attachmentJson, mentionsJson);

        // Parse attachment back for the emitted message
        let parsedAttachment = null;
        if (attachmentJson) {
          try { parsedAttachment = JSON.parse(attachmentJson); } catch {}
        }

        const message = {
          id: msgId, room_id: roomId, user_id: user.id,
          username: user.username, display_name: user.display_name,
          role_name: user.role_name, role_color: user.role_color,
          content: trimmed || "", type: "message", created_at: now,
          attachment: parsedAttachment,
          mentions: mentionedUserIds.length > 0 ? mentionedUserIds : null,
        };

        io.to(`room:${roomId}`).emit("message:new", message);

        // Send mention notifications
        if (mentionedUserIds.length > 0) {
          const room = await db.prepare("SELECT name FROM rooms WHERE id = ?").get(roomId);
          const preview = trimmed.length > 100 ? trimmed.slice(0, 100) + "..." : trimmed;
          for (const mentionedId of mentionedUserIds) {
            io.to(`user:${mentionedId}`).emit("mention:new", {
              messageId: msgId,
              roomId,
              roomName: room?.name || "unknown",
              fromUsername: user.username,
              preview,
            });
          }
        }

        ack?.({ ok: true, message });
      } catch (e) {
        console.error("[message:send]", e);
        ack?.({ error: "Failed to send message" });
      }
    });

    // ── Mark room as read ──────────────────────────────────────────────────
    socket.on("room:markRead", async ({ roomId }) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        await db.prepare(
          "INSERT INTO user_room_state (user_id, room_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT (user_id, room_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at"
        ).run(user.id, roomId, now);
      } catch (e) {
        console.error("[room:markRead]", e);
      }
    });

    // ── Typing ─────────────────────────────────────────────────────────────
    socket.on("typing:start", ({ roomId }) => {
      socket.to(`room:${roomId}`).emit("typing:update", {
        userId: user.id, username: user.username, typing: true,
      });
    });

    socket.on("typing:stop", ({ roomId }) => {
      socket.to(`room:${roomId}`).emit("typing:update", {
        userId: user.id, username: user.username, typing: false,
      });
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      const sockets = onlineUsers.get(user.id);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) onlineUsers.delete(user.id);
      }
      console.log(`[-] ${user.username} disconnected`);
      broadcastOnlineList(io);
    });
  });
}

function broadcastOnlineList(io) {
  io.emit("users:online", { userIds: [...onlineUsers.keys()] });
}

module.exports = { setupSockets, getIO };