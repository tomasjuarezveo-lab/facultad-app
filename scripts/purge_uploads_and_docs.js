// scripts/purge_uploads_and_docs.js
const fs = require('fs');
const path = require('path');
const { init, run, all } = require('../models/db');

(async () => {
  try {
    await init();

    const upDir = path.join(__dirname, '..', 'public', 'uploads', 'docs');
    if (fs.existsSync(upDir)) {
      const files = fs.readdirSync(upDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(upDir, f)); } catch (e) {}
      }
      console.log(`🧹 Archivos eliminados de ${upDir}:`, files.length);
    } else {
      console.log('ℹ️ Carpeta de uploads no existe, nada que borrar.');
    }

    // Borrar registros de la tabla documents
    await run(`DELETE FROM documents`);
    console.log('🧹 Tabla documents vaciada');

    // (Opcional) resetear intentos de quiz, etc. si querés un reset más amplio
    // await run(`DELETE FROM quiz_attempts`);

    console.log('✅ Purga completada');
    process.exit(0);
  } catch (e) {
    console.error('❌ Error en purga:', e);
    process.exit(1);
  }
})();