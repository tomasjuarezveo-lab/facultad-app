// scripts/seed_contabilidad_plan7.js
// Carga materias de Contabilidad - Plan 7
// Ejecutar con: node scripts/seed_contabilidad_plan7.js

const { init, all, get, run } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

const CAREER = normalizeCareer("Contabilidad");
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
  { name: "Contabilidad II (Ajuste y Valuación)", year: 2 },
  { name: "Macroeconomía I", year: 2 },
  { name: "Historia Económica y Social I", year: 2 },
  { name: "Administración II (Técnicas Administrativas y Gestión Organizacional)", year: 2 },
  { name: "Derecho Privado", year: 2 },
  { name: "Matemática II", year: 2 },
  { name: "Finanzas Públicas", year: 2 },

  // Año 3
  { name: "Contabilidad III (Estados Contables)", year: 3 },
  { name: "Producción", year: 3 },
  { name: "Estadística Aplicada", year: 3 },
  { name: "Estructura Económica Societaria", year: 3 },
  { name: "Matemática para Decisiones Empresarias", year: 3 },
  { name: "Sistema de Información Contable de Apoyo a las Operaciones", year: 3 },
  { name: "Comercialización", year: 3 },

  // Año 4
  { name: "Teoría y Técnica Impositiva I", year: 4 },
  { name: "Finanzas de Empresas", year: 4 },
  { name: "Contabilidad del Sector Público", year: 4 },
  { name: "Actuación Profesional Laboral y Previsional", year: 4 },
  { name: "Análisis e Interpretación de Estados Contables", year: 4 },
  { name: "Costos para la Gestión", year: 4 },

  // Año 5
  { name: "Auditoría", year: 5 },
  { name: "Organización y Práctica Profesional", year: 5 },
  { name: "Actuación Profesional en la Justicia", year: 5 },
  { name: "Teoría y Técnica Impositiva II", year: 5 },
  { name: "Sistema de Información Contable para la Toma de Decisiones", year: 5 },
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

    console.log(`✅ Listo (Contabilidad Plan ${PLAN}): Insertados=${inserted} · YaExistían=${skipped} · Total=${rows.length}`);
    // Resumen por año
    const byYear = rows.reduce((acc, r) => ((acc[r.year] = (acc[r.year] || 0) + 1), acc), {});
    console.log("Por año:", byYear);
    console.table(rows);
    process.exit(0);
  } catch (e) {
    console.error("❌ Error seeding Contabilidad Plan 7:", e);
    process.exit(1);
  }
})();