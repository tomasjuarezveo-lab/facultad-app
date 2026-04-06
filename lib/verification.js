// lib/verification.js
const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '..', 'data', 'verification');
const CFG_PATH = path.join(BASE_DIR, 'config.json');
const ACTIVE_PATH = path.join(BASE_DIR, 'active.txt');
const USED_PATH   = path.join(BASE_DIR, 'used.txt');

function ensureDirs() {
  try { fs.mkdirSync(BASE_DIR, { recursive: true }); } catch {}
  if (!fs.existsSync(CFG_PATH)) {
    try { fs.writeFileSync(CFG_PATH, JSON.stringify({ enabled: false }, null, 2)); } catch {}
  }
  if (!fs.existsSync(ACTIVE_PATH)) {
    try { fs.writeFileSync(ACTIVE_PATH, ''); } catch {}
  }
  if (!fs.existsSync(USED_PATH)) {
    try { fs.writeFileSync(USED_PATH, ''); } catch {}
  }
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8') || '{}'); }
  catch { return {}; }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function parseCodes(txt) {
  if (!txt) return [];
  return txt
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);
}
function serializeCodes(arr) {
  return arr.join(' | ');
}

function getEnabled() {
  ensureDirs();
  const cfg = readJSON(CFG_PATH);
  return !!cfg.enabled;
}
function setEnabled(on) {
  ensureDirs();
  const cfg = readJSON(CFG_PATH);
  cfg.enabled = !!on;
  writeJSON(CFG_PATH, cfg);
  return cfg.enabled;
}
function listCodes() {
  ensureDirs();
  const active = parseCodes(fs.readFileSync(ACTIVE_PATH, 'utf8'));
  const used   = parseCodes(fs.readFileSync(USED_PATH, 'utf8'));
  return {
    activeText: serializeCodes(active),
    usedText: serializeCodes(used),
    active,
    used
  };
}

/**
 * Valida un código y lo consume (lo saca de activos y lo agrega a usados).
 * Devuelve true si lo consumió, false si no era válido o ya estaba usado.
 */
function validateAndConsumeCode(code) {
  ensureDirs();
  const c = String(code || '').trim();
  if (!c) return false;

  const active = parseCodes(fs.readFileSync(ACTIVE_PATH, 'utf8'));
  const used   = parseCodes(fs.readFileSync(USED_PATH, 'utf8'));

  const idx = active.findIndex(x => x === c);
  if (idx === -1) return false; // no está activo

  // Consumir: quitar de activos y agregar a usados
  active.splice(idx, 1);
  used.push(c);

  fs.writeFileSync(ACTIVE_PATH, serializeCodes(active));
  fs.writeFileSync(USED_PATH, serializeCodes(used));
  return true;
}

/**
 * Agrega nuevos códigos al archivo de “activos” sin duplicar ni mover usados.
 * `codes` puede ser un string con “|” o un array de strings.
 */
function appendActiveCodes(codes) {
  ensureDirs();
  let add = Array.isArray(codes) ? codes : parseCodes(String(codes||''));
  add = add.map(s => s.trim()).filter(Boolean);
  if (!add.length) return { added: 0 };

  const active = parseCodes(fs.readFileSync(ACTIVE_PATH, 'utf8'));
  const used   = parseCodes(fs.readFileSync(USED_PATH, 'utf8'));

  const exists = new Set([...active, ...used]);
  const toAdd = add.filter(c => !exists.has(c));

  if (toAdd.length) {
    const merged = [...active, ...toAdd];
    fs.writeFileSync(ACTIVE_PATH, serializeCodes(merged));
  }
  return { added: toAdd.length };
}

module.exports = {
  getEnabled,
  setEnabled,
  listCodes,
  validateAndConsumeCode,
  appendActiveCodes,
  paths: { BASE_DIR, CFG_PATH, ACTIVE_PATH, USED_PATH }
};