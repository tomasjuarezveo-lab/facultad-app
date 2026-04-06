// scripts/seed_admin_plan6.js
// Carga materias de Lic. en Administración de Empresas - Plan 6
// Uso:
//   node scripts/seed_admin_plan6.js

const { init, run, all } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

function canonKey(v) {
  let s = String(v ?? "").trim().toLowerCase();
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (_) {}
  s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return s;
}

const CAREER = normalizeCareer("Lic. en Administración de Empresas");
const PLAN = 6;

const SUBJECTS = [
  // PRIMER AÑO
  { name: "Contabilidad 1", year: 1, semester: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1, semester: 1 },
  { name: "Administración I (Introducción a la Administración)", year: 1, semester: 1 },

  { name: "Matemática I (Análisis Matemático)", year: 1, semester: 2 },
  { name: "Derecho I (Constitucional y Administrativo)", year: 1, semester: 2 },
  { name: "Introducción a las Ciencias Sociales y al Conocimiento Científico", year: 1, semester: 2 },
  { name: "Microeconomía I", year: 1, semester: 2 },

  // SEGUNDO AÑO
  { name: "Contabilidad Superior II (Ajuste y Valuación)", year: 2, semester: 1 },
  { name: "Macroeconomía I", year: 2, semester: 1 },
  { name: "Historia Económica y Social Argentina y Latinoamericana", year: 2, semester: 1 },

  { name: "Administración II (Técnicas Administrativas)", year: 2, semester: 2 },
  { name: "Matemática II (Álgebra)", year: 2, semester: 2 },
  { name: "Finanzas Públicas I (General)", year: 2, semester: 2 },

  // TERCER AÑO
  { name: "Administración III (Planeamiento y Control Organizacional)", year: 3, semester: 1 },
  { name: "Derecho II (Privado)", year: 3, semester: 1 },
  { name: "Finanzas Públicas II (Argentina)", year: 3, semester: 1 },
  { name: "Estadística para los Negocios", year: 3, semester: 1 },

  { name: "Contabilidad III (Costos para la Gestión)", year: 3, semester: 2 },
  { name: "Matemática para Decisiones Empresarias", year: 3, semester: 2 },
  { name: "Administración Pública I", year: 3, semester: 2 },

  // CUARTO AÑO
  { name: "Finanzas de Empresas I", year: 4, semester: 1 },
  { name: "Psicología Organizacional", year: 4, semester: 1 },
  { name: "Sistemas de Información", year: 4, semester: 1 },
  { name: "Estructura Económica Societaria", year: 4, semester: 1 },

  { name: "Política y Derecho Social", year: 4, semester: 2 },
  { name: "Administración de la Comercialización I", year: 4, semester: 2 },
  { name: "Finanzas de Empresas II", year: 4, semester: 2 },
  { name: "Sociología Organizacional", year: 4, semester: 2 },

  // QUINTO AÑO
  { name: "Administración de Personal", year: 5, semester: 1 },
  { name: "Administración de la Comercialización II", year: 5, semester: 1 },
  { name: "Administración de los Recursos de Información", year: 5, semester: 1 },
  { name: "Administración Pública II", year: 5, semester: 1 },
  { name: "Análisis de Coyuntura y Previsión Económica", year: 5, semester: 1 },

  { name: "Administración de la Producción", year: 5, semester: 2 },
  { name: "Dirección y Gestión Empresarial", year: 5, semester: 2 },
  { name: "Actuación Judicial", year: 5, semester: 2 },
];

(async function main() {
  try {
    await init();

    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_subjects_unique ON subjects(career, plan, name)`);

    let inserted = 0;

    for (const s of SUBJECTS) {
      const name = String(s.name || "").trim();
      const ck = canonKey(name);

      const res = await run(
        `INSERT OR IGNORE INTO subjects (name, subject_name, canonical_key, year, semester, career, plan)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, name, ck, s.year, s.semester, CAREER, PLAN]
      );

      if (res && res.changes > 0) inserted++;

      await run(
        `UPDATE subjects
            SET subject_name = ?,
                canonical_key = ?,
                year = ?,
                semester = ?,
                career = ?,
                plan = ?
          WHERE career = ?
            AND plan = ?
            AND LOWER(name) = LOWER(?)`,
        [name, ck, s.year, s.semester, CAREER, PLAN, CAREER, PLAN, name]
      );
    }

    const rows = await all(
      `SELECT id, year, semester, name
         FROM subjects
        WHERE career = ? AND plan = ?
        ORDER BY year ASC, COALESCE(semester, 9) ASC, name ASC`,
      [CAREER, PLAN]
    );

    console.log(`✅ Materias cargadas para ${CAREER} · Plan ${PLAN}`);
    console.log(`✅ Nuevas insertadas: ${inserted}`);
    console.log(`✅ Total actual en DB para ese plan: ${rows.length}`);
    console.table(rows);

    process.exit(0);
  } catch (e) {
    console.error("❌ Error cargando Plan 6 de Administración:", e);
    process.exit(1);
  }
})();