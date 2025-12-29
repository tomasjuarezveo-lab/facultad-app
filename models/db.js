// models/db.js (Turso/libSQL compatible)
// Mantiene all/get/run/init y crea tablas necesarias en la DB remota.

const { createClient } = require("@libsql/client");
const bcrypt = require("bcrypt");

/** Lee env vars de varios nombres posibles y hace trim. */
function readEnvTrim(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const DB_URL = readEnvTrim("DATABASE_URL", "TURSO_DATABASE_URL", "LIBSQL_URL");
const DB_TOKEN = readEnvTrim("DATABASE_AUTH_TOKEN", "TURSO_AUTH_TOKEN", "LIBSQL_AUTH_TOKEN");

// Logs útiles (no imprime el token completo)
console.log("✅ db.js cargado (libSQL/Turso)");
console.log("DB_URL:", DB_URL || "(VACIO)");
console.log("DB_TOKEN length:", DB_TOKEN ? DB_TOKEN.length : 0);
console.log("DB_TOKEN startsWith:", DB_TOKEN ? DB_TOKEN.slice(0, 12) + "..." : "(VACIO)");

const db = createClient({
  url: DB_URL,
  authToken: DB_TOKEN,
});

// Helpers compatibles con tu código actual
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

// Helpers de migración
async function columnExists(table, col) {
  try {
    const cols = await all(`PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === col);
  } catch {
    return false;
  }
}

/**
 * init(): crea tablas si no existen + migraciones suaves + seed admin
 * Importante: esto corre una vez al levantar el server.
 */
async function init() {
  console.log("🟦 INIT START");

  // Ping mínimo: si falla acá, es URL/token.
  const ping = await db.execute("SELECT 1 as ok");
  console.log("✅ Turso ping OK:", ping.rows?.[0]?.ok);

  // ===== Tablas base =====

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

  // Materias
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
  console.log("🟩 subjects table ensured");

  // Documentos (subidas)
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
      mimetype TEXT,
      size INTEGER,
      level TEXT,
      group_uid TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL
    )
  `);

  // Notificaciones
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

  // Correlativas (JSON)
  await run(`
    CREATE TABLE IF NOT EXISTS correlatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan TEXT,
      data_json TEXT
    )
  `);

  // Finales
  await run(`
    CREATE TABLE IF NOT EXISTS finals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan TEXT,
      subject TEXT,
      date TEXT,
      exam_type TEXT DEFAULT 'final'
        CHECK (exam_type IN ('final','parcial','recuperatorio','otro')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Profesores y reseñas
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

  // Tutorial flags
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

  // Quizzes
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

  // Juegos (scores)
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

  // ===== Grupos / Chats efímeros =====
  await run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT DEFAULT '',
      plan TEXT DEFAULT '',
      subject_id INTEGER,
      name TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      user_id INTEGER,
      joined_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      user_id INTEGER,
      message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // ===== Migraciones suaves (no rompen) =====
  try {
    const hasPhone = await columnExists("users", "phone");
    if (!hasPhone) {
      await run(`ALTER TABLE users ADD COLUMN phone TEXT`);
      console.log("[migración] users.phone agregado");
    }
  } catch (e) {
    console.log("No se pudo asegurar users.phone (continuo sin romper):", e?.message || e);
  }

  // ===== Seed admin =====
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
  console.log("🟦 INIT DONE");
}

module.exports = { db, all, get, run, init };
