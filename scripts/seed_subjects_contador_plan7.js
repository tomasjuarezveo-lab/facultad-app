// scripts/seed_correlativas_contador_plan7.js
// Inserta correlativas para Contabilidad (ex Contador Público) - Plan 7 (FCE-UNLP)
// Ejecutar con: node scripts/seed_correlativas_contador_plan7.js

const fs = require("fs");
const path = require("path");
const { init, run, all, get } = require("../models/db");

const CAREER = "Contabilidad"; // <-- alineado con CHECK
const PLAN = 7;
const DATA_PATH = path.join(__dirname, "../data/correlativas_contador_plan7.json");

async function getTableInfo(table){ return await all(`PRAGMA table_info(${table})`); }
function hasColumns(info, cols){ const names = new Set(info.map(c => c.name)); return cols.every(c => names.has(c)); }

async function ensureTable(){
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

  const info = await getTableInfo("correlatives");
  const needed = ["career","plan","subject_code","subject_name","requires_json","rule_type","rule_value","notes"];
  if (!hasColumns(info, needed)){
    await run(`ALTER TABLE correlatives RENAME TO correlatives_old`);
    await run(`CREATE TABLE correlatives (
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
    const oldInfo = await getTableInfo("correlatives_old");
    const oldCols = new Set(oldInfo.map(c => c.name));
    const selCareer = oldCols.has("career") ? "career" : "'" + CAREER + "'";
    const selPlan   = oldCols.has("plan")   ? "plan"   : String(PLAN);
    const selCode   = oldCols.has("subject_code") ? "subject_code" : "NULL";
    const selName   = oldCols.has("subject_name") ? "subject_name" : (oldCols.has("name") ? "name" : "'(sin nombre)'");
    const selReq    = oldCols.has("requires_json") ? "requires_json" : (oldCols.has("requires") ? "json(requires)" : "'[]'");
    const selRuleT  = oldCols.has("rule_type") ? "rule_type" : "NULL";
    const selRuleV  = oldCols.has("rule_value") ? "rule_value" : "NULL";
    const selNotes  = oldCols.has("notes") ? "notes" : "NULL";

    await run(`INSERT INTO correlatives (career, plan, subject_code, subject_name, requires_json, rule_type, rule_value, notes)
               SELECT ${selCareer}, ${selPlan}, ${selCode}, ${selName}, ${selReq}, ${selRuleT}, ${selRuleV}, ${selNotes}
               FROM correlatives_old
               WHERE ${selName} IS NOT NULL AND TRIM(${selName}) <> ''`);
    await run(`DROP TABLE correlatives_old`);
  }

  await run(`CREATE INDEX IF NOT EXISTS idx_corr_career_plan_name ON correlatives(career, plan, subject_name)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_corr_code ON correlatives(subject_code)`);
}

async function upsertRow(row){
  const exists = await get(
    `SELECT id FROM correlatives WHERE career=? AND plan=? AND subject_name=?`,
    [CAREER, PLAN, row.name]
  );
  const requires = JSON.stringify(row.requires || []);
  const ruleType = row.rule || (row.requires && row.requires.length ? "list" : null);
  const ruleValue = row.rule_value || null;
  if (exists){
    await run(
      `UPDATE correlatives
       SET subject_code=?, requires_json=?, rule_type=?, rule_value=?, notes=?
       WHERE id=?`,
      [row.code || null, requires, ruleType, ruleValue, row.notes || null, exists.id]
    );
    return { action: "updated" };
  } else {
    await run(
      `INSERT INTO correlatives (career, plan, subject_code, subject_name, requires_json, rule_type, rule_value, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [CAREER, PLAN, row.code || null, row.name, requires, ruleType, ruleValue, row.notes || null]
    );
    return { action: "inserted" };
  }
}

(async () => {
  try{
    await init();
    await ensureTable();

    const payload = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    let ins=0, upd=0;

    for (const row of (payload.subjects || [])){
      const r = await upsertRow(row);
      if (r.action === "inserted") ins++; else upd++;
    }

    const rows = await all(
      `SELECT subject_name, subject_code, requires_json, rule_type, rule_value
         FROM correlatives WHERE career=? AND plan=?
         ORDER BY subject_name`,
      [CAREER, PLAN]
    );

    console.log("OK - Correlativas cargadas (Contabilidad Plan " + PLAN + ") - Insertadas=" + ins + " - Actualizadas=" + upd + " - Total=" + rows.length);
    console.table(rows);
    process.exit(0);
  } catch (e){
    console.error("ERROR - seed correlativas:", e);
    process.exit(1);
  }
})();
