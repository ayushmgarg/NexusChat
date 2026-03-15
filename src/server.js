// src/server.js — Entry point
const fs = require('fs');
const path = require('path');

// Load .env manually
try {
  const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8')
    .replace(/^\uFEFF/, ''); // strip BOM if present
  envFile.split('\n').forEach(line => {
    line = line.trim().replace(/\r/g, '');
    if (!line || line.startsWith('#')) return;
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
} catch(e) { console.log('ENV ERROR:', e.message); }
const express      = require("express");
const http         = require("http");
const { Server }   = require("socket.io");
const cookieParser = require("cookie-parser");
// path is already required above, do NOT require it again

const { init }          = require("./db");
const routes            = require("./routes");
const { setupSockets }  = require("./socket");

const PORT        = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

async function start() {
  // Initialize DB schema before accepting requests
  await init();

  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, {
    cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"], credentials: true },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Middleware ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // Security headers
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  });

  // Rate limiting on auth endpoints
  const rateLimitMap = new Map();
  app.use("/api/auth", (req, res, next) => {
    const ip       = req.ip;
    const now      = Date.now();
    const windowMs = 60_000;
    const max      = 15;
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const reqs = rateLimitMap.get(ip).filter(t => now - t < windowMs);
    reqs.push(now);
    rateLimitMap.set(ip, reqs);
    if (reqs.length > max)
      return res.status(429).json({ error: "Too many requests. Please slow down." });
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────
  app.use("/api", routes);
  app.use(express.static(path.join(__dirname, "../public")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
  });

  // ── Error handler ───────────────────────────────────────────────────────
  app.use((err, req, res, next) => {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: "Internal server error" });
  });

  setupSockets(io);

  server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║          NexusChat Server            ║
  ║   Running at http://localhost:${PORT}   ║
  ╚══════════════════════════════════════╝
    `);
  });
}

start().catch(e => { console.error("[FATAL]", e); process.exit(1); });