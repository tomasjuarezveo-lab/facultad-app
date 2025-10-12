// scripts/migrate_documents_category_check.js
const { init, all, run } = require("../models/db");

/**
 * Recrea la tabla documents con un CHECK de categoría extendido para:
 * parciales, finales, trabajos, bibliografia, resumenes, clases (+ 'examenes' legado)
 * y copia todos los datos sin perder nada.
 */
async function migrate() {
  await init();

  // 1) Leer esquema actual para saber si ya está bien
  const info = await all("PRAGMA table_info(documents)");
  const hasMimetype = info.some(c => c.name === "mimetype");
  const hasSize     = info.some(c => c.name === "size");
  const hasCreated  = info.some(c => c.name === "created_at");

  // 2) Apagar FKs para poder recrear
  await run("PRAGMA foreign_keys = OFF");
  await run("BEGIN TRANSACTION");

  // 3) Crear documents_new con CHECK ampliado y FK con ON DELETE CASCADE
  await run(`
    CREATE TABLE IF NOT EXISTS documents_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      title TEXT,
      category TEXT NOT NULL CHECK (category IN ('parciales','finales','trabajos','bibliografia','resumenes','clases','examenes')),
      filename TEXT NOT NULL,     -- guardamos /public/uploads/docs/...
      mimetype TEXT,
      size INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    )
  `);

  // 4) Copiar datos desde documents → documents_new (con columnas que existan)
  // Detectar qué columnas trae la tabla vieja
  const colNames = info.map(c => c.name);
  const selectCols = [
    "id","subject_id","title","category","filename",
    hasMimetype ? "mimetype" : "NULL AS mimetype",
    hasSize     ? "size"     : "NULL AS size",
    hasCreated  ? "created_at" : "datetime('now') AS created_at"
  ].join(", ");

  await run(`
    INSERT INTO documents_new (id, subject_id, title, category, filename, mimetype, size, created_at)
    SELECT ${selectCols} FROM documents
  `);

  // 5) Reemplazar tablas
  await run(`DROP TABLE documents`);
  await run(`ALTER TABLE documents_new RENAME TO documents`);

  // 6) Índices útiles
  await run(`CREATE INDEX IF NOT EXISTS idx_documents_subject ON documents(subject_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_documents_subject_category ON documents(subject_id, category)`);

  // 7) (Opcional) migrar legacy: 'examenes' -> 'parciales'
  await run(`UPDATE documents SET category='parciales' WHERE category='examenes'`);

  await run("COMMIT");
  await run("PRAGMA foreign_keys = ON");

  console.log("✅ Migración OK: tabla 'documents' recreada con categorías nuevas.");
}

migrate().catch(async (e) => {
  console.error("❌ Error migrando:", e);
  try { await run("ROLLBACK"); } catch {}
  process.exit(1);
});
