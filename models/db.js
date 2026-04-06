// models/db.js  (libSQL / Turso compatible)
// Helpers: all/get/run/init con auto-migraciones (tablas + columnas faltantes)
require("dotenv").config();
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
// FIX: libSQL/hrana NO acepta undefined, BigInt, Date u objetos en args
function sanitizeArgs(params) {
  if (!Array.isArray(params)) return [];
  return params.map((v) => {
    if (v === undefined) return null;
    if (v === null) return null;

    // BigInt (ej: lastInsertRowid o valores calculados)
    if (typeof v === "bigint") return Number(v);

    // Date
    if (v instanceof Date) return v.toISOString();

    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;

    // objetos/arrays -> JSON string (para no crashear)
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}

async function run(sql, params = []) {
  return db.execute({ sql, args: sanitizeArgs(params) });
}

async function get(sql, params = []) {
  const r = await db.execute({ sql, args: sanitizeArgs(params) });
  return r.rows && r.rows.length ? r.rows[0] : null;
}

async function all(sql, params = []) {
  const r = await db.execute({ sql, args: sanitizeArgs(params) });
  return r.rows || [];
}

// ---- Utils migraciones ----
function safeIdent(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_]/g, "");
}

// Canonical key para unificar materias repetidas entre carreras/planes (sin tildes, sin símbolos)
function canonKey(v) {
  let s = String(v ?? "").trim().toLowerCase();
  try {
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch (_) {}
  s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return s;
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

  // PRAGMA table_info(...) es la forma más confiable en SQLite/libSQL
  try {
    const rows = await all(`PRAGMA table_info(${t})`);
    return Array.isArray(rows) && rows.some((r) => {
      const nm = r?.name ?? r?.["name"] ?? r?.column_name ?? r?.["column_name"];
      return String(nm) === c;
    });
  } catch (e) {
    // fallback (por si PRAGMA falla en algún entorno raro)
    const r = await get(
      `SELECT 1 AS ok FROM pragma_table_info('${t}') WHERE name=? LIMIT 1`,
      [c]
    );
    return !!r;
  }
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
    const msg = String(e?.message || e || "");
    // Idempotencia: si ya existe, lo tomamos como OK
    if (/duplicate column name/i.test(msg) || /already exists/i.test(msg)) return true;

    console.warn(`⚠️ No se pudo asegurar ${t}.${col}:`, msg);
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
  try {
    const r = await get(`SELECT 1 AS ok`);
    console.log("✅ Turso ping OK:", r?.ok ?? 1);
  } catch (e) {
    console.error("❌ Turso ping FALLÓ:", e?.message || e);
    throw e;
  }
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
      instagram_username TEXT DEFAULT '',
      pass_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      career_plan_completed INTEGER DEFAULT 1,
      google_id TEXT DEFAULT NULL,
      microsoft_id TEXT DEFAULT NULL,
      phone TEXT DEFAULT '',
      avatarUrl TEXT DEFAULT '',
      verification_code TEXT DEFAULT NULL,
      is_verified INTEGER DEFAULT 0,
      points INTEGER DEFAULT 0,
      terms_accepted_at TEXT DEFAULT NULL,
      privacy_accepted_at TEXT DEFAULT NULL,
      created_at TEXT
    )
    `
  );

  // ===== PERFIL: follows + posts (para perfiles públicos y feed) =====
  await ensureTable(
    "follows",
    `
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(follower_id, following_id),
      FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  await ensureTable(
    "profile_posts",
    `
    CREATE TABLE IF NOT EXISTS profile_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      deleted INTEGER DEFAULT 0,
      FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  // ===== AGENDA (recordatorios) =====
  await ensureTable(
    "agenda_events",
    `
    CREATE TABLE IF NOT EXISTS agenda_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      title TEXT DEFAULT '',
      text TEXT DEFAULT '',
      color TEXT DEFAULT '#22c55e',
      repeat_json TEXT DEFAULT '',
      from_ymd TEXT NOT NULL,
      to_ymd TEXT NOT NULL,
      important INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted INTEGER DEFAULT 0,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  await run(`CREATE INDEX IF NOT EXISTS idx_agenda_owner ON agenda_events(owner_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_agenda_range ON agenda_events(from_ymd, to_ymd)`);
  try {
    await run(`DROP TABLE IF EXISTS temp_analytics`);
  } catch (_) {}

  await ensureTable(
    "subjects",
    `
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      year INTEGER,
      semester INTEGER,
      name TEXT,
      subject_name TEXT,
      canonical_key TEXT,
      created_at TEXT
    )
    `
  );

  // ✅ Seguridad: limitar a 2 dispositivos por cuenta (Koyeb + Render comparten DB/sesiones)
  await ensureTable(
    "device_sessions",
    `
    CREATE TABLE IF NOT EXISTS device_sessions (
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      sid TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (user_id, device_id),
      UNIQUE (sid)
    )
    `
  );

  await ensureColumn(
    "users",
    "multi_device_logout_notice",
    `ALTER TABLE users ADD COLUMN multi_device_logout_notice INTEGER DEFAULT 0`
  );
  await ensureColumn(
    "users",
    "multi_device_logout_at",
    `ALTER TABLE users ADD COLUMN multi_device_logout_at INTEGER`
  );

  await ensureTable(
    "questions_bank",
    `
    CREATE TABLE IF NOT EXISTS questions_bank (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_key TEXT,
      career TEXT,
      subject_name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT '',
      raw_text TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      created_by INTEGER,
      UNIQUE(canonical_key, career)
    )
    `
  );

  // ✅ Si la tabla ya existía con el schema viejo, agregamos columnas nuevas
  await ensureColumn(
    "questions_bank",
    "canonical_key",
    `ALTER TABLE questions_bank ADD COLUMN canonical_key TEXT`
  );
  await ensureColumn(
    "questions_bank",
    "career",
    `ALTER TABLE questions_bank ADD COLUMN career TEXT`
  );

  // ✅ Asegurar índice único para canonical_key+career (compatibilidad con tablas ya creadas)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_bank_canonical_career ON questions_bank(canonical_key, career)`);

  // ✅ Backfill: usar subjects (plan + name) para completar canonical_key y career
  await run(`UPDATE questions_bank SET plan=COALESCE(plan,'') WHERE plan IS NULL`);

  await run(`
    UPDATE questions_bank
       SET canonical_key = (
         SELECT s.canonical_key
           FROM subjects s
          WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(questions_bank.subject_name))
            AND CAST(s.plan AS TEXT) = CAST(questions_bank.plan AS TEXT)
          LIMIT 1
       )
     WHERE (canonical_key IS NULL OR canonical_key = '')
  `);

  await run(`
    UPDATE questions_bank
       SET career = (
         SELECT s.career
           FROM subjects s
          WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(questions_bank.subject_name))
            AND CAST(s.plan AS TEXT) = CAST(questions_bank.plan AS TEXT)
          LIMIT 1
       )
     WHERE (career IS NULL OR career = '')
  `);

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
    "classes_sections",
    `
    CREATE TABLE IF NOT EXISTS classes_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(subject_id, name),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
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

  // Votos por comentario (likes/dislikes)
  await ensureTable(
    "review_votes",
    `
    CREATE TABLE IF NOT EXISTS review_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER,
      user_id INTEGER,
      vote INTEGER DEFAULT 0,     -- 1 like, -1 dislike
      created_at TEXT,
      UNIQUE(review_id, user_id),
      FOREIGN KEY(review_id) REFERENCES reviews(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  // Autoevaluaciones: intentos
  await ensureTable(
    "quiz_attempts",
    `
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      subject_id INTEGER,
      score INTEGER DEFAULT 0,
      total INTEGER DEFAULT 10,
      answers_json TEXT DEFAULT '',
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  // === (LEGACY) user_follows (si algún módulo viejo lo usa) ===
  // OJO: en este archivo el cliente se llama `db` y el método correcto es `run()`.
  // Si no usás `user_follows`, podés borrar este bloque entero sin problema.
  await run(`
    CREATE TABLE IF NOT EXISTS user_follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, followed_id)
    )
  `);

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_follows_followed ON user_follows(followed_id)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_follows_follower ON user_follows(follower_id)`);
  } catch (_) {}

  // Sesiones compartidas (para múltiples servidores: Koyeb/Render)
  await ensureTable(
    "sessions",
    `
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire INTEGER
    )
    `
  );
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_device_sessions_user_updated ON device_sessions(user_id, updated_at)`);
  } catch (_) {}

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

  // IMPORTANTE: estas tablas se crean "compatibles" con viejo+nuevo
  await ensureTable(
    "group_members",
    `
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      subject_id INTEGER,
      user_id INTEGER,
      joined_at TEXT,
      chat_type TEXT DEFAULT 'finales',
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
      subject_id INTEGER,
      user_id INTEGER,
      message TEXT,
      text TEXT,
      attachment_url TEXT,
      attachment_type TEXT,
      created_at TEXT,
      chat_type TEXT DEFAULT 'finales',
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
      subject_id INTEGER,
      subject TEXT DEFAULT '',
      year INTEGER,
      date TEXT DEFAULT '',
      modalidad TEXT DEFAULT 'regular',
      libre TEXT DEFAULT '',
      regular TEXT DEFAULT '',
      exam_type TEXT DEFAULT 'final',
      rendible INTEGER DEFAULT 1,
      prob_regular INTEGER DEFAULT 0,
      prob_libre INTEGER DEFAULT 0,
      top_units_json TEXT DEFAULT '[]',
      best_months TEXT DEFAULT '',
      worst_months TEXT DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    )
    `
  );

  await ensureTable(
    "cursadas",
    `
    CREATE TABLE IF NOT EXISTS cursadas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT DEFAULT '',
      plan INTEGER DEFAULT 7,
      subject_id INTEGER,
      year INTEGER,
      schedule_text TEXT DEFAULT '',
      approval_pct INTEGER DEFAULT 0,
      promotion_pct INTEGER DEFAULT 0,
      class_type TEXT DEFAULT '',
      teachers_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(career, plan, subject_id)
    )
    `
  );

  await ensureTable(
    "cursada_reactions",
    `
    CREATE TABLE IF NOT EXISTS cursada_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cursada_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(cursada_id, user_id)
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

  // ✅ Correlativas: materias “aprobadas” persistentes por usuario (cross-device)
  await ensureTable(
    "user_subject_checks",
    `
    CREATE TABLE IF NOT EXISTS user_subject_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      done INTEGER DEFAULT 0,
      updated_at TEXT,
      UNIQUE(user_id, subject_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_user_subject_checks_user ON user_subject_checks(user_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_user_subject_checks_subject ON user_subject_checks(subject_id)`);
  } catch (_) {}

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
  await ensureColumn("users", "instagram_username", `ALTER TABLE users ADD COLUMN instagram_username TEXT DEFAULT ''`);
  await ensureColumn("users", "phone", `ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''`);
  await ensureColumn("users", "surname", `ALTER TABLE users ADD COLUMN surname TEXT DEFAULT ''`);
  await ensureColumn("users", "bio", `ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
  await ensureColumn("agenda_events", "source_kind", `ALTER TABLE agenda_events ADD COLUMN source_kind TEXT DEFAULT ''`);
  await ensureColumn("users", "terms_accepted_at", `ALTER TABLE users ADD COLUMN terms_accepted_at TEXT DEFAULT NULL`);
  await ensureColumn("users", "affinity_approved_subject_ids", `ALTER TABLE users ADD COLUMN affinity_approved_subject_ids TEXT DEFAULT '[]'`);
  await ensureColumn("users", "affinity_current_subject_ids", `ALTER TABLE users ADD COLUMN affinity_current_subject_ids TEXT DEFAULT '[]'`);
  await ensureColumn("users", "affinity_interests_json", `ALTER TABLE users ADD COLUMN affinity_interests_json TEXT DEFAULT '{}'`);
  await ensureColumn("users", "affinity_completed_at", `ALTER TABLE users ADD COLUMN affinity_completed_at TEXT DEFAULT NULL`);
  await ensureColumn("users", "terms_accepted_at", `ALTER TABLE users ADD COLUMN terms_accepted_at TEXT DEFAULT NULL`);
  await ensureColumn("users", "privacy_accepted_at", `ALTER TABLE users ADD COLUMN privacy_accepted_at TEXT DEFAULT NULL`);
  await ensureColumn("users", "verification_code", `ALTER TABLE users ADD COLUMN verification_code TEXT`);
  await ensureColumn("users", "is_verified", `ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0`);

  // Backfill: no bloquear usuarios ya existentes
  try {
    await run(`UPDATE users SET is_verified = 1 WHERE COALESCE(verification_code, '') = ''`);
  } catch (_) {}
    await ensureColumn("users", "career_plan_completed", `ALTER TABLE users ADD COLUMN career_plan_completed INTEGER DEFAULT 1`);
  await backfillIfNull(
    "users",
    "career_plan_completed",
    `UPDATE users SET career_plan_completed = COALESCE(career_plan_completed, 1)`
  );
    try {
  await run(`
    UPDATE users
    SET terms_accepted_at = datetime('now')
    WHERE (
      (google_id IS NOT NULL AND TRIM(google_id) <> '')
      OR
      (microsoft_id IS NOT NULL AND TRIM(microsoft_id) <> '')
    )
    AND COALESCE(TRIM(terms_accepted_at), '') = ''
  `);
} catch (_) {}

try {
  await run(`
    UPDATE users
    SET privacy_accepted_at = datetime('now')
    WHERE (
      (google_id IS NOT NULL AND TRIM(google_id) <> '')
      OR
      (microsoft_id IS NOT NULL AND TRIM(microsoft_id) <> '')
    )
    AND COALESCE(TRIM(privacy_accepted_at), '') = ''
  `);
} catch (_) {}

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

  // ✅ Unificar materias repetidas (entre carreras/planes) con una clave canónica por nombre
  await ensureColumn("subjects", "canonical_key", `ALTER TABLE subjects ADD COLUMN canonical_key TEXT`);

  // ✅ Semester (1 / 2) para filtros por semestre en /app/materias
  await ensureColumn("subjects", "semester", `ALTER TABLE subjects ADD COLUMN semester INTEGER`);

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_subjects_semester ON subjects(career, plan, year, semester)`);
  } catch (_) {}

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_subjects_canonical_key ON subjects(canonical_key)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_subjects_listing ON subjects(career, plan, year, semester, name)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email))`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL AND TRIM(google_id) <> ''`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_users_microsoft_id ON users(microsoft_id) WHERE microsoft_id IS NOT NULL AND TRIM(microsoft_id) <> ''`);
  } catch (_) {}

  // Backfill canonical_key si está vacío
  try {
    const rows = await all(`
      SELECT id, COALESCE(NULLIF(subject_name,''), NULLIF(name,'')) AS nm, COALESCE(canonical_key,'') AS ck
      FROM subjects
    `);
    for (const r of rows) {
      const ck = String(r.ck || "").trim();
      if (ck) continue;
      const key = canonKey(r.nm || "");
      if (!key) continue;
      await run(`UPDATE subjects SET canonical_key=? WHERE id=?`, [key, r.id]);
    }
  } catch (e) {
    console.warn("⚠️ Backfill subjects.canonical_key falló:", e?.message || e);
  }

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

  // reviews: created_at + sub-métricas (profesores)
  await ensureColumn("reviews", "created_at", `ALTER TABLE reviews ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "reviews",
    "created_at",
    `UPDATE reviews SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // Sub-scores (1..10) y métricas nuevas
  await ensureColumn("reviews", "corre", `ALTER TABLE reviews ADD COLUMN corre INTEGER`);
  await ensureColumn("reviews", "clases", `ALTER TABLE reviews ADD COLUMN clases INTEGER`);
  await ensureColumn("reviews", "onda", `ALTER TABLE reviews ADD COLUMN onda INTEGER`);
  await ensureColumn("reviews", "tp_imp", `ALTER TABLE reviews ADD COLUMN tp_imp INTEGER`);
  await ensureColumn("reviews", "exam_imp", `ALTER TABLE reviews ADD COLUMN exam_imp INTEGER`);
  await ensureColumn("reviews", "biblio_imp", `ALTER TABLE reviews ADD COLUMN biblio_imp INTEGER`);
  await ensureColumn("reviews", "focus", `ALTER TABLE reviews ADD COLUMN focus TEXT`);

  // review_votes columnas por si existía una versión vieja
  await ensureColumn("review_votes", "vote", `ALTER TABLE review_votes ADD COLUMN vote INTEGER DEFAULT 0`);
  await ensureColumn("review_votes", "created_at", `ALTER TABLE review_votes ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "review_votes",
    "created_at",
    `UPDATE review_votes SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // quiz_attempts.subject_id (schema viejo no lo tenía)
  await ensureColumn("quiz_attempts", "subject_id", `ALTER TABLE quiz_attempts ADD COLUMN subject_id INTEGER`);

  // quiz_attempts.answers_json / total por si venías de un esquema anterior
  await ensureColumn("quiz_attempts", "answers_json", `ALTER TABLE quiz_attempts ADD COLUMN answers_json TEXT DEFAULT ''`);
  await ensureColumn("quiz_attempts", "total", `ALTER TABLE quiz_attempts ADD COLUMN total INTEGER DEFAULT 10`);
  await ensureColumn("quiz_attempts", "score", `ALTER TABLE quiz_attempts ADD COLUMN score INTEGER DEFAULT 0`);

  // quiz_attempts.created_at
  await ensureColumn("quiz_attempts", "created_at", `ALTER TABLE quiz_attempts ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "quiz_attempts",
    "created_at",
    `UPDATE quiz_attempts SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // groups.subject_id / created_at
  await ensureColumn("groups", "subject_id", `ALTER TABLE groups ADD COLUMN subject_id INTEGER`);
  await ensureColumn("groups", "created_at", `ALTER TABLE groups ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "groups",
    "created_at",
    `UPDATE groups SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // =========================
  // GRUPOS: compatibilidad esquema viejo -> nuevo
  // (evita crash por columnas faltantes como m.attachment_url)
  // + NUEVO: chat_type para separar "cursos" vs "finales"
  // =========================
  await ensureColumn("group_members", "subject_id", `ALTER TABLE group_members ADD COLUMN subject_id INTEGER`);
  await ensureColumn("group_members", "joined_at", `ALTER TABLE group_members ADD COLUMN joined_at TEXT`);

  // separar membresía por tipo: 'cursos' | 'finales'  (lo viejo queda como 'finales')
  await ensureColumn(
    "group_members",
    "chat_type",
    `ALTER TABLE group_members ADD COLUMN chat_type TEXT DEFAULT 'finales'`
  );

  await ensureColumn("group_messages", "subject_id", `ALTER TABLE group_messages ADD COLUMN subject_id INTEGER`);
  await ensureColumn("group_messages", "text", `ALTER TABLE group_messages ADD COLUMN text TEXT`);
  await ensureColumn("group_messages", "attachment_url", `ALTER TABLE group_messages ADD COLUMN attachment_url TEXT`);
  await ensureColumn("group_messages", "attachment_type", `ALTER TABLE group_messages ADD COLUMN attachment_type TEXT`);
  await ensureColumn("group_messages", "created_at", `ALTER TABLE group_messages ADD COLUMN created_at TEXT`);

  // separar mensajes por tipo también
  await ensureColumn(
    "group_messages",
    "chat_type",
    `ALTER TABLE group_messages ADD COLUMN chat_type TEXT DEFAULT 'finales'`
  );

  // Backfill subject_id desde groups cuando existía group_id
  try {
    const gmHasGroupId = await colExists("group_members", "group_id");
    const gHasSubjectId = await colExists("groups", "subject_id");
    if (gmHasGroupId && gHasSubjectId) {
      await run(
        `UPDATE group_members
            SET subject_id = COALESCE(subject_id, (SELECT g.subject_id FROM groups g WHERE g.id = group_members.group_id))
          WHERE (subject_id IS NULL OR subject_id = 0) AND group_id IS NOT NULL`
      );
    }
  } catch (e) {
    console.warn("⚠️ Backfill group_members.subject_id falló:", e?.message || e);
  }

  try {
    const msgHasGroupId = await colExists("group_messages", "group_id");
    const msgHasMessage = await colExists("group_messages", "message");
    const gHasSubjectId = await colExists("groups", "subject_id");
    if (msgHasGroupId && msgHasMessage && gHasSubjectId) {
      await run(
        `UPDATE group_messages
            SET subject_id = COALESCE(subject_id, (SELECT g.subject_id FROM groups g WHERE g.id = group_messages.group_id))
          WHERE (subject_id IS NULL OR subject_id = 0) AND group_id IS NOT NULL`
      );
      await run(
        `UPDATE group_messages
            SET text = COALESCE(NULLIF(text, ''), message)
          WHERE message IS NOT NULL AND (text IS NULL OR text = '')`
      );
    }
  } catch (e) {
    console.warn("⚠️ Backfill group_messages falló:", e?.message || e);
  }

  await backfillIfNull(
    "group_messages",
    "created_at",
    `UPDATE group_messages SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // Backfill chat_type por si quedó NULL/vacío en DBs viejas
  try {
    await run(
      `UPDATE group_members
          SET chat_type = COALESCE(NULLIF(chat_type,''), 'finales')
        WHERE chat_type IS NULL OR chat_type = ''`
    );
  } catch (_) {}

  try {
    await run(
      `UPDATE group_messages
          SET chat_type = COALESCE(NULLIF(chat_type,''), 'finales')
        WHERE chat_type IS NULL OR chat_type = ''`
    );
  } catch (_) {}

  // Dedup por seguridad (si antes no había índice y quedaron duplicados)
  try {
    await run(
      `DELETE FROM group_members
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM group_members
          GROUP BY
            subject_id,
            user_id,
            COALESCE(NULLIF(chat_type,''), 'finales')
        )`
    );
  } catch (_) {}

  // ✅ Permitir que un mismo usuario esté en CURSOS y FINALES de la misma materia
  try {
    await run(`DROP INDEX IF EXISTS uq_group_members_subject_user`);
  } catch (_) {}
  try {
    await run(`DROP INDEX IF EXISTS uq_group_members_subject_user_type`);
  } catch (_) {}
  try {
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_group_members_subject_user_type
        ON group_members(subject_id, user_id, chat_type)`
    );
  } catch (_) {}

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_group_members_subject_chat_user ON group_members(subject_id, chat_type, user_id)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_group_members_user_chat_subject ON group_members(user_id, chat_type, subject_id)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_group_messages_subject_chat_id ON group_messages(subject_id, chat_type, id)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_group_messages_subject_chat_created ON group_messages(subject_id, chat_type, created_at)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_reviews_prof_created ON reviews(professor_id, created_at)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_review_votes_review_user ON review_votes(review_id, user_id)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_review_votes_review_vote ON review_votes(review_id, vote)`);
  } catch (_) {}

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

  // finals: columnas nuevas para vista completa de finales
  await ensureColumn("finals", "subject_id", `ALTER TABLE finals ADD COLUMN subject_id INTEGER`);
  await ensureColumn("finals", "year", `ALTER TABLE finals ADD COLUMN year INTEGER`);
  await ensureColumn("finals", "modalidad", `ALTER TABLE finals ADD COLUMN modalidad TEXT DEFAULT 'regular'`);
  await ensureColumn("finals", "libre", `ALTER TABLE finals ADD COLUMN libre TEXT DEFAULT ''`);
  await ensureColumn("finals", "regular", `ALTER TABLE finals ADD COLUMN regular TEXT DEFAULT ''`);
  await ensureColumn("finals", "exam_type", `ALTER TABLE finals ADD COLUMN exam_type TEXT DEFAULT 'final'`);
  await ensureColumn("finals", "rendible", `ALTER TABLE finals ADD COLUMN rendible INTEGER DEFAULT 1`);
  await ensureColumn("finals", "prob_regular", `ALTER TABLE finals ADD COLUMN prob_regular INTEGER DEFAULT 0`);
  await ensureColumn("finals", "prob_libre", `ALTER TABLE finals ADD COLUMN prob_libre INTEGER DEFAULT 0`);
  await ensureColumn("finals", "top_units_json", `ALTER TABLE finals ADD COLUMN top_units_json TEXT DEFAULT '[]'`);
  await ensureColumn("finals", "best_months", `ALTER TABLE finals ADD COLUMN best_months TEXT DEFAULT ''`);
  await ensureColumn("finals", "worst_months", `ALTER TABLE finals ADD COLUMN worst_months TEXT DEFAULT ''`);
  await ensureColumn("finals", "created_at", `ALTER TABLE finals ADD COLUMN created_at TEXT`);
  await ensureColumn("finals", "updated_at", `ALTER TABLE finals ADD COLUMN updated_at TEXT`);
  await backfillIfNull(
    "finals",
    "created_at",
    `UPDATE finals SET created_at = COALESCE(created_at, datetime('now'))`
  );
  await backfillIfNull(
    "finals",
    "updated_at",
    `UPDATE finals SET updated_at = COALESCE(updated_at, datetime('now'))`
  );

  // cursadas y reacciones
  await ensureColumn("cursadas", "career", `ALTER TABLE cursadas ADD COLUMN career TEXT DEFAULT ''`);
  await ensureColumn("cursadas", "plan", `ALTER TABLE cursadas ADD COLUMN plan INTEGER DEFAULT 7`);
  await ensureColumn("cursadas", "subject_id", `ALTER TABLE cursadas ADD COLUMN subject_id INTEGER`);
  await ensureColumn("cursadas", "year", `ALTER TABLE cursadas ADD COLUMN year INTEGER`);
  await ensureColumn("cursadas", "schedule_text", `ALTER TABLE cursadas ADD COLUMN schedule_text TEXT DEFAULT ''`);
  await ensureColumn("cursadas", "approval_pct", `ALTER TABLE cursadas ADD COLUMN approval_pct INTEGER DEFAULT 0`);
  await ensureColumn("cursadas", "promotion_pct", `ALTER TABLE cursadas ADD COLUMN promotion_pct INTEGER DEFAULT 0`);
  await ensureColumn("cursadas", "class_type", `ALTER TABLE cursadas ADD COLUMN class_type TEXT DEFAULT ''`);
  await ensureColumn("cursadas", "teachers_json", `ALTER TABLE cursadas ADD COLUMN teachers_json TEXT DEFAULT '[]'`);
  await ensureColumn("cursadas", "created_at", `ALTER TABLE cursadas ADD COLUMN created_at TEXT`);
  await ensureColumn("cursadas", "updated_at", `ALTER TABLE cursadas ADD COLUMN updated_at TEXT`);
  await backfillIfNull(
    "cursadas",
    "created_at",
    `UPDATE cursadas SET created_at = COALESCE(created_at, datetime('now'))`
  );
  await backfillIfNull(
    "cursadas",
    "updated_at",
    `UPDATE cursadas SET updated_at = COALESCE(updated_at, datetime('now'))`
  );

  try {
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cursadas_unique_subject ON cursadas(career, plan, subject_id)`);
  } catch (_) {}
  try {
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cursada_reactions_unique ON cursada_reactions(cursada_id, user_id)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_cursada_reactions_cursada ON cursada_reactions(cursada_id)`);
  } catch (_) {}

  // documents extra cols
  await ensureColumn("documents", "mimetype", `ALTER TABLE documents ADD COLUMN mimetype TEXT DEFAULT ''`);
  await ensureColumn("documents", "size", `ALTER TABLE documents ADD COLUMN size INTEGER DEFAULT 0`);
  await ensureColumn("documents", "level", `ALTER TABLE documents ADD COLUMN level TEXT DEFAULT ''`);
  await ensureColumn("documents", "group_uid", `ALTER TABLE documents ADD COLUMN group_uid TEXT DEFAULT ''`);
  await ensureColumn("documents", "subcategory", `ALTER TABLE documents ADD COLUMN subcategory TEXT DEFAULT ''`);
  await ensureColumn("documents", "created_at", `ALTER TABLE documents ADD COLUMN created_at TEXT`);
  await ensureColumn("documents", "sort_order", `ALTER TABLE documents ADD COLUMN sort_order INTEGER`);
  await backfillIfNull(
    "documents",
    "created_at",
    `UPDATE documents SET created_at = COALESCE(created_at, datetime('now'))`
  );

  // ✅ documents.subject_key: clave global por nombre (comparte contenido entre carreras/planes)
  await ensureColumn("documents", "subject_key", `ALTER TABLE documents ADD COLUMN subject_key TEXT DEFAULT ''`);
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_documents_subject_key ON documents(subject_key)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_documents_subject_category_subcategory_sort ON documents(subject_key, category, subcategory, sort_order, created_at, id)`);
  } catch (_) {}
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_documents_subject_category_level_created ON documents(subject_key, category, level, created_at, id)`);
  } catch (_) {}

  // ✅ Backfill subject_key para docs ya subidos
  try {
    const rows = await all(`
      SELECT
        d.id AS id,
        COALESCE(NULLIF(d.subject_key,''), '') AS sk,
        COALESCE(NULLIF(s.canonical_key,''), '') AS ck,
        COALESCE(NULLIF(s.subject_name,''), NULLIF(s.name,'')) AS nm
      FROM documents d
      LEFT JOIN subjects s ON s.id = d.subject_id
    `);

    for (const r of rows) {
      const sk = String(r.sk || "").trim();
      if (sk) continue;

      const key = String(r.ck || "").trim() || canonKey(r.nm || "");
      if (!key) continue;

      await run(`UPDATE documents SET subject_key=? WHERE id=?`, [key, r.id]);
    }
  } catch (e) {
    console.warn("⚠️ Backfill documents.subject_key falló:", e?.message || e);
  }

  // notifications.created_at / plan tipo int
  await ensureColumn("notifications", "created_at", `ALTER TABLE notifications ADD COLUMN created_at TEXT`);
  await backfillIfNull(
    "notifications",
    "created_at",
    `UPDATE notifications SET created_at = COALESCE(created_at, datetime('now'))`
  );

    // ===== ESTUDIO: diagnóstico + cronómetro adaptativo =====
  await ensureColumn(
    "users",
    "test_completado",
    `ALTER TABLE users ADD COLUMN test_completado INTEGER DEFAULT 0`
  );

  await ensureColumn(
    "users",
    "metodo_asignado",
    `ALTER TABLE users ADD COLUMN metodo_asignado TEXT DEFAULT ''`
  );

  await ensureTable(
    "perfiles_estudio",
    `
    CREATE TABLE IF NOT EXISTS perfiles_estudio (
      user_id INTEGER PRIMARY KEY,
      indice_focus REAL DEFAULT 0,
      indice_structure REAL DEFAULT 0,
      indice_stamina REAL DEFAULT 0,
      indice_recall REAL DEFAULT 0,
      indice_autonomy REAL DEFAULT 0,
      perfil_label TEXT DEFAULT '',
      metodo_asignado TEXT DEFAULT '',
      respuestas_json TEXT DEFAULT '[]',
      disponibilidad_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  await run(`CREATE INDEX IF NOT EXISTS idx_perfiles_estudio_method ON perfiles_estudio(metodo_asignado)`);

  await ensureTable(
    "disponibilidad_semanal",
    `
    CREATE TABLE IF NOT EXISTS disponibilidad_semanal (
      user_id INTEGER NOT NULL,
      dow INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      ocupado INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, dow, hour),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    `
  );

  await run(`CREATE INDEX IF NOT EXISTS idx_disponibilidad_user ON disponibilidad_semanal(user_id)`);
  
  await ensureTable(
    "app_state",
    `
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    )
    `
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

// ✅ IMPORTANTÍSIMO: asegurar que init() CORRA al arrancar (Koyeb/Render/local)
// (guard para no duplicar init si alguien lo llama de nuevo)
let __initStarted = false;
let __initPromise = null;
function ensureInitStarted() {
  if (__initStarted) return __initPromise;
  __initStarted = true;
  __initPromise = init().catch((err) => {
    console.error("[db.init] failed:", err?.message || err);
    throw err;
  });
  return __initPromise;
}
ensureInitStarted();

module.exports = { db, all, get, run, init };
