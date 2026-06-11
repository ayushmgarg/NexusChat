// src/routes.js — All REST endpoints (fully async for PostgreSQL)
const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { signToken, requireAuth, requireRole, requirePermission } = require("./auth");

// ── Invite code validation ────────────────────────────────────────────────────
async function validateInvite(code) {
  // If REQUIRE_INVITE is true, a valid code is mandatory
  if (process.env.REQUIRE_INVITE === "true") {
    if (!code || code.trim() === "") {
      return { ok: false, error: "An invite code is required to register" };
    }
    const row = await db.prepare(
      "SELECT * FROM invite_codes WHERE code = ?"
    ).get(code.trim().toUpperCase());

    if (!row) {
      return { ok: false, error: "Invalid invite code" };
    }
    if (row.uses_max !== -1 && row.uses_count >= row.uses_max) {
      return { ok: false, error: "This invite code has already been fully used" };
    }
    return { ok: true, row };
  }

  // REQUIRE_INVITE is false — but if a code IS provided, still validate it
  if (code && code.trim() !== "") {
    const row = await db.prepare(
      "SELECT * FROM invite_codes WHERE code = ?"
    ).get(code.trim().toUpperCase());

    if (!row) {
      return { ok: false, error: "Invalid invite code" };
    }
    if (row.uses_max !== -1 && row.uses_count >= row.uses_max) {
      return { ok: false, error: "This invite code has already been fully used" };
    }
    return { ok: true, row };
  }

  // No code provided and not required — allow through
  return { ok: true };
}

async function consumeInvite(code) {
  if (!code) return;
  await db.prepare(
    "UPDATE invite_codes SET uses_count = uses_count + 1 WHERE code = ?"
  ).run(code.trim().toUpperCase());
}

// ── Export a function that takes io and returns a router ──────────────────────
module.exports = function createRouter(io) {
  const router = express.Router();

  // ── Auth ──────────────────────────────────────────────────────────────────

  // Validate invite code without registering (for frontend to check on page load)
  router.get("/auth/invite/:code", async (req, res) => {
    try {
      const code = req.params.code.trim().toUpperCase();
      const row = await db.prepare(
        "SELECT * FROM invite_codes WHERE code = ?"
      ).get(code);

      if (!row) return res.status(400).json({ error: "Invalid invite code" });
      if (row.uses_max !== -1 && row.uses_count >= row.uses_max) {
        return res.status(400).json({ error: "This invite code has been fully used" });
      }
      res.json({ ok: true, label: row.label || "" });
    } catch (e) {
      console.error("[invite validate]", e);
      res.status(500).json({ error: "Failed to validate invite code" });
    }
  });

  router.post("/auth/register", async (req, res) => {
    try {
      const { username, password, inviteCode } = req.body;

      // Invite check — runs before anything else
      const inviteResult = await validateInvite(inviteCode);
      if (!inviteResult.ok) return res.status(403).json({ error: inviteResult.error });

      if (!username || !password)
        return res.status(400).json({ error: "Username and password required" });
      if (username.length < 3 || username.length > 20)
        return res.status(400).json({ error: "Username must be 3–20 characters" });
      if (!/^[a-zA-Z0-9_-]+$/.test(username))
        return res.status(400).json({ error: "Username may only contain letters, numbers, _ and -" });
      if (password.length < 6)
        return res.status(400).json({ error: "Password must be at least 6 characters" });

      const existing = await db.prepare(
        "SELECT id FROM users WHERE username = ?"
      ).get(username);
      if (existing) return res.status(409).json({ error: "Username already taken" });

      const hash = bcrypt.hashSync(password, 12);
      const id = uuidv4();

      // Get default member role
      const memberRole = await db.prepare("SELECT id, name, color FROM roles WHERE name = ?").get('member');

      await db.prepare(
        "INSERT INTO users (id, username, password, role, role_id) VALUES (?, ?, ?, 'member', ?)"
      ).run(id, username, hash, memberRole ? memberRole.id : null);

      // Join only DEFAULT rooms
      const defaultRooms = await db.prepare('SELECT id FROM rooms WHERE is_default = 1').all();
      for (const room of defaultRooms) {
        await db.prepare(
          "INSERT INTO room_members (room_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
        ).run(room.id, id);
      }

      // Consume invite code
      if (inviteCode && inviteCode.trim() !== "") {
        await consumeInvite(inviteCode);
      }

      const token = signToken({ id });
      res.cookie("token", token, {
        httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000,
      });
      res.json({
        token,
        user: {
          id, username, role: "member",
          display_name: null,
          role_name: memberRole ? memberRole.name : 'member',
          role_color: memberRole ? memberRole.color : '#8b949e',
          role_id: memberRole ? memberRole.id : null,
          permissions: {},
        },
      });
    } catch (e) {
      console.error("[register]", e);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  router.post("/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password)
        return res.status(400).json({ error: "Username and password required" });

      const user = await db.prepare("SELECT * FROM users WHERE username = ?").get(username);
      if (!user || !bcrypt.compareSync(password, user.password))
        return res.status(401).json({ error: "Invalid credentials" });

      // Get role info
      const roleInfo = user.role_id
        ? await db.prepare("SELECT id, name, color, permissions FROM roles WHERE id = ?").get(user.role_id)
        : null;

      let permissions = {};
      if (roleInfo && roleInfo.permissions) {
        try {
          permissions = typeof roleInfo.permissions === 'string' ? JSON.parse(roleInfo.permissions) : roleInfo.permissions;
        } catch {}
      }

      const token = signToken({ id: user.id });
      res.cookie("token", token, {
        httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000,
      });
      res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          display_name: user.display_name || null,
          role_name: roleInfo ? roleInfo.name : user.role,
          role_color: roleInfo ? roleInfo.color : '#8b949e',
          role_id: user.role_id || null,
          permissions,
        },
      });
    } catch (e) {
      console.error("[login]", e);
      res.status(500).json({ error: "Login failed" });
    }
  });

  router.post("/auth/logout", (req, res) => {
    res.clearCookie("token");
    res.json({ ok: true });
  });

  router.get("/auth/me", requireAuth, (req, res) => {
    const u = req.user;
    res.json({
      user: {
        id: u.id,
        username: u.username,
        display_name: u.display_name || null,
        role: u.role,
        role_name: u.role_name || u.role,
        role_color: u.role_color || '#8b949e',
        role_id: u.role_id || null,
        permissions: u.permissions || {},
      },
    });
  });

  // ── Invite code management ──────────────────────────────────────────────────

  // Generate a new invite code (superadmin only)
  router.post("/invites", requireAuth, requireRole("superadmin"), async (req, res) => {
    try {
      const { label = "", uses_max = -1 } = req.body;
      const code = uuidv4().replace(/-/g, "").slice(0, 12).toUpperCase();
      await db.prepare(
        "INSERT INTO invite_codes (code, label, created_by, uses_max) VALUES (?, ?, ?, ?)"
      ).run(code, label, req.user.id, uses_max);
      res.json({ code, label, uses_max });
    } catch (e) {
      res.status(500).json({ error: "Failed to create invite code" });
    }
  });

  // List all invite codes (superadmin only)
  router.get("/invites", requireAuth, requireRole("superadmin"), async (req, res) => {
    try {
      const codes = await db.prepare(
        `SELECT i.code, i.label, i.uses_max, i.uses_count, i.created_at, u.username as created_by
         FROM invite_codes i LEFT JOIN users u ON u.id = i.created_by
         ORDER BY i.created_at DESC`
      ).all();
      res.json({ codes });
    } catch (e) {
      res.status(500).json({ error: "Failed to fetch invite codes" });
    }
  });

  // Delete an invite code (superadmin only)
  router.delete("/invites/:code", requireAuth, requireRole("superadmin"), async (req, res) => {
    try {
      await db.prepare("DELETE FROM invite_codes WHERE code = ?").run(req.params.code);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to delete invite code" });
    }
  });

  // ── Rooms ───────────────────────────────────────────────────────────────────

  router.get("/rooms", requireAuth, async (req, res) => {
    try {
      const rooms = await db.prepare(
        `SELECT r.id, r.name, r.description, r.is_default, r.created_at,
                u.username as created_by,
                (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
         FROM rooms r
         INNER JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
         LEFT JOIN users u ON u.id = r.created_by
         ORDER BY r.is_default DESC, r.name ASC`
      ).all(req.user.id);
      res.json({ rooms });
    } catch (e) {
      console.error("[GET /rooms]", e);
      res.status(500).json({ error: "Failed to fetch rooms" });
    }
  });

  // IMPORTANT: /rooms/browse MUST be defined BEFORE /rooms/:id routes
  router.get("/rooms/browse", requireAuth, async (req, res) => {
    try {
      const rooms = await db.prepare(
        `SELECT r.id, r.name, r.description, r.is_default, r.created_at,
                u.username as created_by,
                (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count,
                CASE WHEN rm.user_id IS NOT NULL THEN 1 ELSE 0 END as is_member
         FROM rooms r
         LEFT JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
         LEFT JOIN users u ON u.id = r.created_by
         ORDER BY r.is_default DESC, r.name ASC`
      ).all(req.user.id);
      res.json({ rooms: rooms.map(r => ({ ...r, isMember: !!r.is_member })) });
    } catch (e) {
      console.error("[GET /rooms/browse]", e);
      res.status(500).json({ error: "Failed to browse rooms" });
    }
  });

  router.post("/rooms", requireAuth, requireRole("moderator"), async (req, res) => {
    try {
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ error: "Room name required" });

      const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (slug.length < 2 || slug.length > 30)
        return res.status(400).json({ error: "Room name must be 2–30 characters" });

      const existing = await db.prepare("SELECT id FROM rooms WHERE name = ?").get(slug);
      if (existing) return res.status(409).json({ error: "Room name already in use" });

      const id = uuidv4();
      await db.prepare(
        "INSERT INTO rooms (id, name, description, created_by) VALUES (?, ?, ?, ?)"
      ).run(id, slug, description || "", req.user.id);

      // Only add creator as member
      await db.prepare(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)"
      ).run(id, req.user.id);

      const room = await db.prepare(
        `SELECT r.id, r.name, r.description, r.is_default, r.created_at,
                u.username as created_by,
                (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
         FROM rooms r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?`
      ).get(id);

      io.emit("room:created", room);
      res.status(201).json({ room });
    } catch (e) {
      console.error("[create room]", e);
      res.status(500).json({ error: "Failed to create room" });
    }
  });

  router.delete("/rooms/:id", requireAuth, requireRole("superadmin"), async (req, res) => {
    try {
      const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (room.is_default) return res.status(403).json({ error: "Cannot delete default rooms" });

      await db.prepare("DELETE FROM room_members WHERE room_id = ?").run(req.params.id);
      await db.prepare("DELETE FROM messages WHERE room_id = ?").run(req.params.id);
      await db.prepare("DELETE FROM user_room_state WHERE room_id = ?").run(req.params.id);
      await db.prepare("DELETE FROM rooms WHERE id = ?").run(req.params.id);

      io.emit("room:deleted", { id: req.params.id });
      res.json({ ok: true });
    } catch (e) {
      console.error("[delete room]", e);
      res.status(500).json({ error: "Failed to delete room" });
    }
  });

  router.post("/rooms/:id/join", requireAuth, async (req, res) => {
    try {
      const room = await db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
      if (!room) return res.status(404).json({ error: "Room not found" });

      await db.prepare(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
      ).run(req.params.id, req.user.id);

      // Get the user's info for the broadcast
      const memberInfo = await db.prepare(
        `SELECT u.id, u.username, u.display_name, r.name as role_name, r.color as role_color
         FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
      ).get(req.user.id);

      io.to(`room:${req.params.id}`).emit("member:joined", {
        roomId: req.params.id,
        member: memberInfo,
      });

      res.json({ ok: true });
    } catch (e) {
      console.error("[join room]", e);
      res.status(500).json({ error: "Failed to join room" });
    }
  });

  router.post("/rooms/:id/leave", requireAuth, async (req, res) => {
    try {
      const room = await db.prepare("SELECT id, is_default FROM rooms WHERE id = ?").get(req.params.id);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (room.is_default) return res.status(403).json({ error: "Cannot leave default rooms" });

      await db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(req.params.id, req.user.id);

      io.to(`room:${req.params.id}`).emit("member:left", {
        roomId: req.params.id,
        userId: req.user.id,
        username: req.user.username,
      });

      res.json({ ok: true });
    } catch (e) {
      console.error("[leave room]", e);
      res.status(500).json({ error: "Failed to leave room" });
    }
  });

  router.get("/rooms/:id/messages", requireAuth, async (req, res) => {
    try {
      const room = await db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
      if (!room) return res.status(404).json({ error: "Room not found" });

      const member = await db.prepare(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?"
      ).get(req.params.id, req.user.id);
      if (!member) return res.status(403).json({ error: "You are not a member of this room" });

      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const before = req.query.before ? parseInt(req.query.before) : Math.floor(Date.now() / 1000) + 1;

      const messages = (await db.prepare(
        `SELECT m.id, m.room_id, m.user_id, m.username, u.display_name,
                r.name as role_name, r.color as role_color,
                m.content, m.type, m.created_at, m.attachment, m.mentions
         FROM messages m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE m.room_id = ? AND m.created_at < ?
         ORDER BY m.created_at DESC LIMIT ?`
      ).all(req.params.id, before, limit)).reverse();

      // Parse attachment and mentions JSON
      for (const msg of messages) {
        if (msg.attachment && typeof msg.attachment === 'string') {
          try { msg.attachment = JSON.parse(msg.attachment); } catch {}
        }
        if (msg.mentions && typeof msg.mentions === 'string') {
          try { msg.mentions = JSON.parse(msg.mentions); } catch { msg.mentions = []; }
        }
      }

      res.json({ messages });
    } catch (e) {
      console.error("[GET /rooms/:id/messages]", e);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  router.get("/rooms/:id/members", requireAuth, async (req, res) => {
    try {
      const members = await db.prepare(
        `SELECT u.id, u.username, u.display_name, r.name as role_name, r.color as role_color, rm.joined_at
         FROM users u
         INNER JOIN room_members rm ON rm.user_id = u.id
         LEFT JOIN roles r ON r.id = u.role_id
         WHERE rm.room_id = ?
         ORDER BY r.level DESC, u.username`
      ).all(req.params.id);
      res.json({ members });
    } catch (e) {
      console.error("[GET /rooms/:id/members]", e);
      res.status(500).json({ error: "Failed to fetch members" });
    }
  });

  // ── Users ───────────────────────────────────────────────────────────────────

  router.get("/users", requireAuth, async (req, res) => {
    try {
      const users = await db.prepare(
        `SELECT u.id, u.username, u.display_name, r.name as role_name, r.color as role_color
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         ORDER BY u.username ASC`
      ).all();
      res.json({ users });
    } catch (e) {
      console.error("[GET /users]", e);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  router.patch("/users/:id/role", requireAuth, requirePermission("can_promote"), async (req, res) => {
    try {
      const { role_id } = req.body;
      if (!role_id) return res.status(400).json({ error: "role_id is required" });

      const newRole = await db.prepare("SELECT id, name, color FROM roles WHERE id = ?").get(role_id);
      if (!newRole) return res.status(400).json({ error: "Invalid role" });

      const target = await db.prepare("SELECT id, username FROM users WHERE id = ?").get(req.params.id);
      if (!target) return res.status(404).json({ error: "User not found" });
      if (target.id === req.user.id)
        return res.status(400).json({ error: "Cannot change your own role" });

      await db.prepare("UPDATE users SET role = ?, role_id = ? WHERE id = ?").run(newRole.name, newRole.id, req.params.id);

      // Get updated user info for broadcast
      const updated = await db.prepare(
        `SELECT u.id, u.username, u.display_name, r.name as role_name, r.color as role_color
         FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
      ).get(req.params.id);

      io.emit("member:updated", {
        userId: updated.id,
        username: updated.username,
        display_name: updated.display_name,
        role_name: updated.role_name,
        role_color: updated.role_color,
      });

      res.json({ ok: true });
    } catch (e) {
      console.error("[PATCH /users/:id/role]", e);
      res.status(500).json({ error: "Failed to update role" });
    }
  });

  router.patch("/users/:id/display-name", requireAuth, async (req, res) => {
    try {
      const { display_name } = req.body;
      if (display_name && display_name.length > 32)
        return res.status(400).json({ error: "Display name max 32 chars" });

      const isSelf = req.params.id === req.user.id;
      const canChange = req.user.permissions?.can_change_display_names;
      if (!isSelf && !canChange)
        return res.status(403).json({ error: "Permission denied" });

      await db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(display_name || null, req.params.id);

      // Get updated user info for broadcast
      const updated = await db.prepare(
        `SELECT u.id, u.username, u.display_name, r.name as role_name, r.color as role_color
         FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
      ).get(req.params.id);

      io.emit("member:updated", {
        userId: updated.id,
        username: updated.username,
        display_name: updated.display_name,
        role_name: updated.role_name,
        role_color: updated.role_color,
      });

      res.json({ ok: true, user: updated });
    } catch (e) {
      console.error("[PATCH /users/:id/display-name]", e);
      res.status(500).json({ error: "Failed to update display name" });
    }
  });

  // ── Roles ───────────────────────────────────────────────────────────────────

  router.get("/roles", requireAuth, async (req, res) => {
    try {
      const roles = await db.prepare(
        "SELECT id, name, level, color, permissions, is_system FROM roles ORDER BY level ASC"
      ).all();
      // Parse permissions JSON for each role
      for (const role of roles) {
        if (role.permissions && typeof role.permissions === 'string') {
          try { role.permissions = JSON.parse(role.permissions); } catch {}
        }
      }
      res.json({ roles });
    } catch (e) {
      console.error("[GET /roles]", e);
      res.status(500).json({ error: "Failed to fetch roles" });
    }
  });

  router.post("/roles", requireAuth, requirePermission("can_manage_roles"), async (req, res) => {
    try {
      const { name, level, color, permissions } = req.body;

      if (!name || name.length < 2 || name.length > 20)
        return res.status(400).json({ error: "Role name must be 2–20 characters" });

      const existingName = await db.prepare("SELECT id FROM roles WHERE name = ?").get(name);
      if (existingName) return res.status(409).json({ error: "Role name already in use" });

      if (level === undefined || level < 0 || level > 100)
        return res.status(400).json({ error: "Level must be 0–100" });

      if (color && !/^#[0-9a-fA-F]{6}$/.test(color))
        return res.status(400).json({ error: "Color must be a valid hex color (e.g. #ff0000)" });

      if (permissions && typeof permissions !== 'object')
        return res.status(400).json({ error: "Permissions must be an object" });

      const id = uuidv4();
      const permStr = JSON.stringify(permissions || {});
      await db.prepare(
        "INSERT INTO roles (id, name, level, color, permissions, is_system, created_by) VALUES (?, ?, ?, ?, ?, 0, ?)"
      ).run(id, name, level, color || '#8b949e', permStr, req.user.id);

      const role = await db.prepare("SELECT id, name, level, color, permissions, is_system FROM roles WHERE id = ?").get(id);
      if (role && role.permissions && typeof role.permissions === 'string') {
        try { role.permissions = JSON.parse(role.permissions); } catch {}
      }

      res.status(201).json({ role });
    } catch (e) {
      console.error("[POST /roles]", e);
      res.status(500).json({ error: "Failed to create role" });
    }
  });

  router.patch("/roles/:id", requireAuth, requirePermission("can_manage_roles"), async (req, res) => {
    try {
      const role = await db.prepare("SELECT * FROM roles WHERE id = ?").get(req.params.id);
      if (!role) return res.status(404).json({ error: "Role not found" });

      const { name, level, color, permissions } = req.body;

      // Can't change system roles' name or level
      if (role.is_system) {
        if (name && name !== role.name)
          return res.status(403).json({ error: "Cannot change system role name" });
        if (level !== undefined && level !== role.level)
          return res.status(403).json({ error: "Cannot change system role level" });
      }

      const updates = {};
      if (name !== undefined && !role.is_system) updates.name = name;
      if (level !== undefined && !role.is_system) updates.level = level;
      if (color !== undefined) updates.color = color;
      if (permissions !== undefined) updates.permissions = JSON.stringify(permissions);

      // Build update query dynamically
      const setClauses = [];
      const values = [];
      for (const [key, val] of Object.entries(updates)) {
        setClauses.push(`${key} = ?`);
        values.push(val);
      }

      if (setClauses.length === 0) return res.json({ ok: true });

      values.push(req.params.id);
      await db.prepare(
        `UPDATE roles SET ${setClauses.join(', ')} WHERE id = ?`
      ).run(...values);

      const updated = await db.prepare("SELECT id, name, level, color, permissions, is_system FROM roles WHERE id = ?").get(req.params.id);
      if (updated && updated.permissions && typeof updated.permissions === 'string') {
        try { updated.permissions = JSON.parse(updated.permissions); } catch {}
      }

      res.json({ ok: true, role: updated });
    } catch (e) {
      console.error("[PATCH /roles/:id]", e);
      res.status(500).json({ error: "Failed to update role" });
    }
  });

  router.delete("/roles/:id", requireAuth, requirePermission("can_manage_roles"), async (req, res) => {
    try {
      const role = await db.prepare("SELECT * FROM roles WHERE id = ?").get(req.params.id);
      if (!role) return res.status(404).json({ error: "Role not found" });
      if (role.is_system) return res.status(403).json({ error: "Cannot delete system roles" });

      // Reassign users with this role to the 'member' role
      const memberRole = await db.prepare("SELECT id FROM roles WHERE name = ?").get('member');
      if (memberRole) {
        await db.prepare("UPDATE users SET role = 'member', role_id = ? WHERE role_id = ?").run(memberRole.id, req.params.id);
      }

      await db.prepare("DELETE FROM roles WHERE id = ?").run(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      console.error("[DELETE /roles/:id]", e);
      res.status(500).json({ error: "Failed to delete role" });
    }
  });
  router.get('/health', (req, res) => res.json({ ok: true }));
  return router;
};