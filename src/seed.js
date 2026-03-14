// src/seed.js — Run once to bootstrap superadmin and default rooms
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

const SUPERADMIN_USERNAME = process.env.SUPERADMIN_USERNAME || "admin";
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || "Admin@12345";

function seed() {
  console.log("Seeding database...");

  const existing = db
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(SUPERADMIN_USERNAME);

  if (existing) {
    console.log("Superadmin already exists. Skipping.");
    return;
  }

  const hash = bcrypt.hashSync(SUPERADMIN_PASSWORD, 12);
  const adminId = uuidv4();

  db.prepare(
    "INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, 'superadmin')"
  ).run(adminId, SUPERADMIN_USERNAME, hash);

  console.log(`Superadmin created: ${SUPERADMIN_USERNAME}`);

  const defaultRooms = [
    { name: "general",     description: "Company-wide announcements and discussions" },
    { name: "engineering", description: "Technical discussions for the engineering team" },
    { name: "random",      description: "Off-topic conversations and fun" },
  ];

  for (const room of defaultRooms) {
    const roomId = uuidv4();
    db.prepare(
      "INSERT INTO rooms (id, name, description, created_by, is_default) VALUES (?, ?, ?, ?, 1)"
    ).run(roomId, room.name, room.description, adminId);
    db.prepare(
      "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)"
    ).run(roomId, adminId);
    console.log(`Room created: #${room.name}`);
  }

  console.log("Seed complete.");
}

seed();