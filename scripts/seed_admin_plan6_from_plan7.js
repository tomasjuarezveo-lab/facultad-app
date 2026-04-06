// scripts/seed_admin_plan6_from_plan7.js
// Copia materias de Lic. en Administración de Empresas Plan 7 a Plan 6 (idempotente)
// Ejecutar: node scripts/seed_admin_plan6_from_plan7.js

const { init, run, all } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

const CAREER = normalizeCareer("Lic. en Administración de Empresas");
const FROM_PLAN = 7;
const TO_PLAN = 6;

(async () => {
  try {
    await init();

    // índice único para evitar duplicados
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_subjects_unique ON subjects(career, plan, name)`);

    // Detectar columnas opcionales
    const cols = await all(`PRAGMA table_info('subjects')`);
    const has = (c) => cols.some(x => x.name === c);

    const hasSemester    = has("semester");
    const hasCanonical   = has("canonical_key");
    const hasSubjectName = has("subject_name");

    // Traer materias origen
    const fromRows = await all(
      `SELECT *
         FROM subjects
        WHERE LOWER(career)=LOWER(?)
          AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)
        ORDER BY COALESCE(year,0), name`,
      [CAREER, FROM_PLAN]
    );

    if (!fromRows.length) {
      console.log(`⚠️ No hay materias para ${CAREER} Plan ${FROM_PLAN}. Primero seedear Plan 7.`);
      process.exit(0);
    }

    let inserted = 0;

    for (const s of fromRows) {
      const name = String(s.name || s.subject_name || "").trim();
      if (!name) continue;

      const year = s.year == null ? null : Number(s.year);
      const semester = hasSemester ? (s.semester == null ? null : Number(s.semester)) : null;

      const canonical_key = hasCanonical ? String(s.canonical_key || "").trim() : "";
      const subject_name  = hasSubjectName ? String(s.subject_name || name).trim() : "";

      // Armar INSERT según columnas reales
      const colsArr = ["name", "year", "career", "plan"];
      const qms = ["?", "?", "?", "?"];
      const args = [name, year, CAREER, TO_PLAN];

      if (hasSubjectName) { colsArr.push("subject_name"); qms.push("?"); args.push(subject_name); }
      if (hasCanonical)   { colsArr.push("canonical_key"); qms.push("?"); args.push(canonical_key); }
      if (hasSemester)    { colsArr.push("semester"); qms.push("?"); args.push(semester); }

      const sql = `INSERT OR IGNORE INTO subjects(${colsArr.join(",")}) VALUES(${qms.join(",")})`;
      const r = await run(sql, args);
      if (r && r.changes > 0) inserted++;
    }

    const nowRows = await all(
      `SELECT id, year, semester, name
         FROM subjects
        WHERE LOWER(career)=LOWER(?)
          AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)
        ORDER BY COALESCE(year,0), COALESCE(semester,0), name`,
      [CAREER, TO_PLAN]
    );

    console.log(`✅ ${CAREER} Plan ${TO_PLAN}: insertadas nuevas=${inserted} · total=${nowRows.length}`);
    console.table(nowRows);

    process.exit(0);
  } catch (e) {
    console.error("❌ Error seed_admin_plan6_from_plan7:", e);
    process.exit(1);
  }
})();