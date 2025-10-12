// scripts/migrate_legacy_correlatives_to_json.js
// Intenta recuperar correlativas legacy (subject_id/depends_on_id) y convertirlas al esquema nuevo con requires_json.
// Soporta carrera/plan por parámetros de CLI: --career="Lic. en Administración de Empresas" --plan=7
// Uso: node scripts/migrate_legacy_correlatives_to_json.js --career="Lic. en Administración de Empresas" --plan=7

const { init, all, get, run } = require('../models/db');

function arg(k, def=null){
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  if (!hit) return def;
  return hit.substring(k.length+3);
}

const CAREER = arg('career', 'Lic. en Administración de Empresas');
const PLAN = parseInt(arg('plan', '7'), 10);

async function tableInfo(name){ return await all(`PRAGMA table_info(${name})`); }

(async () => {
  try{
    await init();

    // ¿Tiene esquema legacy?
    const info = await tableInfo('correlatives');
    const names = new Set(info.map(c => c.name));
    const isLegacy = names.has('subject_id') && names.has('depends_on_id');
    if (!isLegacy){
      console.log('No hay esquema legacy en correlatives. Nada que migrar.');
      process.exit(0);
    }

    // Subjects de ese (career, plan)
    const subjects = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
    const byId = new Map(subjects.map(s => [s.id, s.name]));

    // Edges legacy
    const edges = await all(
      `SELECT c.subject_id, c.depends_on_id
         FROM correlatives c
         JOIN subjects s ON s.id = c.subject_id
        WHERE s.career=? AND s.plan=?`,
      [CAREER, PLAN]
    );

    // Armar requires por nombre
    const reqMap = new Map(); // name -> Set(requiresName)
    for (const e of edges){
      const subjName = byId.get(e.subject_id);
      const depName  = byId.get(e.depends_on_id);
      if (!subjName || !depName) continue;
      if (!reqMap.has(subjName)) reqMap.set(subjName, new Set());
      reqMap.get(subjName).add(depName);
    }

    // Asegurar tabla nueva (por si falta alguna columna)
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

    // Upsert de cada materia
    for (const [name, set] of reqMap){
      const requires = JSON.stringify(Array.from(set));
      const row = await get(`SELECT id FROM correlatives WHERE career=? AND plan=? AND subject_name=?`, [CAREER, PLAN, name]);
      if (row){
        await run(`UPDATE correlatives SET requires_json=?, rule_type='list' WHERE id=?`, [requires, row.id]);
      } else {
        await run(`INSERT INTO correlatives (career, plan, subject_name, requires_json, rule_type) VALUES (?, ?, ?, ?, 'list')`, [CAREER, PLAN, name, requires]);
      }
    }

    console.log(`OK - Migradas correlativas legacy a esquema nuevo para ${CAREER} Plan ${PLAN}.`);
    process.exit(0);
  } catch (e){
    console.error('ERROR migrate_legacy_correlatives_to_json:', e);
    process.exit(1);
  }
})();
