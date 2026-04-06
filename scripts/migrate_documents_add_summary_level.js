// scripts/migrate_documents_add_summary_level.js
const { init, all, run } = require("../models/db");

async function hasColumn(table, col) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === col);
}

(async () => {
  try {
    await init();
    if (!(await hasColumn("documents", "summary_level"))) {
      console.log("➕ Agregando columna summary_level...");
      await run(`ALTER TABLE documents ADD COLUMN summary_level TEXT`);
      // Si querés un CHECK fuerte, recrear tabla; como atajo, validamos por código.
    } else {
      console.log("✔️  summary_level ya existe");
    }
    console.log("✅ Migración OK");
    process.exit(0);
  } catch (e) {
    console.error("❌ Error migrando:", e);
    process.exit(1);
  }
})();