// routes/correlativas.js (definitivo - compatible con vista correlativas.ejs)
const express = require('express');
const router = express.Router();
const { all } = require('../models/db');

/* ========== Helpers ========== */
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

function pickCareerPlan(req){
  const qCareer = (req.query.career || '').trim();
  const qPlan   = parseInt(req.query.plan || '', 10);
  const userCareer = (req.user && req.user.career) || '';
  const userPlan   = (req.user && req.user.plan);
  const career = qCareer || userCareer;
  const plan   = Number.isFinite(qPlan) ? qPlan : (Number.isFinite(userPlan) ? userPlan : 7);
  return { career, plan };
}

/* ========== DB ========== */
async function fetchNodes(career, plan){
  return await all(
    `SELECT id, name, COALESCE(year,0) AS year
       FROM subjects
      WHERE career=? AND plan=?
      ORDER BY COALESCE(year,0), name`,
    [career, plan]
  );
}
async function hasEdgesTable(){
  const info = await all(`PRAGMA table_info(correlatives_edges)`);
  return Array.isArray(info) && info.length>0;
}
async function fetchEdgesFromTable(career, plan){
  return await all(
    `SELECT ce.subject_id, ce.depends_on_id, COALESCE(ce.req_type,'cursada') AS req_type
       FROM correlatives_edges ce
       JOIN subjects s ON s.id=ce.subject_id
      WHERE s.career=? AND s.plan=?`,
    [career, plan]
  );
}

/**
 * Devuelve filas normalizadas para construir edges desde la tabla de correlativas.
 * - Esquema NUEVO (c.subject_id + strings): hace JOIN con subjects y expande a 2 filas por materia
 *   con {subject_name, rule_type, requires_json}
 * - Fallback: esquema VIEJO (subject_name, requires_json, rule_type, rule_value)
 */
async function fetchRowsJSON(career, plan){
  // 1) Intentar esquema NUEVO (JOIN correlatives + subjects)
  try{
    const rowsV2 = await all(
      `SELECT s.name AS subject_name,
              s.career AS career,
              s.plan   AS plan,
              c.regularizada,
              c.final_aprobado
         FROM correlatives c
         JOIN subjects s ON s.id = c.subject_id
        WHERE LOWER(s.career) = LOWER(?)
          AND CAST(s.plan AS TEXT) = ?`,
      [ career, String(plan) ]
    );

    // Expandir a "reglas" (regularizada / final_aprobado)
    const out = [];
    const toCSVArray = (s) =>
      String(s || '')
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);

    for (const r of rowsV2){
      out.push({
        subject_name: r.subject_name,
        rule_type: 'regularizada',
        requires_json: JSON.stringify(toCSVArray(r.regularizada)),
        rule_value: null
      });
      out.push({
        subject_name: r.subject_name,
        rule_type: 'final_aprobado',
        requires_json: JSON.stringify(toCSVArray(r.final_aprobado)),
        rule_value: null
      });
    }
    return out;
  }catch(e){
    // si falla (tabla/columnas viejas), caemos al esquema anterior
  }

  // 2) Fallback: esquema VIEJO
  return await all(
    `SELECT subject_name, requires_json, rule_type, rule_value
       FROM correlatives
      WHERE career=? AND plan=?`,
    [career, plan]
  );
}

/* ========== JSON → edges con mapeo robusto por NOMBRE ========== */
function buildIndex(nodes){
  const byName = new Map();
  const byNameNoPar = new Map();
  const list = [];
  for (const n of nodes){
    byName.set(normalize(n.name), n.id);
    byNameNoPar.set(normalize(withoutParens(n.name)), n.id);
    list.push({ id:n.id, name:n.name });
  }
  return { byName, byNameNoPar, list };
}
function matchId(name, idx){
  if (!name) return null;
  const k = normalize(name);
  const kp = normalize(withoutParens(name));
  if (idx.byName.has(k)) return idx.byName.get(k);
  if (idx.byNameNoPar.has(kp)) return idx.byNameNoPar.get(kp);
  // fuzzy
  let bestId=null, best=0;
  for (const cand of idx.list){
    const s = sim(name, cand.name);
    if (s>best){ best=s; bestId=cand.id; }
  }
  return best>=0.80 ? bestId : null;
}
function edgesFromJSON(rows, nodes){
  const idx = buildIndex(nodes);
  const edges = [];
  let missSubjects=0, missReqs=0;

  for (const r of rows){
    const sid = matchId(r.subject_name, idx);
    if (!sid){ missSubjects++; continue; }

    let reqs=[];
    try{ reqs = JSON.parse(r.requires_json || '[]'); }catch{ reqs=[]; }

    const isFinal = typeof r.rule_type === 'string' && /final/i.test(r.rule_type);

    for (const it of reqs){
      const did = matchId(String(it), idx);
      if (did) edges.push({ subject_id:sid, depends_on_id:did, req_type: isFinal ? 'final' : 'cursada' });
      else missReqs++;
    }
  }
  return { edges, missSubjects, missReqs };
}

/* ========== Build payload que la VISTA espera ========== */
async function buildMaterias(career, plan){
  const nodes = await fetchNodes(career, plan);
  let edges = [];
  // Preferimos tabla materializada si existe y tiene filas; si no, caemos a JSON robusto
  if (await hasEdgesTable()){
    edges = await fetchEdgesFromTable(career, plan);
  }
  if (!edges.length){
    const rows = await fetchRowsJSON(career, plan);
    const r = edgesFromJSON(rows, nodes);
    edges = r.edges;
    console.log(`[correlativas] (fallback JSON) career=${career} plan=${plan} · nodes=${nodes.length} · edges=${edges.length} · missSubjects=${r.missSubjects} · missReqs=${r.missReqs}`);
  } else {
    console.log(`[correlativas] (edges) career=${career} plan=${plan} · nodes=${nodes.length} · edges=${edges.length}`);
  }

  // Mapear edges a requisitos por materia en el formato que usa correlativas.ejs
  const reqMap = new Map(); // id -> [{id, tipo}]
  for (const e of edges){
    const arr = reqMap.get(e.subject_id) || [];
    arr.push({ id: String(e.depends_on_id), tipo: (e.req_type==='final'?'final':'cursada') });
    reqMap.set(e.subject_id, arr);
  }

  // Armar materias con propiedades EXACTAS que la vista consume: id, nombre, year, requisitos
  const materias = nodes.map(n => ({
    id: String(n.id),
    nombre: n.name,       // la vista usa m.nombre || m.name
    name: n.name,
    year: n.year || 0,
    requisitos: reqMap.get(n.id) || []   // array de {id, tipo} o []
  }));

  return materias;
}

/* ========== Handler ========== */
async function handler(req, res){
  try{
    const { career, plan } = (function(){
      const qCareer = (req.query.career || '').trim();
      const qPlan   = parseInt(req.query.plan || '', 10);
      const userCareer = (req.user && req.user.career) || '';
      const userPlan   = (req.user && req.user.plan);
      const career = qCareer || userCareer;
      const plan   = Number.isFinite(qPlan) ? qPlan : (Number.isFinite(userPlan) ? userPlan : 7);
      return { career, plan };
    })();
    const materias = await buildMaterias(career, plan);
    const isAdminPlan7 = (career === 'Lic. en Administración de Empresas' && Number(plan) === 7);
    res.render('correlativas', { title:'Correlativas', materias, isAdminPlan7 });
  }catch(e){
    console.error('GET /app/correlativas error:', e);
    res.status(500).send('Error al construir correlativas: ' + e.message);
  }
}

// ======= META públicas para UI (careers/plans) =======
router.get('/meta/careers', async (req, res) => {
  try{
    const rows = await all(
      `SELECT DISTINCT career FROM subjects WHERE TRIM(career)<>'' ORDER BY career`
    );
    res.json({ ok:true, careers: rows.map(r => r.career) });
  }catch(e){
    res.status(500).json({ ok:false, error:'No se pudieron listar carreras' });
  }
});

router.get('/meta/plans', async (req, res) => {
  try{
    const career = String(req.query.career || '').trim();
    if (!career) return res.status(400).json({ ok:false, error:'career requerido' });
    const rows = await all(
      `SELECT DISTINCT plan FROM subjects WHERE LOWER(career)=LOWER(?) ORDER BY plan`,
      [career]
    );
    res.json({ ok:true, plans: rows.map(r => Number(r.plan)) });
  }catch(e){
    res.status(500).json({ ok:false, error:'No se pudieron listar planes' });
  }
});

router.get('/correlativas', handler);
router.get('/', handler);

module.exports = router;