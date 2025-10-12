// scripts/clear_subjects.js
const { init, run } = require("../models/db");

(async () => {
  try {
    await init();

    // Borrar correlativas y documentos primero (dependen de subjects)
    await run("DELETE FROM correlatives");
    await run("DELETE FROM documents");
    await run("DELETE FROM finals");
    await run("DELETE FROM quiz_questions");
    await run("DELETE FROM professors");
    await run("DELETE FROM reviews");

    // Finalmente, borrar todas las materias
    await run("DELETE FROM subjects");

    console.log("✅ Se borraron todas las materias, correlativas, documentos, finales, profesores y preguntas.");
    process.exit(0);
  } catch (e) {
    console.error("❌ Error al borrar:", e);
    process.exit(1);
  }
})();
