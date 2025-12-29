// models/db.js  (libSQL / Turso compatible)
// Mantiene interfaz run/get/all/init como en SQLite, pero usando Turso remoto.

const { createClient } = require("@libsql/client");
const bcrypt = require("bcrypt");

/**
 * ENV (en Koyeb):
 *   DATABASE_URL=libsql://xxxx.turso.io
 *   DATABASE_AUTH_TOKEN=eyJhbGciOi...
 *
 * (Compat):
 *   LIBSQL_URL / LIBSQL_AUTH_TOKEN
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
 */

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.LIBSQL_URL ||
  process.env.TURSO_DATABASE_URL;

const DB_TOKEN =
  process.env.DATABASE_AUTH_TOKEN ||
  process.env.LIBSQL_AUTH_TOKEN ||
  process.env.TURSO_AUTH_TOKEN;

if (!DB_URL) {
  console.error("❌ Falta DATABASE_URL (o LIBSQL_URL / TURSO_DATABASE_URL)");
}
if (!DB_TOKEN) {
  console.error("❌ Falta DATABASE_AUTH_TOKEN (o LIBSQL_AUTH_TOKEN / TURSO_AUTH_TOKEN)");
}

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

// --- helpers schema ---
async function tableExists(name) {
  const r = await get(
    `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
    [name]
  );
  return !!r;
}

async function columnExists(table, col) {
  // PRAGMA table_info(tabla) devuelve {cid,name,type,...}
  const rows = await all(`PRAGMA table_info(${table});`);
  return rows.some((r) => String(r.name).toLowerCase() === String(col).toLowerCase());
}

async function ensureColumn(table, col, ddlSql) {
  const has = await columnExists(table, col);
  if (!has) {
    try {
      await run(ddlSql);
      console.log(`🟩 ${table}.${col} ensured`);
    } catch (e) {
      // si falla por race/ya existe, seguimos
      console.warn(`⚠️ No se pudo asegurar ${table}.${col}:`, e.message);
    }
  }
}

async function ensureTableUsers() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7
    );
  `);

  // columnas que tu app / admin usan
  await ensureColumn("users", "created_at", `ALTER TABLE users ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;`);
  await ensureColumn("users", "phone",      `ALTER TABLE users ADD COLUMN phone TEXT;`);
  await ensureColumn("users", "avatarUrl",  `ALTER TABLE users ADD COLUMN avatarUrl TEXT;`);

  // arreglar planes 0/null
  try {
    await run(`UPDATE users SET plan=7 WHERE plan IS NULL OR plan=0;`);
  } catch {}
}

async function ensureTableSubjects() {
  await run(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan INTEGER,
      year INTEGER,
      name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await ensureColumn("subjects", "created_at", `ALTER TABLE subjects ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;`);
}

async function ensureCoreTables() {
  // Scores juegos
  await run(`
    CREATE TABLE IF NOT EXISTS game_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      game TEXT,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Notificaciones
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      message TEXT,
      career TEXT DEFAULT '',
      plan INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Correlativas
  await run(`
    CREATE TABLE IF NOT EXISTS correlatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan INTEGER,
      data_json TEXT
    );
  `);

  // Docs (tu upload usa varios campos)
  await run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER,
      title TEXT,
      category TEXT,
      filename TEXT,
      mimetype TEXT,
      size INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await ensureColumn("documents", "level",     `ALTER TABLE documents ADD COLUMN level TEXT;`);
  await ensureColumn("documents", "group_uid", `ALTER TABLE documents ADD COLUMN group_uid TEXT;`);

  // Quizzes DB (si usás tablas)
  await run(`
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan INTEGER,
      subject TEXT,
      question TEXT,
      option_a TEXT,
      option_b TEXT,
      option_c TEXT,
      option_d TEXT,
      correct TEXT,
      explanation TEXT
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      career TEXT,
      plan INTEGER,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Finales (por si existe ruta)
  await run(`
    CREATE TABLE IF NOT EXISTS finals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER,
      career TEXT,
      plan INTEGER,
      year INTEGER,
      date TEXT,
      exam_type TEXT,
      modalidad TEXT,
      rendible INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    );
  `);
  // asegurar columnas usadas por versiones viejas/nuevas
  await ensureColumn("finals", "exam_type", `ALTER TABLE finals ADD COLUMN exam_type TEXT;`);
  await ensureColumn("finals", "modalidad", `ALTER TABLE finals ADD COLUMN modalidad TEXT;`);
  await ensureColumn("finals", "rendible",  `ALTER TABLE finals ADD COLUMN rendible INTEGER DEFAULT 1;`);

  // Profesores + reviews (tu sección profesores)
  await run(`
    CREATE TABLE IF NOT EXISTS professors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      photo_url TEXT,
      career TEXT,
      plan INTEGER DEFAULT 7
    );
  `);
  await ensureColumn("professors", "subjects_text", `ALTER TABLE professors ADD COLUMN subjects_text TEXT;`);

  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      professor_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      corre INTEGER,
      clases INTEGER,
      onda INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(professor_id) REFERENCES professors(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Grupos (tu sección grupos)
  await run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT,
      plan INTEGER,
      subject_id INTEGER,
      title TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      user_id INTEGER,
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      user_id INTEGER,
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Tutorial visto
  await run(`
    CREATE TABLE IF NOT EXISTS tutorial_seen (
      user_id INTEGER NOT NULL,
      section TEXT NOT NULL,
      seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(user_id, section),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

async function seedAdminIfMissing() {
  const admin = await get(`SELECT 1 AS ok FROM users WHERE role='admin' LIMIT 1`);
  if (admin) return;

  const email = process.env.ADMIN_EMAIL || "admin@demo.com";
  const pass  = process.env.ADMIN_PASS  || "admin123";
  const hash  = await bcrypt.hash(pass, 10);

  await run(
    `INSERT INTO users (name, email, pass_hash, role, career, plan, created_at)
     VALUES (?, ?, ?, 'admin', ?, ?, CURRENT_TIMESTAMP);`,
    ["Admin", email, hash, "Lic. en Administración de Empresas", 7]
  );

  console.log(`[DB] Admin creado: ${email} / ${pass}`);
}

async function init() {
  console.log("🟦 INIT START");

  // ping
  const ping = await get(`SELECT 1 AS ok;`);
  console.log("✅ Turso ping OK:", ping?.ok ?? 1);

  await ensureTableUsers();
  await ensureTableSubjects();
  await ensureCoreTables();
  await seedAdminIfMissing();

  console.log("🟦 INIT DONE");
  console.log("[DB] init OK (libSQL remoto)");
}

module.exports = { db, all, get, run, init };
