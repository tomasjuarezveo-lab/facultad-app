// Carga correlativas JSON para Contabilidad - Plan 7
// Fuente: data/correlativas_contador_plan7.json (subjects: [{name, requires: [...]}])
const fs = require('fs');
const path = require('path');
const { init, run, all } = require('../models/db');

const CAREER = 'Contabilidad';
const PLAN = 7;
const DATA = path.join(__dirname, '../data/correlativas_contador_plan7.json');

function normalize(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}

(async () => {
  try{
    await init();
    if (!fs.existsSync(DATA)) {
      console.error('No existe', DATA);
      process.exit(1);
    }
    // asegurar tabla JSON (por si acaso)
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

    const subjects = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
    const byName = new Map(subjects.map(s => [normalize(s.name), s.name]));

    const payload = JSON.parse(fs.readFileSync(DATA,'utf-8'));
    const list = Array.isArray(payload.subjects) ? payload.subjects : [];

    await run(`DELETE FROM correlatives WHERE career=? AND plan=?`, [CAREER, PLAN]);

    let ins=0, miss=0;
    for (const row of list){
      const subjName = byName.get(normalize(row.name));
      if (!subjName){ miss++; continue; }

      const reqs = [];
      for (const req of (row.requires||[])){
        const hit = byName.get(normalize(req));
        if (hit) reqs.push(hit);
      }
      const requires_json = JSON.stringify(Array.from(new Set(reqs)));
      await run(
        `INSERT INTO correlatives (career, plan, subject_name, requires_json, rule_type) VALUES (?,?,?,?, 'list')`,
        [CAREER, PLAN, subjName, requires_json]
      );
      ins++;
    }

    const tot = await all(`SELECT COUNT(*) c FROM correlatives WHERE career=? AND plan=?`, [CAREER, PLAN]);
    console.log('✅ Contabilidad Plan 7 JSON — Insertadas:', ins, 'Omitidas(sin subject):', miss, 'Total ahora:', tot[0].c);
    process.exit(0);
  }catch(e){
    console.error('❌ Error seed_correlativas_contabilidad_plan7_json:', e);
    process.exit(1);
  }
})();
