// scripts/migrate_documents_add_group_and_level.js
const { init, all, run } = require("../models/db");

async function hasColumn(table, col) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.some(r => r.name === col);
}

(async () => {
  try {
    await init();

    // Add group_uid
    if (!(await hasColumn("documents", "group_uid"))) {
      console.log("➕ Agregando columna group_uid...");
      await run(`ALTER TABLE documents ADD COLUMN group_uid TEXT`);
    } else {
      console.log("✔️  group_uid ya existe");
    }

    // Add level
    if (!(await hasColumn("documents", "level"))) {
      console.log("➕ Agregando columna level...");
      await run(`ALTER TABLE documents ADD COLUMN level TEXT`);
    } else {
      console.log("✔️  level ya existe");
    }

    // Backfill: if level is NULL but summary_level has value, copy it
    console.log("↪️  Copiando summary_level -> level donde corresponda...");
    await run(`UPDATE documents SET level = summary_level WHERE (level IS NULL OR level='') AND summary_level IS NOT NULL`);

    // Ensure level has one of ('completo','mediano','facil'); default to 'completo'
    console.log("🧹 Normalizando valores de level...");
    await run(`UPDATE documents SET level='completo' WHERE level IS NULL OR TRIM(level)='' OR level NOT IN ('completo','mediano','facil')`);

    console.log("✅ Migración completada");
    process.exit(0);
  } catch (e) {
    console.error("❌ Error migrando:", e);
    process.exit(1);
  }
})();