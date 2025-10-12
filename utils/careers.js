// utils/careers.js
const CANON = [
  "Lic. en Administración de Empresas",
  "Lic. en Economía",
  "Contabilidad",
];

const ALIASES = new Map([
  // Administración
  ["administración", "Lic. en Administración de Empresas"],
  ["administracion", "Lic. en Administración de Empresas"],
  ["administración de empresas", "Lic. en Administración de Empresas"],
  ["administracion de empresas", "Lic. en Administración de Empresas"],
  ["lic. en administración de empresas", "Lic. en Administración de Empresas"],
  ["lic en administracion de empresas", "Lic. en Administración de Empresas"],
  ["licenciatura en administración de empresas", "Lic. en Administración de Empresas"],
  ["administración y", "Lic. en Administración de Empresas"],

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

function normalizeCareer(value) {
  if (!value) return value;
  const raw = String(value).trim();
  const key = raw.toLowerCase();
  if (ALIASES.has(key)) return ALIASES.get(key);
  return CANON.includes(raw) ? raw : raw;
}

module.exports = { normalizeCareer, CANON };