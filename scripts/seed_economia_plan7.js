// scripts/seed_economia_plan7.js
// Carga materias de Lic. en Economía - Plan 7
// Ejecutar con: node scripts/seed_economia_plan7.js

const { init, all, get, run } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

const CAREER = normalizeCareer("Lic. en Economía");
const PLAN   = 7;

const SUBJECTS = [
  // Año 1
  { name: "Contabilidad I (Bases y Fundamentos)", year: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1 },
  { name: "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", year: 1 },
  { name: "Microeconomía I", year: 1 },
  { name: "Matemática I", year: 1 },
  { name: "Derecho Constitucional y Administrativo", year: 1 },
  { name: "Introducción a las Ciencias Sociales y al Conocimiento Científico", year: 1 },

  // Año 2
  { name: "Macroeconomía I", year: 2 },
  { name: "Matemática para Economistas I", year: 2 },
  { name: "Historia Económica y Social I", year: 2 },
  { name: "Finanzas Públicas", year: 2 },
  { name: "Estadística para Economistas I", year: 2 },
  { name: "Matemática para Economistas II", year: 2 },
  { name: "Historia Económica y Social II", year: 2 },

  // Año 3
  { name: "Microeconomía II", year: 3 },
  { name: "Estadística para Economistas II", year: 3 },
  { name: "Estructura Social Argentina", year: 3 },
  { name: "Macroeconomía II", year: 3 },
  { name: "Econometría I", year: 3 },
  { name: "Historia del Pensamiento Económico", year: 3 },

  // Año 4
  { name: "Moneda, Crédito y Bancos", year: 4 },
  { name: "Economía Internacional", year: 4 },
  { name: "Econometría II", year: 4 },
  { name: "Economía Espacial y Ambiental*", year: 4 },
  { name: "Economía de los Ciclos y las Crisis", year: 4 },
  { name: "Economía de la Empresa y de la Organización Industrial", year: 4 },
  { name: "Economía del Sector Público", year: 4 },
  { name: "Economía Laboral*", year: 4 },

  // Año 5
  { name: "Desarrollo Económico", year: 5 },
  { name: "Finanzas Internacionales", year: 5 },
  { name: "Economía y Regulación de los Servicios Públicos*", year: 5 },
  { name: "Economía de las Instituciones y el Comportamiento*", year: 5 },
  { name: "Finanzas de la Empresa*", year: 5 },
  { name: "Seminario*", year: 5 },
  { name: "Política Económica I", year: 5 },
  { name: "Política Económica II", year: 5 },
];

(async () => {
  try {
    await init();
    let inserted = 0, skipped = 0;

    for (const s of SUBJECTS) {
      const exists = await get(
        `SELECT id FROM subjects WHERE name=? AND career=? AND plan=?`,
        [s.name, CAREER, PLAN]
      );
      if (exists) { skipped++; continue; }

      await run(
        `INSERT INTO subjects (name, year, career, plan) VALUES (?,?,?,?)`,
        [s.name, s.year, CAREER, PLAN]
      );
      inserted++;
    }

    const rows = await all(
      `SELECT year, name FROM subjects WHERE career=? AND plan=? ORDER BY year, name`,
      [CAREER, PLAN]
    );

    console.log(`✅ Listo (Economía Plan ${PLAN}): Insertados=${inserted} · YaExistían=${skipped} · Total=${rows.length}`);
    const byYear = rows.reduce((acc, r) => ((acc[r.year] = (acc[r.year] || 0) + 1), acc), {});
    console.log("Por año:", byYear);
    console.table(rows);
    process.exit(0);
  } catch (e) {
    console.error("❌ Error seeding Economía Plan 7:", e);
    process.exit(1);
  }
})();