// scripts/seed_admin_plan7.js (versión idempotente)
// Uso:
//   node scripts/seed_admin_plan7.js
//
// Inserta materias Plan 7 sin duplicar (INSERT OR IGNORE) y garantiza índice único (career, plan, name).
// ⚠️ IMPORTANTE: NO usamos BEGIN/COMMIT/ROLLBACK porque en Turso/libSQL remoto cada execute puede ir en streams distintos.

const { run, all } = require("../models/db");

const CAREER = "Lic. en Administración de Empresas";
const PLAN   = 7;

const SUBJECTS = [
  // (Ejemplo reducido; reemplaza por tu lista completa original)
  { name: "Contabilidad I (Bases y Fundamentos)", year: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1 },
  { name: "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", year: 1 },
  { name: "Microeconomía I", year: 1 },
  { name: "Matemática I", year: 1 },
  { name: "Comportamiento Humano en las Organizaciones", year: 2 },
  { name: "Introducción a las Ciencias Sociales y al Conocimiento Científico", year: 1 },
  { name: "Derecho Constitucional y Administrativo", year: 1 },
  // ... añade el resto de materias que ya trae tu seeder original
];

(async function main(){
  try{
    // Índice único para evitar duplicados exactos
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_subjects_unique ON subjects(career, plan, name)`);

    let inserted = 0;
    for(const s of SUBJECTS){
      const sql = `INSERT OR IGNORE INTO subjects(name, year, career, plan) VALUES (?,?,?,?)`;
      const res = await run(sql, [s.name, s.year, CAREER, PLAN]);
      if (res && res.changes > 0) inserted++;
    }

    // ✅ Fix exacto (evita que "Matemática I" matchee "Matemática II")
    const FIX_YEARS = [
      // 1er año
      { name: "Introducción a las Ciencias Sociales y al Conocimiento Científico", year: 1 },
      { name: "Matemática I", year: 1 },
      { name: "Microeconomía I", year: 1 },

      // variantes sin tilde (por si en tu DB están así)
      { name: "Introduccion a las Ciencias Sociales y al Conocimiento Cientifico", year: 1 },
      { name: "Matematica I", year: 1 },
      { name: "Microeconomia I", year: 1 },

      // 2do año (corrección)
      { name: "Comportamiento Humano en las Organizaciones", year: 2 },
      { name: "Matemática II", year: 2 },
      { name: "Matematica II", year: 2 },

      // Derecho (exactos que suelen aparecer)
      { name: "Derecho Constitucional", year: 1 },
      { name: "Derecho Constitucional y Administrativo", year: 1 },
      { name: "Derecho Constitucional y Adm.", year: 1 },
    ];

    for (const f of FIX_YEARS) {
      await run(
        `UPDATE subjects
            SET year=?
          WHERE career=? AND plan=?
            AND (
              LOWER(name) = LOWER(?)
              OR LOWER(name) LIKE LOWER(? || ' (%')
            )`,
        [f.year, CAREER, PLAN, f.name, f.name]
      );
    }

    // ✅ Forzar Derecho Constitucional a 1º aunque el nombre tenga texto extra (fallback)
    await run(
      `UPDATE subjects
          SET year=1
        WHERE career=? AND plan=?
          AND LOWER(name) LIKE LOWER('derecho constit%')`,
      [CAREER, PLAN]
    );

    const rows = await all(
      "SELECT id, year, name FROM subjects WHERE career=? AND plan=? ORDER BY year, name",
      [CAREER, PLAN]
    );

    console.log(`✅ Insertadas (o ya presentes) ${rows.length} materias para ${CAREER} (Plan ${PLAN}). Nuevas insertadas: ${inserted}`);
    console.table(rows);
    process.exit(0);
  }catch(e){
    console.error("❌ Error al insertar materias:", e);
    process.exit(1);
  }
})();