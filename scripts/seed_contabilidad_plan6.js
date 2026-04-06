// scripts/seed_contabilidad_plan6.js
// Carga materias de Contabilidad - Plan 6
// Ejecutar con: node scripts/seed_contabilidad_plan6.js

const { init, run, all } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

const CAREER = normalizeCareer("Contabilidad");
const PLAN = 6;

function canonKey(v){
  let s = String(v ?? "").trim().toLowerCase();
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (_) {}
  s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return s;
}

const SUBJECTS = [
  // PRIMER AÑO
  { name: "Contabilidad Superior I", year: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1 },
  { name: "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", year: 1 },
  { name: "Matemática I (Análisis Matemático)", year: 1 },
  { name: "Derecho I (Constitucional y Administrativo)", year: 1 },
  { name: "Introducción a las Ciencias Sociales y al Conocimiento Científico", year: 1 },
  { name: "Microeconomía I", year: 1 },

  // SEGUNDO AÑO
  { name: "Contabilidad Superior II (Ajuste y Valuación)", year: 2 },
  { name: "Macroeconomía I", year: 2 },
  { name: "Administración II (Técnicas Administrativas y Gestión Organizacional)", year: 2 },
  { name: "Matemática II (Álgebra)", year: 2 },
  { name: "Finanzas Públicas I (General)", year: 2 },
  { name: "Historia Económica y Social Argentina y Latinoamericana", year: 2 },

  // TERCER AÑO
  { name: "Contabilidad III (Estados Contables)", year: 3 },
  { name: "Administración III (Comercialización)", year: 3 },
  { name: "Finanzas Públicas II (Argentina)", year: 3 },
  { name: "Contabilidad IV (Hacienda Pública)", year: 3 },
  { name: "Matemática para Decisiones Empresarias", year: 3 },
  { name: "Derecho II (Privado)", year: 3 },
  { name: "Contabilidad V (Sistemas de Información Económica y Contable)", year: 3 },

  // CUARTO AÑO
  { name: "Contabilidad VI (Costos para la Gestión)", year: 4 },
  { name: "Administración IV (Producción)", year: 4 },
  { name: "Contabilidad VII (Análisis de los Estados Contables)", year: 4 },
  { name: "Estadística para los Negocios", year: 4 },
  { name: "Estructura Económica Societaria", year: 4 },
  { name: "Actuación Laboral", year: 4 },
  { name: "Análisis de Coyuntura y Previsión Económica", year: 4 },

  // QUINTO AÑO
  { name: "Contabilidad VIII (Auditoría)", year: 5 },
  { name: "Contabilidad IX (Contabilidad para la Toma de Decisiones)", year: 5 },
  { name: "Técnica y Legislación Tributaria", year: 5 },
  { name: "Finanzas de Empresas", year: 5 },
  { name: "Actuación Judicial", year: 5 },
  { name: "Organización Profesional", year: 5 },
];

(async () => {
  try {
    await init();

    // Evita duplicados exactos
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_subjects_unique ON subjects(career, plan, name)`);

    // Detectar columnas opcionales (para no romper DBs viejas)
    const cols = await all(`PRAGMA table_info('subjects')`);
    const hasCanonical = cols.some(c => c.name === "canonical_key");
    const hasSubjectName = cols.some(c => c.name === "subject_name");

    let inserted = 0;

    for (const s of SUBJECTS) {
      const ck = canonKey(s.name);

      if (hasCanonical && hasSubjectName) {
        const res = await run(
          `INSERT OR IGNORE INTO subjects(name, year, career, plan, canonical_key, subject_name)
           VALUES (?,?,?,?,?,?)`,
          [s.name, s.year, CAREER, PLAN, ck, s.name]
        );
        if (res && res.changes > 0) inserted++;
      } else if (hasCanonical) {
        const res = await run(
          `INSERT OR IGNORE INTO subjects(name, year, career, plan, canonical_key)
           VALUES (?,?,?,?,?)`,
          [s.name, s.year, CAREER, PLAN, ck]
        );
        if (res && res.changes > 0) inserted++;
      } else {
        const res = await run(
          `INSERT OR IGNORE INTO subjects(name, year, career, plan)
           VALUES (?,?,?,?)`,
          [s.name, s.year, CAREER, PLAN]
        );
        if (res && res.changes > 0) inserted++;
      }
    }

    const rows = await all(
      `SELECT year, name FROM subjects WHERE career=? AND plan=? ORDER BY year, name`,
      [CAREER, PLAN]
    );

    console.log(`✅ Listo (Contabilidad Plan ${PLAN}): Insertados=${inserted} · TotalAhora=${rows.length}`);
    const byYear = rows.reduce((acc, r) => ((acc[r.year] = (acc[r.year] || 0) + 1), acc), {});
    console.log("Por año:", byYear);
    console.table(rows);

    process.exit(0);
  } catch (e) {
    console.error("❌ Error seeding Contabilidad Plan 6:", e);
    process.exit(1);
  }
})();