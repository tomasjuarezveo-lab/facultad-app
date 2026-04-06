// scripts/migrate_turso_subjects_schema.js
require('dotenv').config();
const { createClient } = require('@libsql/client');

function mustEnv(name) {
  const v = (process.env[name] || '').trim();
  if (!v) throw new Error(`Falta ${name} en .env`);
  return v;
}

async function safeExec(db, sql) {
  try {
    await db.execute(sql);
    console.log('✅', sql.replace(/\s+/g, ' ').trim());
  } catch (e) {
    const msg = String(e?.message || e);
    // Ignorar errores esperables
    if (
      msg.includes('duplicate column name') ||
      msg.includes('already exists') ||
      msg.includes('Duplicate column') ||
      msg.includes('SQLITE_ERROR: duplicate') ||
      msg.includes('duplicate') ||
      msg.includes('already exists')
    ) {
      console.log('ℹ️ Ya estaba:', sql.replace(/\s+/g, ' ').trim());
      return;
    }
    console.error('❌ Falló SQL:', sql);
    throw e;
  }
}

async function main() {
  const url = mustEnv('DB_URL');
  const token = mustEnv('DB_TOKEN');

  const db = createClient({ url, authToken: token });

  // Ping
  const ping = await db.execute('select 1 as ok');
  console.log('🟦 Turso ping:', ping.rows);

  // 1) Tabla base (si no existe)
  await safeExec(db, `
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT NOT NULL,
      plan INTEGER NOT NULL,
      subject_name TEXT NOT NULL
    )
  `);

  // 2) Columnas que tu app/seed esperan
  await safeExec(db, `ALTER TABLE subjects ADD COLUMN year INTEGER`);
  await safeExec(db, `ALTER TABLE subjects ADD COLUMN cuatrimestre INTEGER`);
  await safeExec(db, `ALTER TABLE subjects ADD COLUMN correlativas_json TEXT`);
  await safeExec(db, `ALTER TABLE subjects ADD COLUMN final_json TEXT`);

  // 3) Índice para upsert/duplicados
  await safeExec(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_key
    ON subjects (career, plan, subject_name)
  `);

  // Confirmación
  const cols = await db.execute(`PRAGMA table_info('subjects')`);
  console.log('🟩 subjects columns:', cols.rows.map(r => r.name).join(', '));

  const count = await db.execute(`SELECT COUNT(*) as c FROM subjects`);
  console.log('🟩 subjects count (antes de seed):', count.rows);

  console.log('✅ Migración schema subjects lista.');
}

main().catch((e) => {
  console.error('❌ migrate_turso_subjects_schema error:', e);
  process.exit(1);
});
