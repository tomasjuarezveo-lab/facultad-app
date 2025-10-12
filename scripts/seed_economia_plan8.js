// scripts/seed_economia_plan8.js
// Carga materias de Lic. en Economía - Plan 8
// Ejecutar con: node scripts/seed_economia_plan8.js
// (Asegurate de tener creado facultad.sqlite; el init del modelo crea la tabla si no existe)

const { init, all, get, run } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

const CAREER = normalizeCareer("Lic. en Economía");
const PLAN   = 8;

// Lista provista por el usuario, respetando títulos y (Electiva) en el nombre
const SUBJECTS = [
  // ===== 1° Año =====
  { name: "Matemática Inicial y Técnicas de Estudio y Comunicación", year: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1 },
  { name: "Contabilidad I (Bases y Fundamentos)", year: 1 },
  { name: "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", year: 1 },
  { name: "Microeconomía I", year: 1 },
  { name: "Matemática I", year: 1 },
  { name: "Laboratorio de Datos", year: 1 },
  { name: "Historia Económica Mundial y Argentina", year: 1 },

  // ===== 2° Año =====
  { name: "Macroeconomía I", year: 2 },
  { name: "Matemática para Economistas I", year: 2 },
  { name: "Interpretación de los Estados Contables", year: 2 },
  { name: "Matemática para Economistas II", year: 2 },
  { name: "Estadística para Economistas", year: 2 },
  { name: "Finanzas Públicas", year: 2 },
  { name: "Comportamiento Estratégico", year: 2 },

  // ===== 3° Año =====
  { name: "Microeconomía II", year: 3 },
  { name: "Econometría I", year: 3 },
  { name: "Estructura Social Argentina", year: 3 },
  { name: "Cálculo Financiero (Electiva)", year: 3 },
  { name: "Economía Espacial y Ambiental (Electiva)", year: 3 },
  { name: "Historia del Pensamiento Económico (Electiva)", year: 3 },
  { name: "Macroeconomía II", year: 3 },
  { name: "Econometría II", year: 3 },
  { name: "Organización Industrial", year: 3 },
  { name: "Mercado de Capitales (Electiva)", year: 3 },
  { name: "Economía Laboral (Electiva)", year: 3 },
  { name: "Materia Optativa (Electiva)", year: 3 },

  // ===== 4° Año =====
  { name: "Desarrollo Económico", year: 4 },
  { name: "Moneda, Crédito y Bancos", year: 4 },
  { name: "Comercio Internacional", year: 4 },
  { name: "Economía de las Instituciones y el Comportamiento (Electiva)", year: 4 },
  { name: "Finanzas de Empresas (Electiva)", year: 4 },
  { name: "Finanzas Internacionales", year: 4 },
  { name: "Economía del Sector Público", year: 4 },
  { name: "Política Económica", year: 4 },
  { name: "Economía de los Ciclos y las Crisis (Electiva)", year: 4 },
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
        `INSERT INTO subjects (name, year, career, plan) VALUES (?, ?, ?, ?)`,
        [s.name, s.year, CAREER, PLAN]
      );
      inserted++;
    }

    const rows = await all(
      `SELECT year, name FROM subjects WHERE career=? AND plan=? ORDER BY year, name`,
      [CAREER, PLAN]
    );

    console.log(`✅ Listo (Economía Plan ${PLAN}): Insertados=${inserted} · YaExistían=${skipped} · Total=${rows.length}`);
    const byYear = rows.reduce((acc, r) => {
      acc[r.year] = (acc[r.year] || 0) + 1;
      return acc;
    }, {});
    console.log("Por año:", byYear);
    console.table(rows);
    process.exit(0);
  } catch (e) {
    console.error("❌ Error seeding Economía Plan 8:", e);
    process.exit(1);
  }
})();
