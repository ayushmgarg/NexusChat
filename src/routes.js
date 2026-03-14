// src/routes.js — REST API endpoints
const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const { signToken, requireAuth, requireRole } = require("./auth");

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────

router.post("/auth/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: "Username must be 3–20 characters" });
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return res.status(400).json({ error: "Username may only contain letters, numbers, _ and -" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return res.status(409).json({ error: "Username already taken" });

  const hash = bcrypt.hashSync(password, 12);
  const id = uuidv4();
  db.prepare(
    "INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'member')"
  ).run(id, username, hash);

  // Auto-join all default rooms
  const defaultRooms = db.prepare("SELECT id FROM rooms WHERE is_default = 1").all();
  const insertMember = db.prepare(
    "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)"
  );
  for (const room of defaultRooms) insertMember.run(room.id, id);

  const token = signToken({ id });
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ token, user: { id, username, role: "member" } });
});

router.post("/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: "Invalid credentials" });

  const token = signToken({ id: user.id });
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

router.post("/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── Rooms ─────────────────────────────────────────────────────────────────────

router.get("/rooms", requireAuth, (req, res) => {
  const rooms = db
    .prepare(
      `SELECT r.id, r.name, r.description, r.is_default, r.created_at,
              u.username as created_by,
              (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) as member_count
       FROM rooms r
       LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.is_default DESC, r.name ASC`
    )
    .all();
  res.json({ rooms });
});

router.post("/rooms", requireAuth, requireRole("moderator"), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "Room name required" });

  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (slug.length < 2 || slug.length > 30)
    return res.status(400).json({ error: "Room name must be 2–30 characters" });

  const existing = db.prepare("SELECT id FROM rooms WHERE name = ?").get(slug);
  if (existing) return res.status(409).json({ error: "Room name already in use" });

  const id = uuidv4();
  db.prepare(
    "INSERT INTO rooms (id, name, description, created_by) VALUES (?, ?, ?, ?)"
  ).run(id, slug, description || "", req.user.id);
  db.prepare("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)").run(id, req.user.id);

  const room = db
    .prepare(
      `SELECT r.*, u.username as created_by
       FROM rooms r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ?`
    )
    .get(id);
  res.status(201).json({ room });
});

router.delete("/rooms/:id", requireAuth, requireRole("superadmin"), (req, res) => {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.is_default) return res.status(403).json({ error: "Cannot delete default rooms" });

  db.prepare("DELETE FROM rooms WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.post("/rooms/:id/join", requireAuth, (req, res) => {
  const room = db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });

  db.prepare(
    "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)"
  ).run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.get("/rooms/:id/messages", requireAuth, (req, res) => {
  const room = db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).json({ error: "Room not found" });

  const member = db
    .prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?")
    .get(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: "You are not a member of this room" });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before ? parseInt(req.query.before) : Date.now() / 1000 + 1;

  const messages = db
    .prepare(
      `SELECT id, room_id, user_id, username, content, type, created_at
       FROM messages
       WHERE room_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(req.params.id, before, limit)
    .reverse();

  res.json({ messages });
});

router.get("/rooms/:id/members", requireAuth, (req, res) => {
  const members = db
    .prepare(
      `SELECT u.id, u.username, u.role, rm.joined_at
       FROM users u
       INNER JOIN room_members rm ON rm.user_id = u.id
       WHERE rm.room_id = ?
       ORDER BY u.role DESC, u.username`
    )
    .all(req.params.id);
  res.json({ members });
});

// ── Users ─────────────────────────────────────────────────────────────────────

router.get("/users", requireAuth, requireRole("moderator"), (req, res) => {
  const users = db
    .prepare("SELECT id, username, role, created_at FROM users ORDER BY created_at DESC")
    .all();
  res.json({ users });
});

router.patch("/users/:id/role", requireAuth, requireRole("superadmin"), (req, res) => {
  const { role } = req.body;
  if (!["member", "moderator", "superadmin"].includes(role))
    return res.status(400).json({ error: "Invalid role" });

  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.id === req.user.id)
    return res.status(400).json({ error: "Cannot change your own role" });

  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, req.params.id);
  res.json({ ok: true });
});

module.exports = router;