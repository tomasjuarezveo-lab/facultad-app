// scripts/migrate_normalize_careers.js
const { init, run } = require("../models/db");

// alias -> canónico
const ALIASES = new Map([
  // Administración
  ["administración", "Lic. en Administración de Empresas"],
  ["administracion", "Lic. en Administración de Empresas"],
  ["administración de empresas", "Lic. en Administración de Empresas"],
  ["administracion de empresas", "Lic. en Administración de Empresas"],
  ["lic. en administración de empresas", "Lic. en Administración de Empresas"],
  ["lic en administracion de empresas", "Lic. en Administración de Empresas"],
  ["licenciatura en administración de empresas", "Lic. en Administración de Empresas"],
  ["administración y", "Lic. en Administración de Empresas"], // por si quedó cortado

  // Economía
  ["economía", "Lic. en Economía"],
  ["economia", "Lic. en Economía"],
  ["lic. en economía", "Lic. en Economía"],
  ["lic en economia", "Lic. en Economía"],
  ["licenciatura en economía", "Lic. en Economía"],

  // Contabilidad
  ["contabilidad", "Contabilidad"],
  ["contador público", "Contabilidad"],
  ["contador publico", "Contabilidad"],
  ["contadora", "Contabilidad"],
]);

function buildCaseSQL(col) {
  // CASE WHEN lower(trim(col))='alias' THEN 'canónico' ...
  const whens = [...ALIASES.entries()]
    .map(([a, c]) => `WHEN lower(trim(${col}))='${a}' THEN '${c}'`)
    .join(' ');
  return `CASE ${whens} ELSE ${col} END`;
}

(async () => {
  try {
    await init();

    // USERS
    await run(`UPDATE users SET career = ${buildCaseSQL('career')}`);

    // SUBJECTS
    await run(`UPDATE subjects SET career = ${buildCaseSQL('career')}`);

    // PROFESSORS (si tu tabla tiene career)
    await run(`UPDATE professors SET career = ${buildCaseSQL('career')}`);

    console.log("✅ Carreras normalizadas en users, subjects y professors.");
    process.exit(0);
  } catch (e) {
    console.error("❌ Error migrando:", e);
    process.exit(1);
  }
})();
