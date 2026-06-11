// src/auth.js — JWT utilities and Express/Socket middleware (async DB calls)
const jwt = require("jsonwebtoken");
const db = require("./db");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET is not set. Set it in your .env file.");
  process.exit(1);
}

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

// Check if user has a specific permission based on their role's permissions JSON
function hasPermission(user, permName) {
  if (!user) return false;
  // If permissions object is already parsed and attached
  if (user.permissions && user.permissions[permName]) return true;
  // Fallback: check role_permissions string
  if (user.role_permissions) {
    try {
      const perms = typeof user.role_permissions === 'string'
        ? JSON.parse(user.role_permissions)
        : user.role_permissions;
      return !!perms[permName];
    } catch {
      return false;
    }
  }
  return false;
}

// Express middleware — async
async function requireAuth(req, res, next) {
  const token =
    req.cookies?.token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null);

  if (!token) return res.status(401).json({ error: "Authentication required" });

  try {
    const payload = verifyToken(token);
    const user = await db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.role_id,
              r.name as role_name, r.color as role_color, r.level as role_level, r.permissions as role_permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`
    ).get(payload.id);
    if (!user) return res.status(401).json({ error: "User not found" });

    // Parse permissions from JSON string to object
    try {
      user.permissions = user.role_permissions
        ? (typeof user.role_permissions === 'string' ? JSON.parse(user.role_permissions) : user.role_permissions)
        : {};
    } catch {
      user.permissions = {};
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(role) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    // Check using role_level from DB first, then fall back to ROLE_LEVELS
    const userLevel = req.user.role_level !== undefined ? req.user.role_level : (ROLE_LEVELS[req.user.role] ?? -1);
    const requiredLevel = ROLE_LEVELS[role] ?? 99;
    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: `Requires ${role} role or higher` });
    }
    next();
  };
}

// Permission-based middleware
function requirePermission(permName) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!hasPermission(req.user, permName)) {
      return res.status(403).json({ error: `Requires '${permName}' permission` });
    }
    next();
  };
}

// Socket.IO middleware — async
async function socketAuth(socket, next) {
  const token =
    socket.handshake.auth?.token ||
    (socket.handshake.headers?.authorization?.startsWith("Bearer ")
      ? socket.handshake.headers.authorization.slice(7)
      : null);

  if (!token) return next(new Error("Authentication required"));

  try {
    const payload = verifyToken(token);
    const user = await db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.role_id,
              r.name as role_name, r.color as role_color, r.level as role_level, r.permissions as role_permissions
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`
    ).get(payload.id);
    if (!user) return next(new Error("User not found"));

    // Parse permissions from JSON string to object
    try {
      user.permissions = user.role_permissions
        ? (typeof user.role_permissions === 'string' ? JSON.parse(user.role_permissions) : user.role_permissions)
        : {};
    } catch {
      user.permissions = {};
    }

    socket.user = user;
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
}

module.exports = { signToken, verifyToken, hasRole, hasPermission, requireAuth, requireRole, requirePermission, socketAuth, ROLE_LEVELS };