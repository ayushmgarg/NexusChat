// src/auth.js — JWT utilities and middleware
const jwt = require("jsonwebtoken");
const db = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "nexuschat-dev-secret-change-in-production";
const JWT_EXPIRY = "7d";
const ROLE_LEVELS = { member: 0, moderator: 1, superadmin: 2 };

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function hasRole(userRole, requiredRole) {
  return (ROLE_LEVELS[userRole] ?? -1) >= (ROLE_LEVELS[requiredRole] ?? 99);
}

function requireAuth(req, res, next) {
  const token =
    req.cookies?.token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) return res.status(401).json({ error: "Authentication required" });

  try {
    const payload = verifyToken(token);
    const user = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(payload.id);
    if (!user) return res.status(401).json({ error: "User not found" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!hasRole(req.user.role, role)) {
      return res.status(403).json({ error: `Requires ${role} role or higher` });
    }
    next();
  };
}

function socketAuth(socket, next) {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.slice(7);

  if (!token) return next(new Error("Authentication required"));

  try {
    const payload = verifyToken(token);
    const user = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(payload.id);
    if (!user) return next(new Error("User not found"));
    socket.user = user;
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
}

module.exports = { signToken, verifyToken, hasRole, requireAuth, requireRole, socketAuth, ROLE_LEVELS };