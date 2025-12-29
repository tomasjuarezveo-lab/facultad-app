// models/db.js (Turso/libSQL compatible)
// Mantiene all/get/run/init y crea TODAS las tablas necesarias.

const { createClient } = require("@libsql/client");
const bcrypt = require("bcrypt");

function readEnvTrim(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const DB_URL = readEnvTrim("DATABASE_URL", "TURSO_DATABASE_URL", "LIBSQL_URL");
const DB_TOKEN = readEnvTrim("DATABASE_AUTH_TOKEN", "TURSO_AUTH_TOKEN", "LIBSQL_AUTH_TOKEN");

console.log("✅ db.js cargado (libSQL/Turso)");
console.log("DB_URL:", DB_URL || "(VACIO)");
console.log("DB_TOKEN length:", DB_TOKEN ? DB_TOKEN.length : 0);
console.log("DB_TOKEN startsWith:", DB_TOKEN ? DB_TOKEN.slice(0, 12) + "..." : "(VACIO)");

const db = createClient({
  url: DB_URL,
  authToken: DB_TOKEN,
});

async function run(sql, params = []) {
  return db.execute({ sql, args: params });
}

async function get(sql, params = []) {
  const r = await db.execute({ sql, args: params });
  return r.rows && r.rows.length ? r.rows[0] : null;
}

async function all(sql, params = []) {
  const r = await db.execute({ sql, args: params });
  return r.rows || [];
}

// Helpers migración
async function tableExists(name) {
  const r = await get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [name]
  );
  return !!r;
}

async function columnExists(table, col) {
  try {
    const cols = await all(`PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === col);
  } catch {
    return false;
  }
}

async function init() {
  // 1) Ping
  const ping = await db.execute("SELECT 1 as ok");
  console.log("✅ Turso ping OK:", ping.rows?.[0]?.ok);

  // 2) Crear tablas base (todas las que usa tu app)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      career TEXT DEFAULT '',
      plan TEXT DEFAULT ''
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan TEXT,
      year INTEGER,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER,
      career TEXT,
      plan TEXT,
      category TEXT,
      title TEXT,
      filename TEXT,
      url TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      message TEXT,
      career TEXT DEFAULT '',
      plan TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS correlatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan TEXT,
      data_json TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS finals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan TEXT,
      subject TEXT,
      date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS professors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan TEXT,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      professor_id INTEGER,
      rating INTEGER,
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(professor_id) REFERENCES professors(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS tutorial_seen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      key TEXT,
      seen_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan TEXT,
      subject TEXT,
      question TEXT,
      option_a TEXT,
      option_b TEXT,
      option_c TEXT,
      option_d TEXT,
      correct TEXT,
      explanation TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      career TEXT,
      plan TEXT,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS game_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      game TEXT,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 3) Migraciones suaves (no rompen si ya existen)
  // users.phone (si tu app lo usa)
  try {
    const hasPhone = await columnExists("users", "phone");
    if (!hasPhone) {
      await run(`ALTER TABLE users ADD COLUMN phone TEXT`);
      console.log("[migración] users: columna phone agregada");
    }
  } catch (e) {
    console.log("No se pudo asegurar users.phone (continuo sin romper):", e?.message || e);
  }

  // 4) Seed admin si no existe
  const admin = await get(`SELECT * FROM users WHERE role='admin' LIMIT 1`);
  if (!admin) {
    const email = process.env.ADMIN_EMAIL || "admin@demo.com";
    const pass = process.env.ADMIN_PASS || "admin123";
    const pass_hash = await bcrypt.hash(pass, 10);
    await run(
      `INSERT INTO users (name, email, pass_hash, role) VALUES (?, ?, ?, 'admin')`,
      ["Admin", email, pass_hash]
    );
    console.log(`[DB] Admin creado: ${email} / ${pass}`);
  }

  console.log("[DB] init OK (libSQL remoto)");
}

module.exports = { db, all, get, run, init };
