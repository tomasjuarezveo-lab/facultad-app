// scripts/db_counts.js
const { init, all } = require('../models/db');

(async () => {
  await init();
  const pragma = await all('PRAGMA table_info(correlatives)');
  console.log('PRAGMA correlatives columns:', pragma.map(c => c.name));

  const rows = await all(`
    SELECT 'subjects_admin7' as k, COUNT(*) c FROM subjects WHERE career='Lic. en Administración de Empresas' AND plan=7
    UNION ALL
    SELECT 'subjects_conta7', COUNT(*) FROM subjects WHERE career='Contabilidad' AND plan=7
    UNION ALL
    SELECT 'corr_json_admin7', COUNT(*) FROM correlatives WHERE career='Lic. en Administración de Empresas' AND plan=7
    UNION ALL
    SELECT 'corr_json_conta7', COUNT(*) FROM correlatives WHERE career='Contabilidad' AND plan=7
  `);

  console.table(rows);

  // Muestra 5 subjects de cada scope (para ver nombres “reales”)
  const sAdm = await all(`SELECT id,name FROM subjects WHERE career='Lic. en Administración de Empresas' AND plan=7 ORDER BY name LIMIT 5`);
  const sCon = await all(`SELECT id,name FROM subjects WHERE career='Contabilidad' AND plan=7 ORDER BY name LIMIT 5`);
  console.log('Subjects Admin/7 sample:', sAdm);
  console.log('Subjects Contabilidad/7 sample:', sCon);

  // Muestra 3 correlativas JSON de cada scope (para ver cómo quedaron los nombres allí)
  const cAdm = await all(`SELECT subject_name, requires_json FROM correlatives WHERE career='Lic. en Administración de Empresas' AND plan=7 LIMIT 3`);
  const cCon = await all(`SELECT subject_name, requires_json FROM correlatives WHERE career='Contabilidad' AND plan=7 LIMIT 3`);
  console.log('Correlativas JSON Admin/7 sample:', cAdm);
  console.log('Correlativas JSON Contabilidad/7 sample:', cCon);

  process.exit(0);
})();
