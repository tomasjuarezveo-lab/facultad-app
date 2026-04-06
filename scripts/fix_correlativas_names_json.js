// scripts/fix_correlativas_names_json.js
// Normaliza subject_name y cada entrada de requires_json para que coincidan EXACTO con subjects.name
// Uso:
//  node scripts/fix_correlativas_names_json.js --career="Lic. en Administración de Empresas" --plan=7
//  node scripts/fix_correlativas_names_json.js --career="Contabilidad" --plan=7

const { init, all, run } = require('../models/db');

function normalize(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,' ')
    .trim();
}

// Levenshtein básico
function lev(a,b){
  const m=a.length,n=b.length;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1] ? 0 : 1;
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

async function main(){
  const args = process.argv.slice(2).join(' ');
  const mCareer = args.match(/--career="([^"]+)"/);
  const mPlan   = args.match(/--plan=(\d+)/);
  const CAREER = mCareer ? mCareer[1] : 'Lic. en Administración de Empresas';
  const PLAN   = mPlan ? parseInt(mPlan[1],10) : 7;

  await init();

  // Subjects del scope
  const subjects = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
  if (!subjects.length){
    console.error('No hay subjects para', CAREER, 'Plan', PLAN, '— corré primero el seed de subjects.');
    process.exit(1);
  }

  const byNorm = new Map(subjects.map(s => [normalize(s.name), s.name]));
  const names  = subjects.map(s => s.name);

  const rows = await all(
    `SELECT id, subject_name, requires_json
       FROM correlatives
      WHERE career=? AND plan=?`,
    [CAREER, PLAN]
  );

  let updated=0, removed=0;

  // Matchear a nombre exacto de subjects, primero exacto por normalize, luego fuzzy
  function matchName(x){
    const key = normalize(x);
    if (byNorm.has(key)) return byNorm.get(key);
    // fuzzy
    let best=null, bestScore=0;
    for (const cand of names){
      const sc = sim(x, cand);
      if (sc > bestScore){ bestScore = sc; best = cand; }
    }
    return bestScore >= 0.78 ? best : null;  // umbral prudente
  }

  for (const r of rows){
    const newSubject = matchName(r.subject_name);
    if (!newSubject){
      await run(`DELETE FROM correlatives WHERE id=?`, [r.id]); // fila inválida para el scope
      removed++;
      continue;
    }

    let reqs=[];
    try{ reqs = JSON.parse(r.requires_json || '[]'); }catch{ reqs=[]; }
    const fixedReqs = [];
    for (const it of reqs){
      const hit = matchName(String(it));
      if (hit) fixedReqs.push(hit);
    }
    const uniqueReqs = Array.from(new Set(fixedReqs));

    await run(
      `UPDATE correlatives SET subject_name=?, requires_json=?, rule_type='list' WHERE id=?`,
      [newSubject, JSON.stringify(uniqueReqs), r.id]
    );
    updated++;
  }

  console.log('OK - FIX nombres', CAREER, 'Plan', PLAN, '| actualizadas:', updated, '| eliminadas (sin subject en scope):', removed);

  const cnt = await all(`SELECT COUNT(*) c FROM correlatives WHERE career=? AND plan=?`, [CAREER, PLAN]);
  console.log('Total correlativas en scope tras FIX:', cnt[0].c);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });