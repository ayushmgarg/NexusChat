const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const DATABASE_URL = process.env.DATABASE_URL;

let pool;
pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
// after pool is created
setInterval(() => pool.query('SELECT 1').catch(() => {}), 60000 * 4);

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

  ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id TEXT DEFAULT NULL;

  ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment TEXT DEFAULT NULL;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions TEXT DEFAULT NULL;

  CREATE TABLE IF NOT EXISTS roles (
    id          TEXT PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    level       INTEGER NOT NULL DEFAULT 0,
    color       TEXT NOT NULL DEFAULT '#8b949e',
    permissions TEXT NOT NULL DEFAULT '{}',
    is_system   INTEGER NOT NULL DEFAULT 0,
    created_by  TEXT,
    created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
  );

  CREATE TABLE IF NOT EXISTS user_room_state (
    user_id      TEXT NOT NULL,
    room_id      TEXT NOT NULL,
    last_read_at BIGINT DEFAULT 0,
    muted        INTEGER DEFAULT 0,
    PRIMARY KEY(user_id, room_id)
  );
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

  // Seed default system roles if they don't exist
  const defaultRoles = [
    {
      name: 'member',
      level: 0,
      color: '#8b949e',
      permissions: '{}',
      is_system: 1,
    },
    {
      name: 'moderator',
      level: 1,
      color: '#e5c23a',
      permissions: '{"can_kick":true,"can_create_rooms":true,"can_change_topic":true}',
      is_system: 1,
    },
    {
      name: 'superadmin',
      level: 2,
      color: '#f85149',
      permissions: '{"can_kick":true,"can_create_rooms":true,"can_change_topic":true,"can_delete_rooms":true,"can_manage_roles":true,"can_manage_invites":true,"can_promote":true,"can_change_display_names":true}',
      is_system: 1,
    },
  ];

  for (const role of defaultRoles) {
    const existing = await pool.query('SELECT id FROM roles WHERE name = $1', [role.name]);
    if (existing.rows.length === 0) {
      const id = uuidv4();
      await pool.query(
        'INSERT INTO roles (id, name, level, color, permissions, is_system) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, role.name, role.level, role.color, role.permissions, role.is_system]
      );
      console.log(`[DB] Seeded role: ${role.name}`);
    }
  }

  // Migration: set role_id for users that don't have one yet
  await pool.query(
    'UPDATE users SET role_id = (SELECT id FROM roles WHERE name = users.role) WHERE role_id IS NULL'
  );
  console.log('[DB] Role migration complete');
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