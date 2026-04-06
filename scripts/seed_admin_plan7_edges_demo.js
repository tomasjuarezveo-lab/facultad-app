// scripts/seed_admin_plan7_from_text_fuzzy_transitive.js
// Uso:
//   node scripts/seed_admin_plan7_from_text_fuzzy_transitive.js ./correlativas_plan7_consolidado.txt
//
// Lee tu TXT consolidado (Materias → Regularizadas / Final aprobado), hace matching difuso
// con los nombres en DB, aplica REDUCCIÓN TRANSITIVA (no conecta prerequisitos viejos)
// y graba correlativas inmediatas en la tabla `correlatives`.
//
// Requisitos: solo Node estándar (sin libs externas).
// Si no pasás ruta, busca "correlativas_plan7_consolidado.txt" en el cwd.

const fs = require("fs");
const path = require("path");
const { run, all } = require("../models/db");

const CAREER = "Lic. en Administración de Empresas";
const PLAN   = 7;

/* ====================== utils de normalización ====================== */
function deAccent(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function norm(s) {
  if (!s) return "";
  return deAccent(String(s).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim());
}
function canonical(s) {
  s = norm(s);
  // quita códigos "(7114)" o contenido entre paréntesis largo, guiones y puntuación
  s = s.replace(/\(\s*\d+\s*\)\s*$/g, "");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/[.,;:!¡¿?\-–—_/]/g, " ");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}
function tokenize(s) { s = canonical(s); return s ? s.split(/\s+/) : []; }

/* ====================== similitud (fuzzy) ====================== */
function levenshtein(a, b) {
  a = canonical(a); b = canonical(b);
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1}, () => new Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) {
    for (let j=1;j<=n;j++) {
      const cost = a[i-1]===b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function levRatio(a,b) {
  const L = Math.max(canonical(a).length, canonical(b).length) || 1;
  return 1 - (levenshtein(a,b) / L);
}
function tokenOverlap(a,b) {
  const A = new Set(tokenize(a)), B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return inter/union;
}
function similarity(a,b){ return 0.65*tokenOverlap(a,b) + 0.35*levRatio(a,b); }
function bestMatchId(dbRows, query, THRESH=0.68){
  let best = {id:null, name:null, score:-1};
  for (const r of dbRows){
    const s = similarity(query, r.name);
    if (s > best.score) best = {id:r.id, name:r.name, score:s};
  }
  return best;
}

/* ====================== parseo del TXT ====================== */
/*
Formato esperado por línea (como el archivo que compartiste):
  NOMBRE MATERIA → Regularizadas: ... | Final aprobado: ...
Los requisitos están separados por coma. A veces una materia ocupa varias líneas (pegadas).
*/
function parseTXT(txt){
  const MAP = {}; // { materia: { cursada:[], final:[] } }
  const lines = txt.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);

  // Unimos líneas que vienen pegadas sin salto claro (buscamos "→")
  const chunks = [];
  let buf = "";
  for (const line of lines){
    if (line.includes("→")) {
      if (buf) { chunks.push(buf); buf = ""; }
      buf = line;
    } else {
      buf += " " + line; // concatenamos
    }
  }
  if (buf) chunks.push(buf);

  const re = /^(.*?)\s*→\s*Regularizadas:\s*(.*?)\s*\|\s*Final aprobado:\s*(.*)$/i;

  for (const raw of chunks){
    const m = raw.match(re);
    if (!m) continue;
    const materia = norm(m[1]);
    const regStr  = norm(m[2]);
    const finStr  = norm(m[3]);

    const regs = regStr && !/ninguna/i.test(regStr) ? regStr.split(",").map(s=>s.trim()) : [];
    const fins = finStr && !/ninguna/i.test(finStr) ? finStr.split(",").map(s=>s.trim()) : [];

    if (!MAP[materia]) MAP[materia] = { cursada: [], final: [] };
    MAP[materia].cursada.push(...regs);
    MAP[materia].final.push(...fins);
  }

  // limpieza
  for (const k of Object.keys(MAP)){
    const uniq = (arr)=>[...new Set(arr
      .map(v=>v.replace(/\(\s*\d+\s*\)\s*$/g,""))  // quita "(7114)"
      .map(v=>v.replace(/\s+/g," ").trim())
      .filter(Boolean)
    )];
    MAP[k].cursada = uniq(MAP[k].cursada);
    MAP[k].final   = uniq(MAP[k].final);
  }
  return MAP;
}

/* ====================== DB helpers ====================== */
async function ensureTables(){
  await run(`
    CREATE TABLE IF NOT EXISTS correlatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      depends_on_id INTEGER NOT NULL,
      req_type TEXT,
      FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY(depends_on_id) REFERENCES subjects(id) ON DELETE CASCADE
    );
  `);
  try { await run(`ALTER TABLE correlatives ADD COLUMN req_type TEXT`); } catch(_) {}
}
async function getSubjects(){
  return await all(
    `SELECT id, name FROM subjects WHERE career=? AND plan=?`,
    [CAREER, PLAN]
  );
}
async function insertEdge(dstId, srcId, tipo){
  const exists = await all(
    `SELECT id FROM correlatives WHERE subject_id=? AND depends_on_id=? AND req_type=?`,
    [dstId, srcId, tipo]
  );
  if (exists.length) return false;
  await run(
    `INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?, ?, ?)`,
    [dstId, srcId, tipo]
  );
  return true;
}

/* ====================== Reducción transitiva ====================== */
/**
 * Dado MAP con { materia: { cursada:[], final:[] } }, elimina prerequisitos
 * que ya están implícitos a través de otro prerequisito.
 * Se hace por tipo (cursada/final) por claridad.
 */
function transitiveReduce(MAP){
  // Construimos grafos por tipo: edges tipo -> A(dep) -> [materias que dependen de A]
  const G = { cursada: {}, final: {} };
  const depsByType = { cursada: {}, final: {} };

  for (const [dst, reqs] of Object.entries(MAP)){
    for (const t of ["cursada","final"]){
      depsByType[t][dst] = new Set(reqs[t] || []);
      for (const src of reqs[t] || []){
        (G[t][src] ??= new Set()).add(dst);
      }
    }
  }

  // función: ¿y es alcanzable desde x (por el mismo tipo)?
  function reachable(type, start, target, seen=new Set()){
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    for (const nxt of (G[type][start] ? Array.from(G[type][start]) : [])){
      // invertimos para chequear ascendencia: queremos saber si 'target' está EN LA CADENA de requisitos de 'start'
      // Para eso necesitamos grafo de requisitos (dst -> deps). Creamos rápido la vista inversa:
    }
    return false;
  }
  // Mejor: construir grafo de requisitos por tipo: R[type][nodo] = set(deps)
  const R = { cursada: {}, final: {} };
  for (const [dst, reqs] of Object.entries(MAP)){
    for (const t of ["cursada","final"]){
      R[t][dst] = new Set(reqs[t] || []);
    }
  }
  function reachableVia(type, origin, target, seen=new Set()){
    // ¿target es alcanzable desde origin yendo "hacia atrás" por requisitos?
    if (origin === target) return true;
    if (seen.has(origin)) return false;
    seen.add(origin);
    for (const dep of (R[type][origin] ? Array.from(R[type][origin]) : [])){
      if (reachableVia(type, dep, target, seen)) return true;
    }
    return false;
  }

  // Para cada materia y tipo: si un req 'a' es alcanzable desde otro req 'b' de la misma lista, eliminamos 'a'
  for (const [dst, reqs] of Object.entries(MAP)){
    for (const t of ["cursada","final"]){
      const list = Array.from(depsByType[t][dst] || []);
      const toRemove = new Set();
      for (let i=0;i<list.length;i++){
        for (let j=0;j<list.length;j++){
          if (i===j) continue;
          const a = list[i], b = list[j];
          // si a es alcanzable desde b (b -> ... -> a), 'a' es redundante
          if (reachableVia(t, b, a)) toRemove.add(a);
        }
      }
      if (toRemove.size){
        MAP[dst][t] = (MAP[dst][t] || []).filter(x => !toRemove.has(x));
      }
    }
  }
  return MAP;
}

/* ====================== Main ====================== */
async function main(){
  try {
    await ensureTables();

    // Leer TXT
    const txtPath = process.argv[2] || path.join(process.cwd(), "correlativas_plan7_consolidado.txt");
    const raw = fs.readFileSync(txtPath, "utf8");
    let MAP = parseTXT(raw);

    // Reducción transitiva (por tipo)
    MAP = transitiveReduce(MAP);

    // Materias en DB
    const subjects = await getSubjects();
    if (!subjects.length) {
      console.error("⛔ No hay subjects para", CAREER, "Plan", PLAN, "en la base.");
      console.error("   Corré primero el seed de materias del Plan 7.");
      process.exit(1);
    }

    // Matching difuso a IDs
    const cache = new Map(); // nombre -> {id,name,score}
    const resolve = (name, kind) => {
      if (!name) return null;
      if (cache.has(name)) return cache.get(name);
      const best = bestMatchId(subjects, name, 0.68);
      cache.set(name, best);
      if (!best.id) console.warn(`⚠️  Sin match para ${kind}: "${name}"`);
      return best;
    };

    // Insertar correlativas inmediatas
    let inserted = 0, skipped = 0;
    for (const [dstName, reqs] of Object.entries(MAP)){
      const dst = resolve(dstName, "destino");
      if (!dst?.id){ skipped++; continue; }

      for (const t of ["cursada","final"]){
        for (const srcName of (reqs[t]||[])){
          const src = resolve(srcName, t);
          if (!src?.id){ skipped++; continue; }
          const ok = await insertEdge(dst.id, src.id, t);
          if (ok) inserted++;
        }
      }
    }

    console.log(`✅ Listo. Inserciones: ${inserted}. Omitidas: ${skipped}.`);

    // Resumen desde DB
    const resumen = await all(
      `SELECT s.name AS destino, d.name AS requisito, c.req_type
         FROM correlatives c
         JOIN subjects s ON s.id = c.subject_id
         JOIN subjects d ON d.id = c.depends_on_id
        WHERE s.career = ? AND s.plan = ?
        ORDER BY destino, c.req_type, requisito`,
      [CAREER, PLAN]
    );
    console.table(resumen);
    process.exit(0);

  } catch (e) {
    console.error("❌ Error en seed_admin_plan7_from_text_fuzzy_transitive:", e);
    process.exit(1);
  }
}

main();