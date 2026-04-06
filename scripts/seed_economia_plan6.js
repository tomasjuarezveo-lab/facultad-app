// scripts/seed_economia_plan6.js
// Carga materias de Lic. en Economía - Plan 6
// Uso:
//   node scripts/seed_economia_plan6.js

const { init, run, all } = require("../models/db");
const { normalizeCareer } = require("../utils/careers");

function canonKey(v) {
  let s = String(v ?? "").trim().toLowerCase();
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (_) {}
  s = s.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return s;
}

const CAREER = normalizeCareer("Lic. en Economía");
const PLAN = 6;

const SUBJECTS = [
  // PRIMER AÑO
  { name: "Contabilidad Superior I - Plan VI", year: 1, semester: 1 },
  { name: "Introducción a la Economía y Estructura Económica Argentina", year: 1, semester: 1 },
  { name: "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", year: 1, semester: 1 },

  { name: "Matemática I (Análisis matemático)", year: 1, semester: 2 },
  { name: "Derecho I (Constitucional y administrativo)", year: 1, semester: 2 },
  { name: "Introducción a las Ciencias Sociales y al Conocimiento Científico", year: 1, semester: 2 },
  { name: "Microeconomía I", year: 1, semester: 2 },

  // SEGUNDO AÑO
  { name: "Contabilidad Superior II (Ajuste y valuación) - Plan VI", year: 2, semester: 1 },
  { name: "Macroeconomía I", year: 2, semester: 1 },
  { name: "Historia Económica y Social Argentina y Latinoamericana", year: 2, semester: 1 },

  { name: "Administración II (Técnicas administrativas y gestión organizacional)", year: 2, semester: 2 },
  { name: "Matemática II (Álgebra)", year: 2, semester: 2 },
  { name: "Finanzas Públicas I (General)", year: 2, semester: 2 },

  // TERCER AÑO
  { name: "Estadística I", year: 3, semester: 1 },
  { name: "Economía Matemática", year: 3, semester: 1 },
  { name: "Finanzas Públicas II (Argentina)", year: 3, semester: 1 },
  { name: "Historia Económica y Social General", year: 3, semester: 1 },

  { name: "Estadística II", year: 3, semester: 2 },
  { name: "Microeconomía II", year: 3, semester: 2 },
  { name: "Macroeconomía II", year: 3, semester: 2 },

  // CUARTO AÑO
  { name: "Econometría I", year: 4, semester: 1 },
  { name: "Moneda Crédito y Banco", year: 4, semester: 1 },
  { name: "Economía Internacional", year: 4, semester: 1 },

  { name: "Econometría II", year: 4, semester: 2 },
  { name: "Economía de la Empresa y la Organización Industrial", year: 4, semester: 2 },
  { name: "Teoría Económica Coyuntural", year: 4, semester: 2 },
  { name: "Economía Espacial", year: 4, semester: 2 },

  // QUINTO AÑO
  { name: "Historia del Pensamiento Económico", year: 5, semester: 1 },
  { name: "Teoría del Desarrollo Económico", year: 5, semester: 1 },
  { name: "Economía y Regulación de los Servicios Públicos", year: 5, semester: 1 },
  { name: "Finanzas Internacionales", year: 5, semester: 1 },

  { name: "Análisis de Proyectos de Inversión", year: 5, semester: 2 },
  { name: "Política Económica I", year: 5, semester: 2 },
  { name: "Política Económica II", year: 5, semester: 2 },
];

(async function main() {
  try {
    await init();

    let inserted = 0;
    let updated = 0;
    let deletedDupes = 0;

    for (const s of SUBJECTS) {
      const name = String(s.name || "").trim();
      const ck = canonKey(name);

      const matches = await all(
        `SELECT id, name
           FROM subjects
          WHERE career = ?
            AND CAST(plan AS INTEGER) = ?
            AND LOWER(TRIM(name)) = LOWER(TRIM(?))
          ORDER BY id ASC`,
        [CAREER, PLAN, name]
      );

      if (!matches.length) {
        await run(
          `INSERT INTO subjects (name, subject_name, canonical_key, year, semester, career, plan, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [name, name, ck, s.year, s.semester, CAREER, PLAN]
        );
        inserted++;
        continue;
      }

      const keepId = matches[0].id;

      await run(
        `UPDATE subjects
            SET name = ?,
                subject_name = ?,
                canonical_key = ?,
                year = ?,
                semester = ?,
                career = ?,
                plan = ?
          WHERE id = ?`,
        [name, name, ck, s.year, s.semester, CAREER, PLAN, keepId]
      );
      updated++;

      if (matches.length > 1) {
        for (const dup of matches.slice(1)) {
          await run(`DELETE FROM subjects WHERE id = ?`, [dup.id]);
          deletedDupes++;
        }
      }
    }

    const rows = await all(
      `SELECT id, year, semester, name
         FROM subjects
        WHERE career = ? AND CAST(plan AS INTEGER) = ?
        ORDER BY year ASC, COALESCE(semester, 9) ASC, name ASC`,
      [CAREER, PLAN]
    );

    console.log(`✅ Materias cargadas para ${CAREER} · Plan ${PLAN}`);
    console.log(`✅ Nuevas insertadas: ${inserted}`);
    console.log(`✅ Actualizadas: ${updated}`);
    console.log(`✅ Duplicadas eliminadas: ${deletedDupes}`);
    console.log(`✅ Total actual en DB para ese plan: ${rows.length}`);
    console.table(rows);

    process.exit(0);
  } catch (e) {
    console.error("❌ Error cargando Economía Plan 6:", e);
    process.exit(1);
  }
})();