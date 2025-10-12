// scripts/seed_admin_plan7_json.js
// Carga correlativas para "Lic. en Administración de Empresas" Plan 7 en ESQUEMA JSON
// (subject_name + requires_json + rule_type='list') a partir del TXT consolidado.
//
// Uso:
//   node scripts/seed_admin_plan7_json.js .\scripts\materias_unificadas_sin_duplicados_DEFINITIVO.txt

const fs = require('fs');
const path = require('path');
const { init, run, all, get } = require('../models/db');

const CAREER = 'Lic. en Administración de Empresas';
const PLAN = 7;

function normalize(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\(.*?\)/g,' ')
    .replace(/[^a-z0-9\s]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

const ALIASES = new Map([
  ['tecnicas administrativas y gestion organizacional','Administración II (Técnicas Administrativas y Gestión Organizacional)'],
  ['administracion ii','Administración II (Técnicas Administrativas y Gestión Organizacional)'],
  ['matematica i','Matemática I'],
  ['matematica ii','Matemática II'],
  ['microeconomia i','Microeconomía I'],
  ['macroeconomia i','Macroeconomía I'],
]);

function aliasOrSelf(s){
  const key = normalize(s);
  return ALIASES.get(key) || s;
}

function parseTxt(filePath){
  const raw = fs.readFileSync(filePath,'utf-8');
  const blocks = raw.split(/\n\s*\n/);
  const out = [];
  for(const blk of blocks){
    const lines = blk.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const title = aliasOrSelf(lines[0]);
    let regs="", fins="";
    for(const ln of lines.slice(1)){
      const m1 = ln.match(/^Regularizadas:\s*(.*)$/i);
      const m2 = ln.match(/^Final aprobado:\s*(.*)$/i);
      if (m1) { regs = m1[1].trim(); continue; }
      if (m2) { fins = m2[1].trim(); continue; }
    }
    const regList = regs && !/^Ninguna$/i.test(regs) ? regs.split(/\s*,\s*/) : [];
    const finList = fins && !/^Ninguna$/i.test(fins) ? fins.split(/\s*,\s*/) : [];
    out.push({ name:title, regularizadas: regList, finales: finList });
  }
  return out;
}

(async () => {
  try{
    await init();

    const inPath = process.argv[2] || path.join(__dirname, 'materias_unificadas_sin_duplicados_DEFINITIVO.txt');
    if (!fs.existsSync(inPath)){
      console.error('No se encontró el archivo de entrada:', inPath);
      process.exit(1);
    }

    // Asegurar tabla JSON
    await run(`CREATE TABLE IF NOT EXISTS correlatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      career TEXT NOT NULL,
      plan INTEGER NOT NULL,
      subject_code TEXT,
      subject_name TEXT NOT NULL,
      requires_json TEXT NOT NULL DEFAULT '[]',
      rule_type TEXT,
      rule_value TEXT,
      notes TEXT
    )`);

    // Borrar correlativas del scope (JSON)
    await run(`DELETE FROM correlatives WHERE career=? AND plan=?`, [CAREER, PLAN]);

    // Materias válidas para Admin Plan 7 (deben existir en subjects)
    const subjects = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
    const byName = new Map(subjects.map(s => [normalize(s.name), s.name]));

    // Parsear TXT
    const parsed = parseTxt(inPath);

    // Insertar JSON por materia
    let ins=0, skipMissing=0;
    for(const entry of parsed){
      const subjName = byName.get(normalize(entry.name));
      if (!subjName){ skipMissing++; continue; }

      const reqsSet = new Set();

      for(const r of entry.regularizadas){
        const n = aliasOrSelf(r);
        const found = byName.get(normalize(n));
        if (found) reqsSet.add(found);
      }
      for(const f of entry.finales){
        const n = aliasOrSelf(f);
        const found = byName.get(normalize(n));
        if (found) reqsSet.add(found);
      }

      const requires_json = JSON.stringify(Array.from(reqsSet));
      await run(
        `INSERT INTO correlatives (career, plan, subject_name, requires_json, rule_type) VALUES (?,?,?,?, 'list')`,
        [CAREER, PLAN, subjName, requires_json]
      );
      ins++;
    }

    const count = await get(`SELECT COUNT(*) AS c FROM correlatives WHERE career=? AND plan=?`, [CAREER, PLAN]);
    console.log('✅ Admin Plan 7 cargado en JSON. Insertadas=' + ins + ', Materias no halladas en subjects=' + skipMissing + ', Total ahora=' + count.c);
    process.exit(0);
  } catch (e){
    console.error('❌ Error seed_admin_plan7_json:', e);
    process.exit(1);
  }
})();