
// scripts/fix_dedup_subjects.js
// Uso:
//   node scripts/fix_dedup_subjects.js
//
// Deduplica materias en `subjects` por (career, plan, name).
// 1) Crea una tabla de mapeo (old_id -> keep_id).
// 2) Actualiza FKs en tablas relacionadas (correlatives, group_members, group_messages, documents).
// 3) Borra duplicados sobrantes.
// 4) Crea índice único para evitar duplicados futuros.
//
// Requiere: ../models/db (run, all).

const { run, all } = require("../models/db");

(async function main(){
  try{
    await run("BEGIN");

    // 1) Crear tabla temporal de mapeo: para cada (career, plan, name) quedarse con el menor id como 'keep_id'
    await run(`
      CREATE TEMP TABLE IF NOT EXISTS dedup_map AS
      WITH d AS (
        SELECT career, plan, name, MIN(id) AS keep_id
        FROM subjects
        GROUP BY career, plan, name
      )
      SELECT s.id AS old_id, d.keep_id, s.career, s.plan, s.name
      FROM subjects s
      JOIN d ON d.career = s.career AND d.plan = s.plan AND d.name = s.name
      WHERE s.id != d.keep_id
    `);

    // 2) Actualizar FKs (agrega aquí más tablas si tuvieras otras con subject_id)
    // 2.a) correlatives.subject_id
    await run(`
      UPDATE correlatives
      SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = correlatives.subject_id)
      WHERE subject_id IN (SELECT old_id FROM dedup_map)
    `);
    // 2.b) correlatives.depends_on_id
    await run(`
      UPDATE correlatives
      SET depends_on_id = (SELECT keep_id FROM dedup_map WHERE old_id = correlatives.depends_on_id)
      WHERE depends_on_id IN (SELECT old_id FROM dedup_map)
    `);

    // 2.c) group_members.subject_id
    await run(`
      UPDATE group_members
      SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = group_members.subject_id)
      WHERE subject_id IN (SELECT old_id FROM dedup_map)
    `);

    // 2.d) group_messages.subject_id
    await run(`
      UPDATE group_messages
      SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = group_messages.subject_id)
      WHERE subject_id IN (SELECT old_id FROM dedup_map)
    `);

    // 2.e) documents.subject_id (si existe)
    await run(`
      UPDATE documents
      SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = documents.subject_id)
      WHERE subject_id IN (SELECT old_id FROM dedup_map)
    `).catch(()=>{}); // por si la tabla no existe en tu versión

    // 3) Borrar duplicados antiguos
    await run(`DELETE FROM subjects WHERE id IN (SELECT old_id FROM dedup_map)`);

    // 4) Índice único para prevenir futuros duplicados exactos
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_subjects_unique ON subjects(career, plan, name)`);

    await run("COMMIT");

    const left = await all(`
      SELECT career, plan, name, COUNT(*) AS cnt
      FROM subjects
      GROUP BY career, plan, name
      HAVING cnt > 1
    `);
    if(left.length){
      console.warn("⚠️ Aún quedan duplicados (revisar nombres con espacios/acentos distintos):");
      console.table(left);
    }else{
      console.log("✅ Dedupe completo. Índice único creado: ux_subjects_unique (career, plan, name).");
    }
    process.exit(0);
  }catch(e){
    await run("ROLLBACK").catch(()=>{});
    console.error("❌ Error en fix_dedup_subjects:", e);
    process.exit(1);
  }
})();
