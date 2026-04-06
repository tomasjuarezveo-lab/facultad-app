// scripts/migrate_enforce_career_triggers.js
const { init, run } = require("../models/db");

const CANON = [
  "Lic. en Administración de Empresas",
  "Lic. en Economía",
  "Contabilidad",
];

// helper: genera SQL IN ('a','b','c')
const IN_LIST = "('" + CANON.map(s => s.replace(/'/g,"''")).join("','") + "')";

async function addTriggersForTable(table, col = "career") {
  // drop viejos si existen (idempotente)
  await run(`DROP TRIGGER IF EXISTS trg_${table}_${col}_insert_check`);
  await run(`DROP TRIGGER IF EXISTS trg_${table}_${col}_update_check`);

  // insert
  await run(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_${col}_insert_check
    BEFORE INSERT ON ${table}
    FOR EACH ROW
    WHEN NEW.${col} NOT IN ${IN_LIST}
    BEGIN
      SELECT RAISE(ABORT, 'career inválida: debe ser una de ${CANON.join(" | ")}');
    END;
  `);

  // update
  await run(`
    CREATE TRIGGER IF NOT EXISTS trg_${table}_${col}_update_check
    BEFORE UPDATE OF ${col} ON ${table}
    FOR EACH ROW
    WHEN NEW.${col} NOT IN ${IN_LIST}
    BEGIN
      SELECT RAISE(ABORT, 'career inválida: debe ser una de ${CANON.join(" | ")}');
    END;
  `);
}

(async () => {
  try {
    await init();
    await run("PRAGMA foreign_keys = ON");
    await addTriggersForTable("users");
    await addTriggersForTable("subjects");
    await addTriggersForTable("professors");
    console.log("✅ Triggers de validación de career creados en users, subjects, professors.");
    process.exit(0);
  } catch (e) {
    console.error("❌ Error creando triggers:", e);
    process.exit(1);
  }
})();