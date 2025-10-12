// routes/verify.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Directorios y archivos
const VERIFY_DIR   = path.join(__dirname, '..', 'data', 'verification');
const ACTIVE_FILE  = path.join(VERIFY_DIR, 'active.txt');
const USED_FILE    = path.join(VERIFY_DIR, 'used.txt');
const CONFIG_FILE  = path.join(VERIFY_DIR, 'config.json'); // { enabled:boolean, startedAt:number }

function ensureDirs() {
  try { fs.mkdirSync(VERIFY_DIR, { recursive: true }); } catch {}
  for (const f of [ACTIVE_FILE, USED_FILE]) {
    try { if (!fs.existsSync(f)) fs.writeFileSync(f, ''); } catch {}
  }
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ enabled: false, startedAt: 0 }, null, 2));
    }
  } catch {}
}
ensureDirs();

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { enabled: false, startedAt: 0 }; }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function parseCodesFromText(txt) {
  return String(txt || '')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean);
}
function readCodes(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseCodesFromText(raw);
  } catch { return []; }
}
function writeCodes(filePath, codes) {
  const body = (codes || []).join(' | ');
  fs.writeFileSync(filePath, body);
}
function addActiveCodes(newCodes) {
  const active = readCodes(ACTIVE_FILE);
  const used = new Set(readCodes(USED_FILE));
  const set = new Set(active);
  for (const c of newCodes) {
    if (!used.has(c)) set.add(c);
  }
  writeCodes(ACTIVE_FILE, Array.from(set));
}
function consumeCodeOnce(code) {
  const active = readCodes(ACTIVE_FILE);
  if (!active.includes(code)) return false;
  const remaining = active.filter(c => c !== code);
  writeCodes(ACTIVE_FILE, remaining);
  const used = readCodes(USED_FILE);
  used.push(code);
  writeCodes(USED_FILE, used);
  return true;
}

// ======= Factory de router =======
function makeRouter() {
  const router = express.Router();

  // Activar / desactivar verificación (ADMIN)
  router.post('/toggle', express.json(), (req, res) => {
    const { enabled } = req.body || {};
    const cfg = readConfig();
    const wantEnabled = !!enabled;

    if (wantEnabled && !cfg.enabled) {
      cfg.enabled = true;
      cfg.startedAt = Date.now(); // arranca reloj global
    } else if (!wantEnabled && cfg.enabled) {
      cfg.enabled = false;
      cfg.startedAt = 0; // resetea reloj global
    }
    writeConfig(cfg);
    res.json({ ok: true, enabled: cfg.enabled, startedAt: cfg.startedAt || 0 });
  });

  // Listar estado + códigos (ADMIN)
  router.get('/list', (req, res) => {
    const cfg = readConfig();
    const active = readCodes(ACTIVE_FILE);
    const used = readCodes(USED_FILE);
    res.json({
      ok: true,
      enabled: !!cfg.enabled,
      startedAt: Number(cfg.startedAt || 0),
      active: active.join(' | '),
      used: used.join(' | ')
    });
  });

  // Subir archivo de códigos activos (formato "AAA|BBB|CCC")
  const upload = multer({ storage: multer.memoryStorage() });
  router.post('/upload', upload.single('codesFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta archivo' });
    const text = req.file.buffer.toString('utf8');
    const codes = parseCodesFromText(text);
    if (!codes.length) return res.status(400).json({ ok: false, error: 'Sin códigos' });
    addActiveCodes(codes);
    const active = readCodes(ACTIVE_FILE);
    res.json({ ok: true, added: codes.length, active: active.join(' | ') });
  });

  return router;
}

// Export principal (router factory)
module.exports = makeRouter;

// Export util en el MISMO objeto exportado
module.exports.util = {
  getConfig: () => readConfig(),
  getEnabled: () => !!readConfig().enabled,
  getStartedAt: () => Number(readConfig().startedAt || 0),
  validateAndConsumeCode(code) {
    ensureDirs();
    return consumeCodeOnce(String(code).trim());
  }
};
