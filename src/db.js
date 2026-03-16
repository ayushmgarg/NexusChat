const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

let pool;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family:4,
  });
  console.log('[DB] Supabase PostgreSQL');
} else {
  // Fallback: local SQLite via better-sqlite3 is gone
  // We just throw a clear error so you know to set DATABASE_URL
  throw new Error('DATABASE_URL is not set. Add your Supabase connection string to .env');
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_by  TEXT NOT NULL,
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    joined_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
    PRIMARY KEY(room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    username   TEXT NOT NULL,
    content    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'message',
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code       TEXT PRIMARY KEY,
    label      TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    uses_max   INTEGER NOT NULL DEFAULT -1,
    uses_count INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
`;

async function init() {
  // Run each statement separately
  const statements = SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const sql of statements) {
    await pool.query(sql);
  }
  console.log('[DB] Schema ready');
}

// prepare() — same API as before, works with pg
function prepare(sql) {
  // Convert SQLite ? placeholders to PostgreSQL $1 $2 $3
  function toPostgres(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  const pgSql = toPostgres(sql);

  return {
    async get(...args) {
      const res = await pool.query(pgSql, args.flat());
      return res.rows[0] || null;
    },
    async all(...args) {
      const res = await pool.query(pgSql, args.flat());
      return res.rows;
    },
    async run(...args) {
      const res = await pool.query(pgSql, args.flat());
      return { changes: res.rowCount };
    },
  };
}

module.exports = { prepare, init };