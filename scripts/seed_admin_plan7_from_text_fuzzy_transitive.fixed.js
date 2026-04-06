// scripts/seed_admin_plan7_from_text_fuzzy_transitive.fixed.js
// Carga correlativas (LEGACY: subject_id/depends_on_id) para Lic. en Administración Plan 7 desde el TXT consolidado.
// Uso:
//   node scripts/seed_admin_plan7_from_text_fuzzy_transitive.fixed.js .\scripts\materias_unificadas_sin_duplicados_DEFINITIVO.txt

const fs = require("fs");
const path = require("path");
const { run, all } = require("../models/db");

const CAREER = "Lic. en Administración de Empresas";
const PLAN = 7;

function normalize(s){
  return String(s||"").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\([^)]*\)/g," ")        // quitar paréntesis con códigos
    .replace(/[^a-z0-9\s]/g," ")
    .replace(/\s+/g," ")
    .trim();
}

function levenshtein(a,b){
  const m=a.length,n=b.length;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for(let i=0;i<=m;i++) dp[i][0]=i;
  for(let j=0;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function ratio(a,b){
  const A=normalize(a), B=normalize(b);
  if(!A||!B) return 0;
  const dist=levenshtein(A,B);
  const maxlen=Math.max(A.length,B.length)||1;
  return 1 - dist/maxlen;
}

function parseTxt(filePath){
  const raw = fs.readFileSync(filePath,"utf-8");
  const blocks = raw.split(/\n\s*\n/);
  const out=[];
  for(const blk of blocks){
    const lines = blk.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if(!lines.length) continue;
    const title = lines[0];
    let regs="", fins="";
    for(const ln of lines.slice(1)){
      const m1=ln.match(/^Regularizadas:\s*(.*)$/i);
      const m2=ln.match(/^Final aprobado:\s*(.*)$/i);
      if(m1){ regs=m1[1].trim(); continue; }
      if(m2){ fins=m2[1].trim(); continue; }
    }
    const regList = regs && !/^Ninguna$/i.test(regs) ? regs.split(/\s*,\s*/) : [];
    const finList = fins && !/^Ninguna$/i.test(fins) ? fins.split(/\s*,\s*/) : [];
    out.push({ name:title, regularizadas:regList, finales:finList });
  }
  return out;
}

async function fetchSubjects(){
  return await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
}

function findBest(name, list){
  const THRESH=0.74;
  let best=null, bestScore=0;
  for(const row of list){
    const sc=ratio(name,row.name);
    if(sc>bestScore){ best=row; bestScore=sc; }
  }
  return bestScore>=THRESH ? best : null;
}

function reduceTransitive(edges){
  const childrenOf = new Map();
  for(const e of edges){
    if(!childrenOf.has(e.depId)) childrenOf.set(e.depId, new Set());
    childrenOf.get(e.depId).add(e.srcId);
  }
  const redundant = new Set();
  function dfs(start, target){
    const kids = childrenOf.get(start);
    if(!kids) return;
    for(const k of kids){
      const key = `${target}->${k}`;
      if(redundant.has(key)) continue;
      redundant.add(key);
      dfs(k, target);
    }
  }
  for(const e of edges) dfs(e.depId, e.srcId);
  return edges.filter(e => !redundant.has(`${e.depId}->${e.srcId}`));
}

(async () => {
  try{
    const inPath = process.argv[2] || path.join(__dirname, "materias_unificadas_sin_duplicados_DEFINITIVO.txt");
    if(!fs.existsSync(inPath)){
      console.error("No se encontró el archivo de entrada:", inPath);
      process.exit(1);
    }

    const subjects = await fetchSubjects();
    if(!subjects.length){
      console.error("No hay subjects cargados para", CAREER, "Plan", PLAN, "— primero corré el seed de subjects.");
      process.exit(1);
    }

    const parsed = parseTxt(inPath);
    const edges=[];
    for(const entry of parsed){
      const src = findBest(entry.name, subjects);
      if(!src){ console.warn("⚠️ Materia no encontrada (omito):", entry.name); continue; }
      for(const r of entry.regularizadas){
        const dep = findBest(r, subjects);
        if(!dep){ console.warn("⚠️ Regularizada no encontrada:", r, "→", entry.name); continue; }
        edges.push({ srcId:src.id, depId:dep.id, type:"cursada" });
      }
      for(const f of entry.finales){
        const dep = findBest(f, subjects);
        if(!dep){ console.warn("⚠️ Final no encontrado:", f, "→", entry.name); continue; }
        edges.push({ srcId:src.id, depId:dep.id, type:"final" });
      }
    }

    const reduced = reduceTransitive(edges);

    // ✅ DELETE correcto (sin corrupción)
    await run(`DELETE FROM correlatives WHERE subject_id IN (SELECT id FROM subjects WHERE career=? AND plan=?)`, [CAREER, PLAN]);
    for(const e of reduced){
      await run(`INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?,?,?)`, [e.srcId, e.depId, e.type]);
    }

    const resumen = await all(`
      SELECT s.name AS destino, d.name AS requisito, COALESCE(c.req_type,'cursada') AS tipo
      FROM correlatives c
      JOIN subjects s ON s.id = c.subject_id
      JOIN subjects d ON d.id = c.depends_on_id
      WHERE s.career=? AND s.plan=?
      ORDER BY destino, tipo, requisito
    `, [CAREER, PLAN]);

    console.log("✅ Correlativas actualizadas para", CAREER, "Plan", PLAN, "— total aristas:", resumen.length);
    console.table(resumen.slice(0, 20));
    process.exit(0);
  }catch(e){
    console.error("❌ Error al actualizar correlativas:", e);
    process.exit(1);
  }
})();
