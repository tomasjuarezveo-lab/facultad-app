const sqlite3 = require('sqlite3').verbose();
const bcrypt  = require('bcrypt');
const path    = require('path');

const dbFile = path.join(__dirname, '..', 'facultad.sqlite');
const db = new sqlite3.Database(dbFile);

/* ========== Helpers promisificados ========== */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

/* ========== Utilidades de migración ========== */
async function tableExists(name) {
  const row = await get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [name]
  );
  return !!row;
}
async function columnExists(table, column) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === column);
}

/* ========== Init: crea/migra el esquema ========== */
async function init() {
  await run(`PRAGMA foreign_keys = ON;`);

  /* ---- Usuarios ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      career TEXT NOT NULL,
      plan INTEGER NOT NULL CHECK (plan IN (7,8)),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  /* ---- Puntos de juegos por usuario ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS game_scores (
      user_id INTEGER PRIMARY KEY,
      points  INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  /* ---- Materias ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      year INTEGER NOT NULL CHECK (year BETWEEN 1 AND 5),
      career TEXT NOT NULL,
      plan INTEGER NOT NULL CHECK (plan IN (7,8))
    );
  `);

  /* ---- Grupos por materia (membresías) ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS group_members (
      subject_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(subject_id, user_id),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_group_members_subject ON group_members(subject_id);`);

  /* ---- Mensajes de grupo ---- */

  /* ---- Notificaciones (admin->usuarios por carrera) ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      careers TEXT NOT NULL,           -- CSV de nombres canónicos de carrera
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);`);

  await run(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  // Migración idempotente de columnas para adjuntos
  if (await tableExists('group_messages')) {
    const hasUrl  = await columnExists('group_messages', 'attachment_url');
    const hasType = await columnExists('group_messages', 'attachment_type');
    if (!hasUrl)  { await run(`ALTER TABLE group_messages ADD COLUMN attachment_url TEXT;`).catch(()=>{}); }
    if (!hasType) { await run(`ALTER TABLE group_messages ADD COLUMN attachment_type TEXT;`).catch(()=>{}); }
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_group_messages_subject ON group_messages(subject_id, id);`);

  /* ---- Correlativas (aseguramos req_type) ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS correlatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      depends_on_id INTEGER NOT NULL,
      req_type TEXT,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_id) REFERENCES subjects(id) ON DELETE CASCADE
    );
  `);
  if (await tableExists('correlatives')) {
    const hasReqType = await columnExists('correlatives', 'req_type');
    if (!hasReqType) {
      await run(`ALTER TABLE correlatives ADD COLUMN req_type TEXT;`).catch(()=>{});
    }
  }

  /* ---- DOCUMENTOS ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      title TEXT,
      category TEXT NOT NULL CHECK(category IN ('parciales','finales','trabajos','bibliografia','resumenes','clases')),
      filename TEXT NOT NULL,
      mimetype TEXT,
      size INTEGER,
      level TEXT CHECK(level IN ('completo','mediano','facil')),
      doc_group TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    );
  `);

  if (await tableExists('documents')) {
    const wantCols = [
      ['mimetype',   "ALTER TABLE documents ADD COLUMN mimetype TEXT;"],
      ['size',       "ALTER TABLE documents ADD COLUMN size INTEGER;"],
      ['created_at', "ALTER TABLE documents ADD COLUMN created_at TEXT DEFAULT (datetime('now'));"],
      ['level',      "ALTER TABLE documents ADD COLUMN level TEXT CHECK(level IN ('completo','mediano','facil'));"],
      ['doc_group',  "ALTER TABLE documents ADD COLUMN doc_group TEXT;"],
    ];
    for (const [col, ddl] of wantCols) {
      const has = await columnExists('documents', col);
      if (!has) await run(ddl).catch(()=>{});
    }
  }

  await run(`CREATE INDEX IF NOT EXISTS idx_documents_subject ON documents(subject_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at DESC);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_documents_group ON documents(doc_group, level);`);

  /* ---- Autoevaluaciones ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      q TEXT NOT NULL,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      c TEXT,
      d TEXT,
      correct INTEGER NOT NULL CHECK (correct IN (0,1,2,3)),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      answers_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(subject_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  /* ---- Finales ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS finals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      year INTEGER,
      exam_type TEXT NOT NULL CHECK (exam_type IN ('escrito','oral','escrito y oral')),
      modalidad TEXT NOT NULL CHECK (modalidad IN ('libre','regular')),
      rendible INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    );
  `);

  /* ---- Profesores + reviews ---- */
  await run(`
    CREATE TABLE IF NOT EXISTS professors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      photo_url TEXT,
      career TEXT NOT NULL,
      plan INTEGER NOT NULL CHECK (plan IN (7,8))
    );
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_professors_name ON professors(name);`);

  if (await tableExists('professors')) {
    const hasSubjectsText = await columnExists('professors', 'subjects_text');
    if (!hasSubjectsText) {
      await run(`ALTER TABLE professors ADD COLUMN subjects_text TEXT;`).catch(()=>{});
    }
  }

  await run(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      professor_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(professor_id) REFERENCES professors(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  if (await tableExists('reviews')) {
    const ensureCols = [
      ['corre',  "ALTER TABLE reviews ADD COLUMN corre INTEGER;"],
      ['clases', "ALTER TABLE reviews ADD COLUMN clases INTEGER;"],
      ['onda',   "ALTER TABLE reviews ADD COLUMN onda INTEGER;"],
    ];
    for (const [col, ddl] of ensureCols) {
      const has = await columnExists('reviews', col);
      if (!has) await run(ddl).catch(()=>{});
    }
  }

  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique
    ON reviews(professor_id, user_id);
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_reviews_professor ON reviews(professor_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at);`);

  /* ---- Seed de 5 profesores inventados (si no hay) ---- */
  const profCount = await get(`SELECT COUNT(*) AS count FROM professors`);
  if (!profCount || profCount.count == 0) {
    const sampleProfs = [
      { name: "Ana Martínez",  photo_url: "https://i.pravatar.cc/150?img=1" },
      { name: "Juan Pérez",    photo_url: "https://i.pravatar.cc/150?img=2" },
      { name: "Lucía Gómez",   photo_url: "https://i.pravatar.cc/150?img=3" },
      { name: "Carlos Romero", photo_url: "https://i.pravatar.cc/150?img=4" },
      { name: "María López",   photo_url: "https://i.pravatar.cc/150?img=5" },
    ];
    for (const p of sampleProfs) {
      await run(
        `INSERT INTO professors (name, photo_url, career, plan)
         VALUES (?, ?, ?, ?);`,
        [p.name, p.photo_url, 'Lic. en Administración de Empresas', 7]
      );
    }
    await run(`UPDATE professors SET subjects_text='Mate I, Mate II, Matemática Financiera' WHERE name='Ana Martínez';`);
    await run(`UPDATE professors SET subjects_text='Álgebra, Análisis I' WHERE name='Juan Pérez';`);
    await run(`UPDATE professors SET subjects_text='Estadística I, Estadística II' WHERE name='Lucía Gómez';`);
    await run(`UPDATE professors SET subjects_text='Cálculo I, Cálculo II, Optimización' WHERE name='Carlos Romero';`);
    await run(`UPDATE professors SET subjects_text='Matemática Financiera, Inferencia Estadística' WHERE name='María López';`);

    console.log("✔ Profesores de ejemplo insertados (5)");
  }

  /* ---- Seed admin (si no existe) ---- */
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@facultad.local';
  const row = await get(`SELECT 1 FROM users WHERE role='admin' LIMIT 1`);
  if (!row) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'cambia-esto', 10);
    await run(
      `INSERT INTO users (name, email, pass_hash, role, career, plan)
       VALUES (?, ?, ?, 'admin', 'Lic. en Administración de Empresas', 7);`,
      ['Administrador', adminEmail, hash]
    );
    console.log('✅ Admin creado:', adminEmail);
  }

  /* ---- Vistos del tutorial (por usuario y sección) ---- */
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

module.exports = { db, run, all, get, init };
