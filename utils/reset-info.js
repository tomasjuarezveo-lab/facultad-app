// utils/reset-info.js

// Fechas fijas (mes 0-11, día 1-31)
const FIXED_DATES = [
  { m: 0,  d: 15 }, // 15 enero
  { m: 1,  d: 17 }, // 17 febrero
  { m: 2,  d: 17 }, // 17 marzo
  { m: 3,  d: 17 }, // 17 abril
  { m: 5,  d: 17 }, // 17 junio
  { m: 6,  d: 20 }, // 20 julio
  { m: 7,  d: 17 }, // 17 agosto
  { m: 8,  d: 17 }, // 17 septiembre
  { m: 10, d: 15 }, // 15 noviembre
];

/**
 * Devuelve un objeto Date con la PRÓXIMA fecha de reseteo (a las 23:59 hora del servidor).
 * Si hoy es fecha de reseteo y todavía no son las 23:59, devolverá hoy 23:59.
 */
function getNextResetDate(now = new Date()) {
  const y = now.getFullYear();

  // Generar lista de candidatos en el año actual y, si todas pasaron, saltar al próximo año
  const candidatesThisYear = FIXED_DATES.map(({ m, d }) => {
    const dt = new Date(y, m, d, 23, 59, 0, 0);
    return dt;
  }).sort((a, b) => a - b);

  const nextThisYear = candidatesThisYear.find(dt => dt.getTime() > now.getTime());
  if (nextThisYear) return nextThisYear;

  // Si ya pasaron todas en el año actual, tomar la primera del año siguiente
  const nextYear = new Date(y + 1, FIXED_DATES[0].m, FIXED_DATES[0].d, 23, 59, 0, 0);
  return nextYear;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** Formatea DD/MM/YYYY */
function formatDDMMYYYY(date) {
  const d = pad(date.getDate());
  const m = pad(date.getMonth() + 1);
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

module.exports = {
  getNextResetDate,
  formatDDMMYYYY,
};
