// scripts/seed_la_plan8.js
// Carga materias de Lic. en Administración de Empresas - Plan 8
// Ejecutar con: node scripts/seed_la_plan8.js

const { init, all, get, run } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

const CAREER = normalizeCareer("Lic. en Administración de Empresas");
const PLAN   = 8;

const SUBJECTS = [
  // Año 1
  { name: "Introducción a los Estudios Universitarios", year: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1 },
  { name: "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", year: 1 },
  { name: "Contabilidad I (Bases y Fundamentos)", year: 1 },
  { name: "Microeconomía I", year: 1 },
  { name: "Matemática para Administradores", year: 1 },
  { name: "Comportamiento Humano en las Organizaciones", year: 1 },
  { name: "Pensamiento Social y Científico", year: 1 },

  // Año 2
  { name: "Macroeconomía I", year: 2 },
  { name: "Interpretación de los Estados Contables", year: 2 },
  { name: "Administración Estratégica", year: 2 },
  { name: "Gestión Pública", year: 2 },
  { name: "Estadística Aplicada", year: 2 },
  { name: "Costos para la Gestión (LA)", year: 2 },
  { name: "Elementos del Derecho Público y Privado", year: 2 },

  // Año 3
  { name: "Marketing Estratégico", year: 3 },
  { name: "Diseño de Sistemas de Información", year: 3 },
  { name: "Cálculo Financiero", year: 3 },
  { name: "Gestión de las Personas en las Organizaciones I", year: 3 },
  { name: "Planeamiento y Control Organizacional", year: 3 },
  { name: "Operaciones", year: 3 },

  // Año 4
  { name: "Marketing Operativo", year: 4 },
  { name: "Estrategia Tecnológica y Gestión de Proyectos IT", year: 4 },
  { name: "Finanzas de Empresas", year: 4 },
  { name: "Finanzas Públicas*", year: 4 },
  { name: "Psicosociología Organizacional*", year: 4 },
  { name: "Gestión de las Personas en las Organizaciones II", year: 4 },
  { name: "Derecho Empresario", year: 4 },
  { name: "Dirección General", year: 4 },
  { name: "Finanzas Avanzadas en Entidades Públicas y Privadas (Gestión, Sostenibilidad e Innovación)*", year: 4 },
  { name: "Inteligencia de Negocios y Análisis de Datos*", year: 4 },
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

    console.log(`✅ Listo: Insertados=${inserted} · YaExistían=${skipped} · Total=${rows.length}`);
    // Resumen por año
    const byYear = rows.reduce((acc, r) => {
      acc[r.year] = acc[r.year] || 0;
      acc[r.year]++;
      return acc;
    }, {});
    console.log("Por año:", byYear);

    // Mostrar en tabla para verificar orden
    console.table(rows);
    process.exit(0);
  } catch (e) {
    console.error("❌ Error seeding Plan 8:", e);
    process.exit(1);
  }
})();
