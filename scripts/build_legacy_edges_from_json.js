// scripts/build_legacy_edges_from_json.js
// Construye una tabla robusta correlatives_edges(subject_id, depends_on_id, req_type)
// a partir de las correlativas JSON (career/plan/subject_name/requires_json),
// mapeando nombres -> subjects.id con heurísticas (exacta, sin paréntesis, fuzzy).

const { init, all, run } = require('../models/db');

function normalize(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}
function withoutParens(s){
  return String(s||'').replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
}
function lev(a,b){
  const m=a.length,n=b.length;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1]?0:1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function sim(a,b){
  const A=normalize(a), B=normalize(b);
  if (!A || !B) return 0;
  const d=lev(A,B);
  const max=Math.max(A.length,B.length)||1;
  return 1 - d/max;
}

function buildIndex(subjects){
  const byName = new Map();       // normalize(name) -> id
  const byNameNoPar = new Map();  // normalize(withoutParens(name)) -> id
  const names = [];               // [{id,name}]
  for (const s of subjects){
    byName.set(normalize(s.name), s.id);
    byNameNoPar.set(normalize(withoutParens(s.name)), s.id);
    names.push({ id:s.id, name:s.name });
  }
  return { byName, byNameNoPar, names };
}

function matchId(s, index){
  if (!s) return null;
  const key = normalize(s);
  const keyNp = normalize(withoutParens(s));
  if (index.byName.has(key)) return index.byName.get(key);
  if (index.byNameNoPar.has(keyNp)) return index.byNameNoPar.get(keyNp);
  // fuzzy (umbral)
  let bestId=null, best=0;
  for (const cand of index.names){
    const score = sim(s, cand.name);
    if (score>best){ best=score; bestId=cand.id; }
  }
  return best >= 0.80 ? bestId : null;
}

async function buildForScope(career, plan){
  const subjects = await all(`SELECT id,name FROM subjects WHERE career=? AND plan=?`, [career, plan]);
  if (!subjects.length) return { edges:[], missSubjects:0, missReqs:0 };
  const idx = buildIndex(subjects);

  const rows = await all(
    `SELECT subject_name, requires_json
       FROM correlatives
      WHERE career=? AND plan=?`,
    [career, plan]
  );
  let missSubjects=0, missReqs=0;
  const edges=[];

  for (const r of rows){
    const sid = matchId(r.subject_name, idx);
    if (!sid){ missSubjects++; continue; }
    let reqs=[];
    try{ reqs = JSON.parse(r.requires_json || '[]'); }catch{ reqs=[]; }
    for (const it of reqs){
      const did = matchId(String(it), idx);
      if (did) edges.push({ subject_id:sid, depends_on_id:did, req_type:'cursada' });
      else missReqs++;
    }
  }

  return { edges, missSubjects, missReqs };
}

(async () => {
  try{
    await init();
    // 1) Crear tabla edges (si no existe)
    await run(`CREATE TABLE IF NOT EXISTS correlatives_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      depends_on_id INTEGER NOT NULL,
      req_type TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_subject ON correlatives_edges(subject_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_dep ON correlatives_edges(depends_on_id)`);

    // 2) Descubrir pares career/plan disponibles en JSON
    const scopes = await all(`
      SELECT career, plan, COUNT(*) c
        FROM correlatives
       GROUP BY career, plan
       ORDER BY career, plan
    `);

    let totalInserted=0, totalMissSub=0, totalMissReq=0;
    for (const sc of scopes){
      const career = sc.career;
      const plan   = sc.plan;
      console.log(`\n>> Procesando scope: ${career} - Plan ${plan}`);
      const { edges, missSubjects, missReqs } = await buildForScope(career, plan);
      console.log(`   Encontradas ${edges.length} aristas; missSubjects=${missSubjects}, missReqs=${missReqs}`);

      // 3) Limpiar edges previas del scope
      await run(`
        DELETE FROM correlatives_edges
         WHERE subject_id IN (SELECT id FROM subjects WHERE career=? AND plan=?)
      `, [career, plan]);

      // 4) Insertar
      for (const e of edges){
        await run(
          `INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
          [e.subject_id, e.depends_on_id, e.req_type]
        );
      }
      totalInserted += edges.length;
      totalMissSub  += missSubjects;
      totalMissReq  += missReqs;

      // 5) Resumen del scope
      const cnt = await all(`
        SELECT COUNT(*) c
          FROM correlatives_edges ce
          JOIN subjects s ON s.id=ce.subject_id
         WHERE s.career=? AND s.plan=?`, [career, plan]);
      console.log(`   Edges materializadas en DB para scope: ${cnt[0].c}`);
    }

    console.log(`\n✅ Materialización completa. Insertadas=${totalInserted} · missSubjects=${totalMissSub} · missReqs=${totalMissReq}`);
    process.exit(0);
  }catch(e){
    console.error('❌ Error en build_legacy_edges_from_json:', e);
    process.exit(1);
  }
})();