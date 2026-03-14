// src/commands.js — Slash command parser and executor
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { hasRole } = require("./auth");

const COMMANDS = {
  help: {
    description: "List all available commands",
    minRole: "member",
    handler({ user }) {
      const lines = [
        "Available commands:",
        "/help — Show this help message",
        "/rooms — List all rooms",
        "/who — List users currently in this room",
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
    handler() {
      const rooms = db.prepare("SELECT name, description FROM rooms ORDER BY name").all();
      const lines = [
        "Rooms:",
        ...rooms.map((r) => `  #${r.name} — ${r.description || "No description"}`),
      ];
      return { success: true, systemMessage: lines.join("\n"), broadcast: false };
    },
  },

  who: {
    description: "List members of the current room",
    minRole: "member",
    handler({ roomId }) {
      const members = db
        .prepare(
          `SELECT u.username, u.role FROM users u
           INNER JOIN room_members rm ON rm.user_id = u.id
           WHERE rm.room_id = ?
           ORDER BY u.role DESC, u.username`
        )
        .all(roomId);
      const lines = [
        "Members in this room:",
        ...members.map((m) => `  ${m.username} [${m.role}]`),
      ];
      return { success: true, systemMessage: lines.join("\n"), broadcast: false };
    },
  },

  kick: {
    description: "Remove a user from the room",
    minRole: "moderator",
    handler({ user, args, roomId, io }) {
      const [targetUsername] = args;
      if (!targetUsername) return { success: false, systemMessage: "Usage: /kick <username>" };

      const target = db
        .prepare("SELECT id, username, role FROM users WHERE username = ?")
        .get(targetUsername);
      if (!target) return { success: false, systemMessage: `User "${targetUsername}" not found.` };
      if (target.id === user.id) return { success: false, systemMessage: "You cannot kick yourself." };
      if (hasRole(target.role, user.role) && target.role !== "member") {
        return { success: false, systemMessage: "You cannot kick someone with equal or higher authority." };
      }

      db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(roomId, target.id);
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
    handler({ user, args }) {
      const [targetUsername, newRole] = args;
      if (!targetUsername || !newRole) {
        return { success: false, systemMessage: "Usage: /promote <username> <member|moderator|superadmin>" };
      }
      if (!["member", "moderator", "superadmin"].includes(newRole)) {
        return { success: false, systemMessage: "Invalid role. Choose: member, moderator, superadmin" };
      }

      const target = db
        .prepare("SELECT id, username FROM users WHERE username = ?")
        .get(targetUsername);
      if (!target) return { success: false, systemMessage: `User "${targetUsername}" not found.` };
      if (target.id === user.id) {
        return { success: false, systemMessage: "You cannot change your own role." };
      }

      db.prepare("UPDATE users SET role = ? WHERE id = ?").run(newRole, target.id);
      return {
        success: true,
        systemMessage: `${targetUsername}'s role has been updated to "${newRole}".`,
        broadcast: true,
      };
    },
  },

  createroom: {
    description: "Create a new room",
    minRole: "moderator",
    handler({ user, args }) {
      const [name, ...descParts] = args;
      if (!name) return { success: false, systemMessage: "Usage: /createroom <name> [description]" };

      const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const existing = db.prepare("SELECT id FROM rooms WHERE name = ?").get(slug);
      if (existing) return { success: false, systemMessage: `Room "#${slug}" already exists.` };

      const roomId = uuidv4();
      const description = descParts.join(" ") || "";
      db.prepare(
        "INSERT INTO rooms (id, name, description, created_by) VALUES (?, ?, ?, ?)"
      ).run(roomId, slug, description, user.id);
      db.prepare("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)").run(roomId, user.id);

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
    handler({ args }) {
      const [name] = args;
      if (!name) return { success: false, systemMessage: "Usage: /deleteroom <name>" };

      const room = db.prepare("SELECT id, is_default FROM rooms WHERE name = ?").get(name);
      if (!room) return { success: false, systemMessage: `Room "#${name}" not found.` };
      if (room.is_default) return { success: false, systemMessage: "Cannot delete default rooms." };

      db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
      return {
        success: true,
        systemMessage: `Room #${name} has been deleted.`,
        broadcast: true,
        deletedRoomId: room.id,
      };
    },
  },

  topic: {
    description: "Update room description",
    minRole: "moderator",
    handler({ args, roomId }) {
      const description = args.join(" ");
      if (!description) return { success: false, systemMessage: "Usage: /topic <new description>" };

      db.prepare("UPDATE rooms SET description = ? WHERE id = ?").run(description, roomId);
      return {
        success: true,
        systemMessage: `Room topic updated: "${description}"`,
        broadcast: true,
        updatedTopic: description,
      };
    },
  },
};

function executeCommand({ content, user, roomId, io }) {
  if (!content.startsWith("/")) return null;
  const [rawCmd, ...args] = content.slice(1).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const handler = COMMANDS[cmd];

  if (!handler) {
    return {
      success: false,
      systemMessage: `Unknown command "/${cmd}". Type /help for a list of commands.`,
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

module.exports = { executeCommand, COMMANDS };