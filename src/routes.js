// src/routes.js — All REST endpoints (fully async for LibSQL/Turso)
const express = require("express");
const bcrypt  = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { signToken, requireAuth, requireRole } = require("./auth");

const router = express.Router();

// ── Invite code validation ────────────────────────────────────────────────────
async function validateInvite(code) {
  if (process.env.REQUIRE_INVITE !== "true") return { ok: true };
  if (!code) return { ok: false, error: "An invite code is required to register" };

  const row = await db.prepare("SELECT * FROM invite_codes WHERE code = ?").get(code);
  if (!row) return { ok: false, error: "Invalid invite code" };
  if (row.uses_max !== -1 && row.uses_count >= row.uses_max) {
    return { ok: false, error: "This invite code has already been fully used" };
  }
  return { ok: true, row };
}

async function consumeInvite(code) {
  await db.prepare(
    "UPDATE invite_codes SET uses_count = uses_count + 1 WHERE code = ?"
  ).run(code);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

// Validate invite code without registering (for frontend to check on page load)
router.get("/auth/invite/:code", async (req, res) => {
  const result = await validateInvite(req.params.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const row = result.row || {};
  res.json({ ok: true, label: row.label || "" });
});

router.post("/auth/register", async (req, res) => {
  try {
    const { username, password, inviteCode } = req.body;

    // Invite check
    const inviteResult = await validateInvite(inviteCode);
    if (!inviteResult.ok) return res.status(403).json({ error: inviteResult.error });

    // Input validation
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });
    if (username.length < 3 || username.length > 20)
      return res.status(400).json({ error: "Username must be 3–20 characters" });
    if (!/^[a-zA-Z0-9_-]+$/.test(username))
      return res.status(400).json({ error: "Username may only contain letters, numbers, _ and -" });
    if (password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });

    const existing = await db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (existing) return res.status(409).json({ error: "Username already taken" });

    const hash = bcrypt.hashSync(password, 12);
    const id   = uuidv4();

    await db.prepare(
      "INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'member')"
    ).run(id, username, hash);

    // BUG FIX #1: Join ALL rooms, not just default ones
    const allRooms = await db.prepare("SELECT id FROM rooms").all();
    for (const room of allRooms) {
      await db.prepare(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
      ).run(room.id, id);
    }

    // Consume invite
    if (process.env.REQUIRE_INVITE === "true" && inviteCode) {
      await consumeInvite(inviteCode);
    }

    const token = signToken({ id });
    res.cookie("token", token, {
      httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000,
    });
    // BUG FIX #2: Return full user object so frontend can auto sign-in
    res.json({ token, user: { id, username, role: "member" } });
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

    const token = signToken({ id: user.id });
    res.cookie("token", token, {
      httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
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
  res.json({ user: req.user });
});

// ── Invite code management ────────────────────────────────────────────────────

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
  const codes = await db.prepare(
    `SELECT i.code, i.label, i.uses_max, i.uses_count, i.created_at, u.username as created_by
     FROM invite_codes i LEFT JOIN users u ON u.id = i.created_by
     ORDER BY i.created_at DESC`
  ).all();
  res.json({ codes });
});

// Delete an invite code (superadmin only)
router.delete("/invites/:code", requireAuth, requireRole("superadmin"), async (req, res) => {
  await db.prepare("DELETE FROM invite_codes WHERE code = ?").run(req.params.code);
  res.json({ ok: true });
});

// ── Rooms ─────────────────────────────────────────────────────────────────────

router.get("/rooms", requireAuth, async (req, res) => {
  try {
    const rooms = await db.prepare(
      `SELECT r.id, r.name, r.description, r.is_default, r.created_at,
              u.username as created_by,
              (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
       FROM rooms r
       LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.is_default DESC, r.name ASC`
    ).all();
    res.json({ rooms });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch rooms" });
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

    // Add creator to room
    await db.prepare(
      "INSERT INTO room_members (room_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
    ).run(id, req.user.id);

    // BUG FIX #3: Also add ALL existing users to new room
    const allUsers = await db.prepare("SELECT id FROM users").all();
    for (const u of allUsers) {
      await db.prepare(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
      ).run(id, u.id);
    }

    const room = await db.prepare(
      `SELECT r.*, u.username as created_by
       FROM rooms r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?`
    ).get(id);
    res.status(201).json({ room });
  } catch (e) {
    console.error("[create room]", e);
    res.status(500).json({ error: "Failed to create room" });
  }
});

router.delete("/rooms/:id", requireAuth, requireRole("superadmin"), async (req, res) => {
  const room = await db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.is_default) return res.status(403).json({ error: "Cannot delete default rooms" });

  await db.prepare("DELETE FROM room_members WHERE room_id = ?").run(req.params.id);
  await db.prepare("DELETE FROM messages WHERE room_id = ?").run(req.params.id);
  await db.prepare("DELETE FROM rooms WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.post("/rooms/:id/join", requireAuth, async (req, res) => {
  const room = await db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });
  await db.prepare(
    "INSERT INTO room_members (room_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING"
  ).run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.get("/rooms/:id/messages", requireAuth, async (req, res) => {
  const room = await db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const member = await db.prepare(
    "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?"
  ).get(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: "You are not a member of this room" });

  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before ? parseInt(req.query.before) : Math.floor(Date.now() / 1000) + 1;

  const messages = (await db.prepare(
    `SELECT id, room_id, user_id, username, content, type, created_at
     FROM messages
     WHERE room_id = ? AND created_at < ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(req.params.id, before, limit)).reverse();

  res.json({ messages });
});

router.get("/rooms/:id/members", requireAuth, async (req, res) => {
  const members = await db.prepare(
    `SELECT u.id, u.username, u.role, rm.joined_at
     FROM users u
     INNER JOIN room_members rm ON rm.user_id = u.id
     WHERE rm.room_id = ?
     ORDER BY u.role DESC, u.username`
  ).all(req.params.id);
  res.json({ members });
});

// ── Users ─────────────────────────────────────────────────────────────────────

router.get("/users", requireAuth, requireRole("moderator"), async (req, res) => {
  const users = await db.prepare(
    "SELECT id, username, role, created_at FROM users ORDER BY created_at DESC"
  ).all();
  res.json({ users });
});

router.patch("/users/:id/role", requireAuth, requireRole("superadmin"), async (req, res) => {
  const { role } = req.body;
  if (!["member", "moderator", "superadmin"].includes(role))
    return res.status(400).json({ error: "Invalid role" });

  const target = await db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.id === req.user.id)
    return res.status(400).json({ error: "Cannot change your own role" });

  await db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  res.json({ ok: true });
});

module.exports = router;