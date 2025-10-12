// scripts/dump_subjects_conta7.js
const { init, all } = require('../models/db');
(async () => {
  await init();
  const rows = await all(
    `SELECT id, name FROM subjects WHERE career='Contabilidad' AND plan=7 ORDER BY name`
  );
  console.table(rows);
  process.exit(0);
})();