// scripts/migrate_documents_add_cols.js
const { init, all, run } = require("../models/db");

async function hasColumn(table, col) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === col);
}

(async () => {
  try {
    await init();

    // Asegurar columns: mimetype TEXT, size INTEGER, created_at TEXT DEFAULT now
    const cols = [
      { name: "mimetype",  sql: "ALTER TABLE documents ADD COLUMN mimetype TEXT" },
      { name: "size",      sql: "ALTER TABLE documents ADD COLUMN size INTEGER" },
      { name: "created_at",sql: "ALTER TABLE documents ADD COLUMN created_at TEXT DEFAULT (datetime('now'))" },
    ];

    for (const c of cols) {
      const exists = await hasColumn("documents", c.name);
      if (!exists) {
        console.log(`➕ Agregando columna ${c.name}...`);
        await run(c.sql);
      } else {
        console.log(`✔️  Columna ${c.name} ya existe`);
      }
    }

    // Backfill simple: si hay filas sin created_at, setear ahora
    await run(`UPDATE documents SET created_at = COALESCE(created_at, datetime('now'))`);

    console.log("✅ Migración OK");
    process.exit(0);
  } catch (e) {
    console.error("❌ Error migrando:", e);
    process.exit(1);
  }
})();