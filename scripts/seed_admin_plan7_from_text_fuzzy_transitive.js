
// scripts/seed_admin_plan7_from_text_fuzzy_transitive.js (v3 definitivo)
// Uso:
//   node scripts/seed_admin_plan7_from_text_fuzzy_transitive.js ./scripts/materias_unificadas_sin_duplicados_DEFINITIVO.txt
//
// Cambios clave v3:
//  - Normalización agresiva (quita códigos, paréntesis, signos, múltiple espacio, acentos).
//  - ALIASES extensos (mojibake y variantes comunes).
//  - Matching difuso con Levenshtein y ratio mínimo (>= 0.75).
//  - Reducción transitiva (evita prerequisitos redundantes).
//
// Requisitos: Node estándar (fs, path) y ../models/db

const fs = require("fs");
const path = require("path");
const { run, all } = require("../models/db");

const CAREER = "Lic. en Administración de Empresas";
const PLAN   = 7;

// ---------- Normalización ----------
function deAccent(s){ return s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function norm(s){
  if(!s) return "";
  return deAccent(String(s).replace(/\u00A0/g," ").replace(/\s+/g," ").trim());
}
function canonical(s){
  s = norm(s);
  // quita códigos finales "(####)" y cualquier paréntesis con descripciones
  s = s.replace(/\(\s*\d+[A-Za-z]?\s*\)\s*$/g, "");
  s = s.replace(/\([^)]*\)/g, "");
  s = s.replace(/[.,;:]/g, "");
  s = s.replace(/\s+/g, " ");
  return s.trim().toLowerCase();
}

// ---------- ALIASES (mojibake y variantes) ----------
const ALIASES = new Map([
  // Mojibake acentuación
  ["macroeconomia i", "Macroeconomía I"],
  ["interpretacion de los estados contables", "Interpretación de los Estados Contables"],
  ["administracion publica", "Administración Pública"],
  ["estadistica aplicada", "Estadística Aplicada"],
  ["administracion de la produccion", "Administración de la Producción"],
  ["diseno de sistemas de informacion", "Diseño de Sistemas de Información"],
  ["tecnologia informatica y sistemas de informacion para la direccion", "Tecnología Informática y Sistemas de Información para la Dirección"],
  ["topicos avanzados en finanzas", "Tópicos Avanzados en Finanzas"],
  ["direccion general", "Dirección General"],
  ["historia economica y social i", "Historia Económica y Social I"],
  ["historia economica y social", "Historia Económica y Social"],
  ["introduccion a la economia y estructura economica argentina", "Introducción a la Economía y Estructura Económica Argentina"],
  ["administracion i", "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)"],
  ["administracion ii", "Administración II (Técnicas Administrativas y Gestión Organizacional)"],
  ["administracion iii", "Administración III (Planeamiento y Control Organizacional)"],
  ["psicosociologia organizacional", "Psicosociología Organizacional"],
  ["marketing estrategico", "Marketing Estratégico"],
  ["marketing tactico y operativo", "Marketing Táctico y Operativo"],
  ["finanzas publicas", "Finanzas Públicas"],
  ["matematica i", "Matemática I"],
  ["matematica ii", "Matemática II"],
  ["microeconomia i", "Microeconomía I"],
  ["gestion y desarrollo de las personas en la organizaciones", "Gestión y Desarrollo de las personas en las Organizaciones"],
  ["gestion y desarrollo de las personas en las organizaciones", "Gestión y Desarrollo de las personas en las Organizaciones"],
  ["trabajo y sociedad", "Trabajo y Sociedad"],
]);

function aliasOrSelf(name){
  const c = canonical(name);
  return ALIASES.get(c) || name;
}

// ---------- Parse del TXT ----------
function parseTxt(filePath){
  const raw = fs.readFileSync(filePath, "utf-8");
  const blocks = raw.split(/\n\s*\n/);
  const out = [];
  for(const blk of blocks){
    const lines = blk.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if(lines.length === 0) continue;
    let title = aliasOrSelf(lines[0]);
    let regs = "", fins = "";
    for(const ln of lines.slice(1)){
      const m1 = ln.match(/^Regularizadas:\s*(.*)$/i);
      const m2 = ln.match(/^Final aprobado:\s*(.*)$/i);
      if(m1){ regs = m1[1].trim(); continue; }
      if(m2){ fins = m2[1].trim(); continue; }
    }
    function splitList(s){
      if(!s) return [];
      const v = s.trim().toLowerCase();
      if(v === "ninguna" || v === "x" || v === "-") return [];
      return s.split(",").map(x => aliasOrSelf(x.trim())).filter(Boolean);
    }
    out.push({ name: title, regularizadas: splitList(regs), finales: splitList(fins) });
  }
  return out;
}

// ---------- Levenshtein + ratio ----------
function levenshtein(a,b){
  a = canonical(a); b = canonical(b);
  const m=a.length, n=b.length;
  if(m===0) return n;
  if(n===0) return m;
  const dp = Array.from({length:m+1}, ()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost = (a[i-1]===b[j-1]) ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function levRatio(a,b){
  const A = canonical(a), B = canonical(b);
  const L = Math.max(A.length, B.length) || 1;
  return 1 - (levenshtein(A,B)/L);
}

// ---------- Fetch subjects ----------
async function fetchSubjects(){
  const rows = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
  const byCanon = new Map();
  const list = [];
  for(const r of rows){
    byCanon.set(canonical(r.name), r);
    list.push(r);
  }
  return { byCanon, list };
}

function findBest(name, db){
  const c = canonical(name);
  if(db.byCanon.has(c)) return db.byCanon.get(c);
  let best = null, bestScore = -1;
  for(const r of db.list){
    const score = levRatio(name, r.name);
    if(score > bestScore){ bestScore = score; best = r; }
  }
  // Aceptamos si la similitud es razonable
  if(best && bestScore >= 0.75) return best;
  // Último intento: inclusión de tokens
  const tokens = c.split(/\s+/).filter(Boolean);
  for(const r of db.list){
    const R = canonical(r.name);
    const hit = tokens.every(t => R.includes(t));
    if(hit) return r;
  }
  return null;
}

// ---------- Reducción transitiva ----------
function reduceTransitive(eList){
  const out = [];
  const grouped = new Map(); // key: src|type -> Set(dep)
  for(const e of eList){
    const key = `${e.srcId}|${e.type}`;
    if(!grouped.has(key)) grouped.set(key, new Set());
    grouped.get(key).add(e.depId);
  }
  for(const [key, deps] of grouped.entries()){
    const [srcId, type] = key.split("|");
    const depSet = new Set(deps);
    // mapa d1 -> {d2,...} si d1 depende de d2 (mismo tipo)
    const parents = new Map();
    for(const d of depSet) parents.set(d, new Set());
    for(const e of eList){
      if(String(e.type)!==String(type)) continue;
      if(depSet.has(e.srcId) && depSet.has(e.depId)){
        parents.get(e.srcId).add(e.depId);
      }
    }
    const redundant = new Set();
    function dfs(u, visited){
      if(visited.has(u)) return;
      visited.add(u);
      for(const v of (parents.get(u) || [])){
        redundant.add(v);
        dfs(v, visited);
      }
    }
    for(const d of depSet){ dfs(d, new Set()); }
    for(const d of depSet){
      if(!redundant.has(d)){
        out.push({ srcId: Number(srcId), depId: d, type });
      }
    }
  }
  return out;
}

// ---------- Main ----------
(async function main(){
  try{
    const argPath = process.argv[2] || "./scripts/materias_unificadas_sin_duplicados_DEFINITIVO.txt";
    const inPath = path.resolve(process.cwd(), argPath);
    if(!fs.existsSync(inPath)){
      console.error("❌ No se encontró el archivo de entrada:", inPath);
      process.exit(1);
    }

    const db = await fetchSubjects();
    const parsed = parseTxt(inPath);

    const edges = [];
    for(const entry of parsed){
      const srcRow = findBest(entry.name, db);
      if(!srcRow){ console.warn("⚠️ No encontrada en DB (omito):", entry.name); continue; }

      for(const rName of entry.regularizadas){
        const depRow = findBest(rName, db);
        if(!depRow){ console.warn("⚠️ Regularizada no encontrada:", rName, "para", entry.name); continue; }
        edges.push({ srcId: srcRow.id, depId: depRow.id, type: "cursada" });
      }
      for(const fName of entry.finales){
        const depRow = findBest(fName, db);
        if(!depRow){ console.warn("⚠️ Final no encontrado:", fName, "para", entry.name); continue; }
        edges.push({ srcId: srcRow.id, depId: depRow.id, type: "final" });
      }
    }

    const reduced = reduceTransitive(edges);

    await run(`DELETE FROM correlatives WHERE subject_id IN (SELECT id FROM subjects WHERE career=? AND plan=?)`, [CAREER, PLAN]);
    for(const e of reduced){
      await run(`INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?,?,?)`, [e.srcId, e.depId, e.type]);
    }

    const resumen = await all(`
      SELECT s.name AS destino, c.req_type AS tipo, d.name AS requisito
      FROM correlatives c
      JOIN subjects s ON s.id = c.subject_id
      JOIN subjects d ON d.id = c.depends_on_id
      WHERE s.career=? AND s.plan=?
      ORDER BY destino, tipo, requisito
    `, [CAREER, PLAN]);

    console.log("✅ Correlativas actualizadas para", CAREER, "Plan", PLAN);
    console.table(resumen);
    process.exit(0);
  }catch(e){
    console.error("❌ Error al actualizar correlativas:", e);
    process.exit(1);
  }
})();
