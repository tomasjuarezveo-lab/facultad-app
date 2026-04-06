// scripts/import_json_contabilidad_plan7_to_legacy.js
// Convierte data/correlativas_contador_plan7.json (por nombres/códigos) a correlatives LEGACY (subject_id/depends_on_id)
// para la carrera "Contabilidad" Plan 7.
// Uso:
//   node scripts/import_json_contabilidad_plan7_to_legacy.js

const fs = require("fs");
const path = require("path");
const { all, get, run, init } = require("../models/db");

const CAREER = "Contabilidad";
const PLAN = 7;
const DATA_PATH = path.join(__dirname, "../data/correlativas_contador_plan7.json");

function normalize(s){
  return String(s||"").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\s+/g," ")
    .trim();
}

(async () => {
  try{
    await init();

    const payload = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    const subjects = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
    const byName = new Map(subjects.map(s => [normalize(s.name), s.id]));

    // Limpiar correlativas del scope
    await run(`DELETE FROM correlatives WHERE subject_id IN (SELECT id FROM subjects WHERE career=? AND plan=?)`, [CAREER, PLAN]);

    let ins=0, missTarget=0, missReq=0;
    for(const row of (payload.subjects || [])){
      const subj = row.name;
      const subjId = byName.get(normalize(subj));
      if(!subjId){ missTarget++; continue; }
      const reqs = Array.isArray(row.requires) ? row.requires : [];
      for(const r of reqs){
        const depId = byName.get(normalize(r));
        if(!depId){ missReq++; continue; }
        await run(`INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?,?,?)`, [subjId, depId, "cursada"]);
        ins++;
      }
    }

    console.log("✅ Contabilidad Plan 7 correlativas importadas (LEGACY). Insertadas:", ins, "SinMateria:", missTarget, "SinReq:", missReq);
    process.exit(0);
  }catch(e){
    console.error("❌ Error import_json_contabilidad_plan7_to_legacy:", e);
    process.exit(1);
  }
})();
