// scripts/fix_admin_plan7_correlativas_names.js
// Normaliza subject_name y requires_json a los nombres EXACTOS que existen en subjects (Admin/7).
const { init, all, get, run } = require('../models/db');

function normalize(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}

const CAREER = 'Lic. en Administración de Empresas';
const PLAN = 7;

(async () => {
  try{
    await init();

    const subjects = await all(
      `SELECT id, name FROM subjects WHERE career=? AND plan=?`,
      [CAREER, PLAN]
    );
    const byNorm = new Map(subjects.map(s => [normalize(s.name), s.name]));

    const rows = await all(
      `SELECT id, subject_name, requires_json
         FROM correlatives
        WHERE career=? AND plan=?`,
      [CAREER, PLAN]
    );

    let fixed=0, skipped=0;

    for (const r of rows){
      const origName = r.subject_name || '';
      const normName = byNorm.get(normalize(origName));
      if (!normName) { skipped++; continue; }

      let reqs = [];
      try{
        const parsed = JSON.parse(r.requires_json || '[]');
        reqs = Array.isArray(parsed) ? parsed : [];
      }catch{}

      const fixedReqs = [];
      for (const req of reqs){
        const hit = byNorm.get(normalize(req));
        if (hit) fixedReqs.push(hit);
      }

      await run(
        `UPDATE correlatives
            SET subject_name=?, requires_json=?, rule_type='list'
          WHERE id=?`,
        [normName, JSON.stringify(Array.from(new Set(fixedReqs))), r.id]
      );
      fixed++;
    }

    console.log('OK - normalizados nombres correlativas Admin/7. Fixed=', fixed, 'Skipped(no subject match)=', skipped);
    process.exit(0);
  } catch (e){
    console.error('ERROR fix_admin_plan7_correlativas_names:', e);
    process.exit(1);
  }
})();