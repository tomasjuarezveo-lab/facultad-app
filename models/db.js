// models/db.js  (libSQL / Turso compatible)
// Helpers: all/get/run/init con auto-migraciones (tablas + columnas faltantes)

const { createClient } = require("@libsql/client");
const bcrypt = require("bcrypt");

// ---- ENV (acepta varios nombres para que no te vuelva loco) ----
function pickEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

const DB_URL = pickEnv("DATABASE_URL", "TURSO_DATABASE_URL", "LIBSQL_URL");
const DB_TOKEN = pickEnv("DATABASE_AUTH_TOKEN", "TURSO_AUTH_TOKEN", "LIBSQL_AUTH_TOKEN");

if (!DB_URL) {
  console.error("❌ Falta DATABASE_URL / TURSO_DATABASE_URL / LIBSQL_URL");
}
if (!DB_TOKEN) {
  console.error("❌ Falta DATABASE_AUTH_TOKEN / TURSO_AUTH_TOKEN / LIBSQL_AUTH_TOKEN");
}

const db = createClient({
  url: DB_URL,
  authToken: DB_TOKEN,
});

console.log("✅ db.js cargado (libSQL/Turso)");
console.log("DB_URL:", DB_URL ? DB_URL.replace(/\.aws-[^.]*/i, ".aws-***") : "(vacío)");
console.log("DB_TOKEN length:", DB_TOKEN ? DB_TOKEN.length : 0);
console.log("DB_TOKEN startsWith:", DB_TOKEN ? DB_TOKEN.slice(0, 12) + "..." : "(vacío)");

// ---- Helpers compatibles ----
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

// ---- Utils migraciones ----
function safeIdent(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_]/g, "");
}

async function tableExists(table) {
  const t = safeIdent(table);
  const r = await get(
    `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,
    [t]
  );
  return !!r;
}

async function colExists(table, col) {
  const t = safeIdent(table);
  const c = String(col || "");
  const r = await get(`SELECT 1 AS ok FROM pragma_table_info('${t}') WHERE name=? LIMIT 1`, [c]);
  return !!r;
}

async function ensureTable(table, createSql) {
  const t = safeIdent(table);
  await run(createSql);
  // No log ruidoso
}

async function ensureColumn(table, col, alterSql) {
  const t = safeIdent(table);
  const exists = await colExists(t, col);
  if (exists) return true;
  try {
    await run(alterSql);
  } catch (e) {
    // si falla, lo logueamos
    console.warn(`⚠️ No se pudo asegurar ${t}.${col}:`, e?.message || e);
    return false;
  }
  // re-check
  const nowExists = await colExists(t, col);
  return nowExists;
}

async function backfillIfNull(table, col, updateSql) {
  const t = safeIdent(table);
  const c = String(col || "");
  const exists = await colExists(t, c);
  if (!exists) return;
  try {
    await run(updateSql);
  } catch (e) {
    console.warn(`⚠️ Backfill ${t}.${c} falló:`, e?.message || e);
  }
}

async function ping() {
  const r = await get(`SELECT 1 AS ok`);
  console.log("✅ Turso ping OK:", r?.ok ?? 1);
}

// ---- INIT (crea/ajusta esquema para lo que usa tu app hoy) ----
async function init() {
  console.log("🟦 INIT START");
  await ping();

  // 1) Tablas base (con columnas “modernas” que tu código usa)
  await ensureTable(
    "users",
    `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      surname TEXT DEFAULT '',
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      phone TEXT DEFAULT '',
      avatarUrl TEXT DEFAULT '',
      points INTEGER DEFAULT 0,
      created_at TEXT
    )
    `
  );

  await ensureTable(
    "subjects",
    `
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      year INTEGER,
      name TEXT,
      subject_name TEXT,
      created_at TEXT
    )
    `
  );

  await ensureTable(
    "documents",
    `
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      category TEXT DEFAULT '',
      title TEXT DEFAULT '',
      filename TEXT DEFAULT '',
      mimetype TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      level TEXT DEFAULT '',
      group_uid TEXT DEFAULT '',
      url TEXT DEFAULT '',
      created_at TEXT,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL
    )
    `
  );

  await ensureTable(
    "notifications",
    `
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      message TEXT,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 0,
      created_at TEXT
    )
    `
  );

  await ensureTable(
    "professors",
    `
    CREATE TABLE IF NOT EXISTS professors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      name TEXT,
      photo_url TEXT DEFAULT '',
      subjects_text TEXT DEFAULT '',
      created_at TEXT
    )
    `
  );

  await ensureTable(
    "reviews",
    `
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      professor_id INTEGER,
      rating INTEGER,
      comment TEXT,
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(professor_id) REFERENCES professors(id) ON DELETE CASCADE
    )
    `
  );

  // Juegos: tu código usa points (no score)
  await ensureTable(
    "game_scores",
    `
    CREATE TABLE IF NOT EXISTS game_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      game TEXT,
      points INTEGER DEFAULT 0,
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  // Grupos (tu app lo necesita)
  await ensureTable(
    "groups",
    `
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      title TEXT DEFAULT '',
      expires_at TEXT,
      created_at TEXT
    )
    `
  );

  await ensureTable(
    "group_members",
    `
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      user_id INTEGER,
      joined_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  await ensureTable(
    "group_messages",
    `
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      user_id INTEGER,
      message TEXT,
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  // Correlativas: tu código intenta esquema v2 (subject_id, requires_json, final_aprobado)
  await ensureTable(
    "correlatives",
    `
    CREATE TABLE IF NOT EXISTS correlatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      subject_id INTEGER,
      requires_json TEXT DEFAULT '',
      final_aprobado INTEGER DEFAULT 0,
      data_json TEXT DEFAULT '',
      created_at TEXT
    )
    `
  );

  await ensureTable(
    "finals",
    `
    CREATE TABLE IF NOT EXISTS finals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      subject TEXT DEFAULT '',
      date TEXT DEFAULT '',
      exam_type TEXT DEFAULT 'final',
      rendible INTEGER DEFAULT 1,
      created_at TEXT
    )
    `
  );

  await ensureTable(
    "tutorial_seen",
    `
    CREATE TABLE IF NOT EXISTS tutorial_seen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      key TEXT,
      seen_at TEXT,
      UNIQUE(user_id, key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  // 2) Asegurar columnas faltantes SIN defaults “no constantes”
  // users.created_at: NO se puede ALTER con DEFAULT datetime('now') en libsql -> se agrega sin default y se backfillea.
  const usersCreated = await ensureColumn("users", "created_at", `ALTER TABLE users ADD COLUMN created_at TEXT`);
  if (usersCreated) {
    await backfillIfNull(
      "users",
      "created_at",
      `UPDATE users SET created_at = COALESCE(created_at, datetime('now'))`
    );
  }

  // users.points / avatarUrl / phone (por si venís de esquema viejo)
  await ensureColumn("users", "points", `ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0`);
  await ensureColumn("users", "avatarUrl", `ALTER TABLE users ADD COLUMN avatarUrl TEXT DEFAULT ''`);
  await ensureColumn("users", "phone", `ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''`);
  await ensureColumn("users", "surname", `ALTER TABLE users ADD COLUMN surname TEXT DEFAULT ''`);

  // subjects.subject_name (y si existe name, lo copiamos)
  const subName = await ensureColumn("subjects", "subject_name", `ALTER TABLE subjects ADD COLUMN subject_name TEXT`);
  if (subName) {
    // si hay name, copiar a subject_name cuando esté vacío
    try {
      await run(`UPDATE subjects SET subject_name = COALESCE(NULLIF(subject_name,''), name)`);
    } catch (_) {}
  }
  await ensureColumn("subjects", "created_at", `ALTER TABLE subjects ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "subjects",
    "created_at",
    `UPDATE subjects SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // game_scores.points: si venías con score, lo copiamos
  const hasScore = await colExists("game_scores", "score");
  const hasPoints = await colExists("game_scores", "points");
  if (!hasPoints) {
    await ensureColumn("game_scores", "points", `ALTER TABLE game_scores ADD COLUMN points INTEGER DEFAULT 0`);
  }
  if (hasScore) {
    try {
      await run(`UPDATE game_scores SET points = COALESCE(points, score)`);
    } catch (_) {}
  }
  await ensureColumn("game_scores", "created_at", `ALTER TABLE game_scores ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "game_scores",
    "created_at",
    `UPDATE game_scores SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // professors.photo_url / subjects_text / created_at
  await ensureColumn("professors", "photo_url", `ALTER TABLE professors ADD COLUMN photo_url TEXT DEFAULT ''`);
  await ensureColumn("professors", "subjects_text", `ALTER TABLE professors ADD COLUMN subjects_text TEXT DEFAULT ''`);
  await ensureColumn("professors", "created_at", `ALTER TABLE professors ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "professors",
    "created_at",
    `UPDATE professors SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // groups.subject_id / created_at
  await ensureColumn("groups", "subject_id", `ALTER TABLE groups ADD COLUMN subject_id INTEGER`);
  await ensureColumn("groups", "created_at", `ALTER TABLE groups ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "groups",
    "created_at",
    `UPDATE groups SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // correlatives v2 columns
  await ensureColumn("correlatives", "subject_id", `ALTER TABLE correlatives ADD COLUMN subject_id INTEGER`);
  await ensureColumn("correlatives", "requires_json", `ALTER TABLE correlatives ADD COLUMN requires_json TEXT DEFAULT ''`);
  await ensureColumn("correlatives", "final_aprobado", `ALTER TABLE correlatives ADD COLUMN final_aprobado INTEGER DEFAULT 0`);
  await ensureColumn("correlatives", "created_at", `ALTER TABLE correlatives ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "correlatives",
    "created_at",
    `UPDATE correlatives SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // finals.rendible / exam_type / created_at
  await ensureColumn("finals", "exam_type", `ALTER TABLE finals ADD COLUMN exam_type TEXT DEFAULT 'final'`);
  await ensureColumn("finals", "rendible", `ALTER TABLE finals ADD COLUMN rendible INTEGER DEFAULT 1`);
  await ensureColumn("finals", "created_at", `ALTER TABLE finals ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "finals",
    "created_at",
    `UPDATE finals SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // documents extra cols
  await ensureColumn("documents", "mimetype", `ALTER TABLE documents ADD COLUMN mimetype TEXT DEFAULT ''`);
  await ensureColumn("documents", "size", `ALTER TABLE documents ADD COLUMN size INTEGER DEFAULT 0`);
  await ensureColumn("documents", "level", `ALTER TABLE documents ADD COLUMN level TEXT DEFAULT ''`);
  await ensureColumn("documents", "group_uid", `ALTER TABLE documents ADD COLUMN group_uid TEXT DEFAULT ''`);
  await ensureColumn("documents", "created_at", `ALTER TABLE documents ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "documents",
    "created_at",
    `UPDATE documents SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // notifications.created_at / plan tipo int
  await ensureColumn("notifications", "created_at", `ALTER TABLE notifications ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "notifications",
    "created_at",
    `UPDATE notifications SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // 3) Seed admin si no existe
  const admin = await get(`SELECT * FROM users WHERE role='admin' LIMIT 1`);
  if (!admin) {
    const email = process.env.ADMIN_EMAIL || "admin@demo.com";
    const pass = process.env.ADMIN_PASS || "admin123";
    const pass_hash = await bcrypt.hash(pass, 10);
    await run(
      `INSERT INTO users (name, email, pass_hash, role, career, plan, created_at)
       VALUES (?, ?, ?, 'admin', '', 7, datetime('now'))`,
      ["Admin", email, pass_hash]
    );
    console.log(`[DB] Admin creado: ${email} / ${pass}`);
  }

  console.log("[DB] init OK (libSQL remoto)");
  console.log("🟦 INIT DONE");
}

module.exports = { db, all, get, run, init };
