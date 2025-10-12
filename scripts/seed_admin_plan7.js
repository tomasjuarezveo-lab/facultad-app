
// scripts/seed_admin_plan7.js (versión idempotente)
// Uso:
//   node scripts/seed_admin_plan7.js
//
// Inserta materias Plan 7 sin duplicar (INSERT OR IGNORE) y garantiza índice único (career, plan, name).

const { run, all } = require("../models/db");

const CAREER = "Lic. en Administración de Empresas";
const PLAN   = 7;

const SUBJECTS = [
  // (Ejemplo reducido; reemplaza por tu lista completa original)
  { name: "Contabilidad I (Bases y Fundamentos)", year: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1 },
  { name: "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", year: 1 },
  { name: "Microeconomía I", year: 2 },
  { name: "Matemática I", year: 2 },
  { name: "Derecho Constitucional y Administrativo", year: 2 },
  // ... añade el resto de materias que ya trae tu seeder original
];

(async function main(){
  try{
    await run("BEGIN");

    // Índice único para evitar duplicados exactos
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_subjects_unique ON subjects(career, plan, name)`);

    let inserted = 0;
    for(const s of SUBJECTS){
      const sql = `INSERT OR IGNORE INTO subjects(name, year, career, plan) VALUES (?,?,?,?)`;
      const res = await run(sql, [s.name, s.year, CAREER, PLAN]);
      if (res && res.changes > 0) inserted++;
    }

    await run("COMMIT");

    const rows = await all(
      "SELECT id, year, name FROM subjects WHERE career=? AND plan=? ORDER BY year, name",
      [CAREER, PLAN]
    );
    console.log(`✅ Insertadas (o ya presentes) ${rows.length} materias para ${CAREER} (Plan ${PLAN}). Nuevas insertadas: ${inserted}`);
    console.table(rows);
    process.exit(0);
  }catch(e){
    await run("ROLLBACK").catch(()=>{});
    console.error("❌ Error al insertar materias:", e);
    process.exit(1);
  }
})();
