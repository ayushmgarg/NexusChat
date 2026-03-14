// src/commands.js — Slash command executor (async DB calls)
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { hasRole } = require("./auth");

const COMMANDS = {
  help: {
    description: "List all available commands",
    minRole: "member",
    async handler({ user }) {
      const lines = [
        "Available commands:",
        "/help — Show this help message",
        "/rooms — List all rooms",
        "/who — List members in this room",
        "/kick <username> — [moderator+] Remove a user from the room",
        "/promote <username> <role> — [superadmin] Promote or demote a user",
        "/createroom <name> [description] — [moderator+] Create a new room",
        "/deleteroom <name> — [superadmin] Delete a room",
        "/topic <text> — [moderator+] Update room description",
      ];
      return { success: true, systemMessage: lines.join("\n"), broadcast: false };
    },
  },

  rooms: {
    description: "List all rooms",
    minRole: "member",
    async handler() {
      const rooms = await db.prepare("SELECT name, description FROM rooms ORDER BY name").all();
      const lines = [
        "Rooms:",
        ...rooms.map(r => `  #${r.name} — ${r.description || "No description"}`),
      ];
      return { success: true, systemMessage: lines.join("\n"), broadcast: false };
    },
  },

  who: {
    description: "List members in this room",
    minRole: "member",
    async handler({ roomId }) {
      const members = await db.prepare(
        `SELECT u.username, u.role FROM users u
         INNER JOIN room_members rm ON rm.user_id = u.id
         WHERE rm.room_id = ? ORDER BY u.role DESC, u.username`
      ).all(roomId);
      const lines = [
        "Members in this room:",
        ...members.map(m => `  ${m.username} [${m.role}]`),
      ];
      return { success: true, systemMessage: lines.join("\n"), broadcast: false };
    },
  },

  kick: {
    description: "Remove a user from the room",
    minRole: "moderator",
    async handler({ user, args, roomId, io }) {
      const [targetUsername] = args;
      if (!targetUsername)
        return { success: false, systemMessage: "Usage: /kick <username>" };

      const target = await db.prepare(
        "SELECT id, username, role FROM users WHERE username = ?"
      ).get(targetUsername);
      if (!target)
        return { success: false, systemMessage: `User "${targetUsername}" not found.` };
      if (target.id === user.id)
        return { success: false, systemMessage: "You cannot kick yourself." };
      if (hasRole(target.role, user.role) && target.role !== "member")
        return { success: false, systemMessage: "You cannot kick someone with equal or higher authority." };

      await db.prepare(
        "DELETE FROM room_members WHERE room_id = ? AND user_id = ?"
      ).run(roomId, target.id);

      io.to(`user:${target.id}`).emit("kicked", { roomId, by: user.username });
      return {
        success: true,
        systemMessage: `${targetUsername} has been removed from this room.`,
        broadcast: true,
      };
    },
  },

  promote: {
    description: "Change a user's role",
    minRole: "superadmin",
    async handler({ user, args }) {
      const [targetUsername, newRole] = args;
      if (!targetUsername || !newRole)
        return { success: false, systemMessage: "Usage: /promote <username> <member|moderator|superadmin>" };
      if (!["member", "moderator", "superadmin"].includes(newRole))
        return { success: false, systemMessage: "Invalid role. Choose: member, moderator, superadmin" };

      const target = await db.prepare(
        "SELECT id, username FROM users WHERE username = ?"
      ).get(targetUsername);
      if (!target)
        return { success: false, systemMessage: `User "${targetUsername}" not found.` };
      if (target.id === user.id)
        return { success: false, systemMessage: "You cannot change your own role." };

      await db.prepare("UPDATE users SET role = ? WHERE id = ?").run(newRole, target.id);
      return {
        success: true,
        systemMessage: `${targetUsername} is now a ${newRole}.`,
        broadcast: true,
      };
    },
  },

  createroom: {
    description: "Create a new room",
    minRole: "moderator",
    async handler({ user, args }) {
      const [name, ...descParts] = args;
      if (!name)
        return { success: false, systemMessage: "Usage: /createroom <name> [description]" };

      const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const existing = await db.prepare("SELECT id FROM rooms WHERE name = ?").get(slug);
      if (existing)
        return { success: false, systemMessage: `Room "#${slug}" already exists.` };

      const roomId      = uuidv4();
      const description = descParts.join(" ") || "";
      await db.prepare(
        "INSERT INTO rooms (id, name, description, created_by) VALUES (?, ?, ?, ?)"
      ).run(roomId, slug, description, user.id);

      // Add all existing users to new room
      const allUsers = await db.prepare("SELECT id FROM users").all();
      for (const u of allUsers) {
        await db.prepare(
          "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)"
        ).run(roomId, u.id);
      }

      return {
        success: true,
        systemMessage: `Room #${slug} created.`,
        broadcast: false,
        newRoom: { id: roomId, name: slug, description },
      };
    },
  },

  deleteroom: {
    description: "Delete a room",
    minRole: "superadmin",
    async handler({ args }) {
      const [name] = args;
      if (!name)
        return { success: false, systemMessage: "Usage: /deleteroom <name>" };

      const room = await db.prepare("SELECT id, is_default FROM rooms WHERE name = ?").get(name);
      if (!room)
        return { success: false, systemMessage: `Room "#${name}" not found.` };
      if (room.is_default)
        return { success: false, systemMessage: "Cannot delete default rooms." };

      await db.prepare("DELETE FROM room_members WHERE room_id = ?").run(room.id);
      await db.prepare("DELETE FROM messages WHERE room_id = ?").run(room.id);
      await db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
      return {
        success: true,
        systemMessage: `Room #${name} deleted.`,
        broadcast: true,
        deletedRoomId: room.id,
      };
    },
  },

  topic: {
    description: "Update room description",
    minRole: "moderator",
    async handler({ args, roomId }) {
      const description = args.join(" ");
      if (!description)
        return { success: false, systemMessage: "Usage: /topic <new description>" };

      await db.prepare("UPDATE rooms SET description = ? WHERE id = ?").run(description, roomId);
      return {
        success: true,
        systemMessage: `Topic updated: "${description}"`,
        broadcast: true,
        updatedTopic: description,
      };
    },
  },
};

async function executeCommand({ content, user, roomId, io }) {
  if (!content.startsWith("/")) return null;
  const [rawCmd, ...args] = content.slice(1).trim().split(/\s+/);
  const cmd     = rawCmd.toLowerCase();
  const handler = COMMANDS[cmd];

  if (!handler) {
    return {
      success: false,
      systemMessage: `Unknown command "/${cmd}". Type /help for a list.`,
    };
  }
  if (!hasRole(user.role, handler.minRole)) {
    return {
      success: false,
      systemMessage: `Permission denied: "/${cmd}" requires ${handler.minRole} or higher.`,
    };
  }

  return handler.handler({ user, args, roomId, io });
}

module.exports = { executeCommand };