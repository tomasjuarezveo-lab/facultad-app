// scripts/fix_career_aliases.js
// Normaliza labels de career en DB para cumplir con el CHECK: 'Lic. en Administración de Empresas' | 'Lic. en Economía' | 'Contabilidad'
// Ejecutar: node scripts/fix_career_aliases.js

const { init, run } = require('../models/db');

(async () => {
  try{
    await init();

    const aliases = [
      'Contador Público',
      'Contador Publico',
      'CP',
      'Cont.'
    ];

    for (const a of aliases){
      await run(`UPDATE subjects SET career='Contabilidad' WHERE career=?`, [a]);
      await run(`UPDATE correlatives SET career='Contabilidad' WHERE career=?`, [a]);
    }

    console.log('OK - careers normalizados a "Contabilidad" donde correspondía.');
    process.exit(0);
  } catch (e){
    console.error('ERROR fix_career_aliases:', e);
    process.exit(1);
  }
})();
