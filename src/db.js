// src/db.js — LibSQL client (works locally AND with Turso remote)
const { createClient } = require("@libsql/client");
const path = require("path");
const fs = require("fs");

const TURSO_URL   = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

let clientConfig;
if (TURSO_URL) {
  clientConfig = { url: TURSO_URL, authToken: TURSO_TOKEN };
  console.log("[DB] Turso remote database");
} else {
  const DATA_DIR = path.join(__dirname, "../data");
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  clientConfig = { url: `file:${path.join(DATA_DIR, "nexuschat.db")}` };
  console.log("[DB] Local SQLite file");
}

const client = createClient(clientConfig);

// Schema — split into individual statements for LibSQL compatibility
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_by  TEXT NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(room_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    content    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'message',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS invite_codes (
    code       TEXT PRIMARY KEY,
    label      TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    uses_max   INTEGER NOT NULL DEFAULT -1,
    uses_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id)`,
];

async function init() {
  for (const sql of SCHEMA_STATEMENTS) {
    await client.execute(sql);
  }
  console.log("[DB] Schema ready");
}

// Row array -> plain object
function rowToObj(row, columns) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

// prepare() — mirrors the better-sqlite3 API but returns Promises
// Usage: await db.prepare("SELECT ...").get(arg1, arg2)
function prepare(sql) {
  return {
    async get(...args) {
      const r = await client.execute({ sql, args: args.flat() });
      if (!r.rows.length) return null;
      return rowToObj(r.rows[0], r.columns);
    },
    async all(...args) {
      const r = await client.execute({ sql, args: args.flat() });
      return r.rows.map(row => rowToObj(row, r.columns));
    },
    async run(...args) {
      const r = await client.execute({ sql, args: args.flat() });
      return { changes: r.rowsAffected };
    },
  };
}

module.exports = { prepare, init };