// scripts/seed_subjects_to_turso.js
require('dotenv').config();

const path = require('path');
const sqlite3 = require('sqlite3');
const { createClient } = require('@libsql/client');

const LOCAL_DB_PATH =
  process.env.LOCAL_DB_PATH ||
  path.join(process.cwd(), 'facultad.sqlite');

function openSqlite(dbPath) {
  return new sqlite3.Database(dbPath);
}

function allSqlite(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function getSqlite(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function pickColumn(cols, candidates) {
  const set = new Set(cols.map(c => String(c).toLowerCase()));
  for (const cand of candidates) {
    if (set.has(String(cand).toLowerCase())) return cand;
  }
  return null;
}

function normText(v) {
  return String(v ?? '').trim();
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

async function ensureRemoteSchema(turso) {
  // Tabla mínima para que la app funcione + correlativas/final en JSON
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT NOT NULL,
      plan INTEGER NOT NULL,
      subject_name TEXT NOT NULL,
      year INTEGER,
      cuatrimestre INTEGER,
      correlativas_json TEXT,
      final_json TEXT
    )
  `);

  // Clave lógica única (la id local puede no matchear)
  await turso.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_key
    ON subjects (career, plan, subject_name)
  `);
}

async function main() {
  const DB_URL = process.env.DB_URL;
  const DB_TOKEN = process.env.DB_TOKEN;

  if (!DB_URL || !DB_TOKEN) {
    console.error('❌ Falta DB_URL/DB_TOKEN en .env');
    process.exit(1);
  }

  console.log('🟦 LOCAL:', LOCAL_DB_PATH);

  const local = openSqlite(LOCAL_DB_PATH);

  // Leer columnas reales
  const info = await allSqlite(local, "PRAGMA table_info('subjects')");
  const cols = (info || []).map(r => r.name);

  if (!cols.length) {
    console.error("❌ No pude leer PRAGMA table_info('subjects'). ¿Existe la tabla?");
    process.exit(1);
  }

  // Detectar nombres posibles de columnas
  const colCareer = pickColumn(cols, ['career', 'carrera']);
  const colPlan   = pickColumn(cols, ['plan']);
  const colName   = pickColumn(cols, ['subject_name', 'name', 'materia', 'nombre', 'subject', 'title']);
  const colYear   = pickColumn(cols, ['year', 'anio', 'año']);
  const colCuat   = pickColumn(cols, ['cuatrimestre', 'cuatri', 'semester', 'term']);
  const colCorr   = pickColumn(cols, ['correlativas_json', 'correlativas', 'corr_json']);
  const colFinal  = pickColumn(cols, ['final_json', 'final', 'finales_json']);

  if (!colCareer || !colPlan || !colName) {
    console.error('❌ No encontré columnas mínimas en local subjects.');
    console.error('Necesito: career/carrera, plan, y nombre de materia (subject_name/name/materia/nombre/subject/title).');
    console.log('Columnas encontradas:', cols);
    process.exit(1);
  }

  // Armar SELECT dinámico con alias estándar
  const selectParts = [
    `${colCareer} AS career`,
    `${colPlan}   AS plan`,
    `${colName}   AS subject_name`,
    colYear ? `${colYear} AS year` : `NULL AS year`,
    colCuat ? `${colCuat} AS cuatrimestre` : `NULL AS cuatrimestre`,
    colCorr ? `${colCorr} AS correlativas_json` : `NULL AS correlativas_json`,
    colFinal ? `${colFinal} AS final_json` : `NULL AS final_json`,
  ];

  const rows = await allSqlite(
    local,
    `SELECT ${selectParts.join(', ')} FROM subjects`
  );

  const count = rows.length;
  console.log('🟩 Subjects locales:', count);

  if (!count) {
    console.error('❌ Tu facultad.sqlite tiene 0 subjects. No hay nada para cargar.');
    process.exit(1);
  }

  // Conectar a Turso
  const turso = createClient({ url: DB_URL, authToken: DB_TOKEN });
  await turso.execute('select 1 as ok');

  // Asegurar schema remoto
  await ensureRemoteSchema(turso);

  // Insertar/Actualizar
  let ok = 0;
  for (const r of rows) {
    const career = normText(r.career);
    const plan = toIntOrNull(r.plan);
    const subjectName = normText(r.subject_name);

    if (!career || !plan || !subjectName) continue;

    const year = toIntOrNull(r.year);
    const cuat = toIntOrNull(r.cuatrimestre);

    // JSONs como texto
    const corr = r.correlativas_json == null ? null : String(r.correlativas_json);
    const fin  = r.final_json == null ? null : String(r.final_json);

    await turso.execute({
      sql: `
        INSERT INTO subjects (career, plan, subject_name, year, cuatrimestre, correlativas_json, final_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(career, plan, subject_name)
        DO UPDATE SET
          year = excluded.year,
          cuatrimestre = excluded.cuatrimestre,
          correlativas_json = excluded.correlativas_json,
          final_json = excluded.final_json
      `,
      args: [career, plan, subjectName, year, cuat, corr, fin],
    });

    ok++;
  }

  console.log(`✅ Seed OK: upserted ${ok}/${count} subjects en Turso`);

  local.close();
}

main().catch((e) => {
  console.error('❌ Seed error:', e);
  process.exit(1);
});
