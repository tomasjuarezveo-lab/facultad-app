// scripts/overwrite_contabilidad_plan7_edges.js
// Sobrescribe correlativas de Contabilidad (Contador Público) - Plan 7
// con mapa robusto y matching tolerante.
// Uso: node scripts/overwrite_contabilidad_plan7_edges.js

const { init, all, run } = require('../models/db');

/* ===== Helpers de normalización y similitud ===== */
function normalize(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita acentos
    .replace(/\s+/g,' ')
    .trim();
}
function withoutParens(s){
  return String(s||'').replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
}
function tokens(s){
  return normalize(withoutParens(s))
    .replace(/[^a-z0-9áéíóúñ\s]/gi,' ')
    .split(' ')
    .filter(Boolean);
}
function lev(a,b){
  const m=a.length,n=b.length;
  const dp=Array.from({length:m+1},()=>Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1]===b[j-1]?0:1;
      dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}
function simRatio(a,b){
  const A=normalize(a), B=normalize(b);
  if (!A || !B) return 0;
  const d=lev(A,B);
  const max=Math.max(A.length,B.length)||1;
  return 1 - d/max;
}
function jaccard(a,b){
  const A=new Set(tokens(a)), B=new Set(tokens(b));
  const inter=[...A].filter(x=>B.has(x)).length;
  const uni=new Set([...A, ...B]).size || 1;
  return inter / uni;
}

/* ===== Alias frecuentes (ajustá si hace falta) ===== */
const ALIAS = new Map([
  ["Interpretación de los Estados Contables", "Interpretación de los Estados Contables (728A)"],
  ["Comportamiento Humano en las Organizaciones", "Comportamiento Humano en las Organizaciones (721A)"],
  ["Administración III (Planeamiento y Control Organizacional)", "Administración III (Planeamiento y Control Organizacional) (731A)"],
  ["Administración Pública", "Administración Pública (732A)"],
  ["Estadística Aplicada", "Estadística Aplicada (7332)"],
  ["Derecho Empresario", "Derecho Empresario (734A)"],
  ["Matemática para Decisiones Empresarias", "Matemática para Decisiones Empresarias (7352)"],
  ["Administración de la Producción", "Administración de la Producción (736A)"],
  ["Diseño de Sistemas de Información", "Diseño de Sistemas de Información (741A)"],
  ["Marketing Estratégico", "Marketing Estratégico (742A)"],
  ["Trabajo y Sociedad", "Trabajo y Sociedad (743A)"],
  ["Finanzas de Empresas", "Finanzas de Empresas (744A)"],
  ["Psicosociología Organizacional", "Psicosociología Organizacional (745A)"],
  ["Costos para la Gestión", "Costos para la Gestión (7462)"],
  ["Gestión y Desarrollo de las personas en la Organizaciones", "Gestión y Desarrollo de las personas en la Organizaciones (751A)"],
  ["Tecnología Informática y Sistemas de Información para la Dirección", "Tecnología Informática y Sistemas de Información para la Dirección (752A)"],
  ["Marketing Táctico y Operativo", "Marketing Táctico y Operativo (753A)"],
  ["Negocios Internacionales", "Negocios Internacionales (754A)"],
  ["Tópicos Avanzados en Finanzas", "Tópicos Avanzados en Finanzas (755A)"],
  ["Dirección General", "Dirección General (756A)"],
]);

/* ===== Mapa del usuario ===== */
const INTRO_ECO = "Introducción a la Economía y Estructura Económica Argentina";
const ADMIN_I   = "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)";
const CONTAB_I  = "Contabilidad I (Bases y Fundamentos)";
const DER_CONST = "Derecho Constitucional y Administrativo";
const MAT_I     = "Matemática I";
const MICRO_I   = "Microeconomía I";
const CONTAB_II = "Contabilidad II (Ajuste y Valuación)";
const MACRO_I   = "Macroeconomía I";
const HIST_ECO1 = "Historia Económica y Social I";
const ADMIN_II  = "Administración II (Técnicas Administrativas y Gestión Organizacional)";
const DER_PRIV  = "Derecho Privado";
const MAT_II    = "Matemática II";
const FIN_PUB   = "Finanzas Públicas";
const CONTAB_III= "Contabilidad III (Estados Contables)";
const INTERP_EE = "Interpretación de los Estados Contables";
const COMPORT   = "Comportamiento Humano en las Organizaciones";
const ADMIN_III = "Administración III (Planeamiento y Control Organizacional)";
const ADMIN_PUB = "Administración Pública";
const EST_APL   = "Estadística Aplicada";
const DER_EMP   = "Derecho Empresario";
const MAT_DEC   = "Matemática para Decisiones Empresarias";
const ADM_PROD  = "Administración de la Producción";
const DSIS      = "Diseño de Sistemas de Información";
const MKT_EST   = "Marketing Estratégico";
const TRAB_SOC  = "Trabajo y Sociedad";
const FIN_EMP   = "Finanzas de Empresas";
const PSICO_ORG = "Psicosociología Organizacional";
const COSTOS    = "Costos para la Gestión";
const GEST_PERS = "Gestión y Desarrollo de las personas en la Organizaciones";
const TISID     = "Tecnología Informática y Sistemas de Información para la Dirección";
const MKT_TAC   = "Marketing Táctico y Operativo";
const NEG_INT   = "Negocios Internacionales";
const TOP_FIN   = "Tópicos Avanzados en Finanzas";
const DIR_GRAL  = "Dirección General";

const MAP = {
  [CONTAB_I]: { cursada: [], final: [] },
  [INTRO_ECO]: { cursada: [], final: [] },
  [ADMIN_I]: { cursada: [], final: [] },

  [MICRO_I]: { cursada: [INTRO_ECO], final: [ADMIN_I, CONTAB_I] },
  [MAT_I]: { cursada: [INTRO_ECO], final: [ADMIN_I, CONTAB_I] },
  [DER_CONST]: { cursada: [CONTAB_I, INTRO_ECO], final: [ADMIN_I] },
  ["Introducción a las Ciencias Sociales y al Conocimiento Científico"]: { cursada: [ADMIN_I, INTRO_ECO], final: [CONTAB_I] },

  [CONTAB_II]: { cursada: [CONTAB_I], final: [ADMIN_I, INTRO_ECO] },
  [MACRO_I]: { cursada: [INTRO_ECO], final: [ADMIN_I, CONTAB_I] },
  [HIST_ECO1]: { cursada: [INTRO_ECO], final: [ADMIN_I, CONTAB_I] },
  [ADMIN_II]: { cursada: [ADMIN_I], final: [CONTAB_I, INTRO_ECO] },
  [DER_PRIV]: { cursada: [DER_CONST], final: [ADMIN_I] },
  [MAT_II]: { cursada: [MAT_I, INTRO_ECO], final: [ADMIN_I, CONTAB_I] },
  [FIN_PUB]: { cursada: [INTRO_ECO, MICRO_I], final: [ADMIN_I, CONTAB_I] },

  [CONTAB_III]: { cursada: [CONTAB_II], final: [ADMIN_I, INTRO_ECO, DER_CONST] },
  [INTERP_EE]: { cursada: [ADMIN_I, INTRO_ECO], final: [CONTAB_I] },
  [COMPORT]: { cursada: [ADMIN_I], final: [CONTAB_I, INTRO_ECO] },
  [ADMIN_III]: {
    cursada: [],
    final: [ADMIN_I, ADMIN_II, DER_CONST, INTERP_EE, "Introducción a las Ciencias Sociales y al Conocimiento Científico", MAT_I, MICRO_I]
  },
  [ADMIN_PUB]: {
    cursada: [],
    final: [ADMIN_I, COMPORT, DER_CONST, "Introducción a las Ciencias Sociales y al Conocimiento Científico", MAT_I, MICRO_I]
  },
  [EST_APL]: {
    cursada: [],
    final: [ADMIN_I, DER_CONST, INTRO_ECO, "Introducción a las Ciencias Sociales y al Conocimiento Científico", MAT_I, MAT_II, MICRO_I]
  },
  [DER_EMP]: {
    cursada: [],
    final: [ADMIN_I, DER_CONST, DER_PRIV, INTRO_ECO, "Introducción a las Ciencias Sociales y al Conocimiento Científico", MAT_I, MICRO_I]
  },
  [MAT_DEC]: {
    cursada: [],
    final: [ADMIN_I, DER_CONST, INTRO_ECO, "Introducción a las Ciencias Sociales y al Conocimiento Científico", MAT_I, MAT_II, MICRO_I]
  },

  [ADM_PROD]: { cursada: [], final: [ADMIN_II, EST_APL] },
  [DSIS]: { cursada: [], final: [ADMIN_III, COMPORT, DER_PRIV, FIN_PUB, HIST_ECO1, MACRO_I, MAT_II] },
  [MKT_EST]: { cursada: [], final: [ADMIN_II, COMPORT, DER_PRIV, EST_APL, FIN_PUB, HIST_ECO1, INTERP_EE, MACRO_I] },
  [TRAB_SOC]: {
    cursada: [],
    final: [ADMIN_II, COMPORT, DER_CONST, DER_PRIV, FIN_PUB, HIST_ECO1, INTERP_EE, "Introducción a las Ciencias Sociales y al Conocimiento Científico", MACRO_I, MAT_I, MAT_II, MICRO_I]
  },
  [FIN_EMP]: { cursada: [], final: [ADMIN_III, COMPORT, DER_PRIV, FIN_PUB, HIST_ECO1, MACRO_I, MAT_DEC] },
  [PSICO_ORG]: {
    cursada: [],
    final: [ADMIN_II, COMPORT, DER_CONST, DER_PRIV, FIN_PUB, HIST_ECO1, INTERP_EE, "Introducción a las Ciencias Sociales y al Conocimiento Científico", MACRO_I, MAT_I, MAT_II, MICRO_I]
  },
  [COSTOS]: { cursada: [], final: [ADM_PROD, COMPORT, DER_PRIV, FIN_PUB, HIST_ECO1, INTERP_EE, MACRO_I] },

  [GEST_PERS]: { cursada: [], final: [ADMIN_III, ADMIN_PUB, ADM_PROD, DER_EMP, MAT_DEC, TRAB_SOC] },
  [TISID]: { cursada: [], final: [ADMIN_PUB, ADM_PROD, DER_EMP, DSIS, MAT_DEC] },
  [MKT_TAC]: { cursada: [], final: [ADMIN_III, ADMIN_PUB, ADM_PROD, DER_EMP, MKT_EST, MAT_DEC] },
  [NEG_INT]: { cursada: [], final: [ADMIN_III, ADMIN_PUB, ADM_PROD, DER_EMP, MKT_EST, MAT_DEC] },
  [TOP_FIN]: { cursada: [], final: [ADMIN_PUB, ADM_PROD, DER_EMP, FIN_EMP] },
  [DIR_GRAL]: { cursada: [], final: [ADMIN_PUB, COSTOS, DER_EMP, FIN_EMP, MKT_EST] },
};

/* ===== main ===== */
(async () => {
  try{
    await init();

    // Tabla edges
    await run(`CREATE TABLE IF NOT EXISTS correlatives_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      depends_on_id INTEGER NOT NULL,
      req_type TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_subject ON correlatives_edges(subject_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_dep ON correlatives_edges(depends_on_id)`);

    const CAREER = 'Contabilidad';
    const PLAN = 7;

    const subjects = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
    if (!subjects.length) throw new Error('No hay subjects para Contabilidad · Plan 7');

    // índices
    const byNorm = new Map();
    const byNormNoPar = new Map();
    const list = [];
    for (const s of subjects){
      byNorm.set(normalize(s.name), s);
      byNormNoPar.set(normalize(withoutParens(s.name)), s);
      list.push(s);
    }

    function tryAlias(name){
      if (ALIAS.has(name)) return ALIAS.get(name);
      return name;
    }

    function bestCandidate(q){
      let best = { s:null, score:-1, j:0, ratio:0 };
      for (const cand of list){
        const r = simRatio(q, cand.name);
        const j = jaccard(q, cand.name);
        const score = 0.6*r + 0.4*j; // mezcla de ratio + jaccard
        if (score > best.score) best = { s:cand, score, j, ratio:r };
      }
      return best;
    }

    function matchOne(name){
      const original = name;
      name = tryAlias(name);

      const k = normalize(name);
      const kp = normalize(withoutParens(name));

      if (byNorm.has(k)) return byNorm.get(k);
      if (byNormNoPar.has(kp)) return byNormNoPar.get(kp);

      // startsWith tolerante
      for (const cand of list){
        const C = normalize(withoutParens(cand.name));
        if (C.startsWith(kp) || kp.startsWith(C)){
          return cand;
        }
      }

      // mejor candidato por similitud combinada
      const best = bestCandidate(name);
      if (best.score >= 0.72 || best.ratio >= 0.78 || best.j >= 0.66) {
        return best.s;
      }
      return null;
    }

    // Validar todo
    const missing = [];
    const debug = [];

    function ensure(name){
      const hit = matchOne(name);
      if (!hit){
        const best = bestCandidate(name);
        debug.push(`  · Para "${name}" mejor candidato: "${best.s?.name||'-'}" (ratio=${best.ratio.toFixed(3)}, jaccard=${best.j.toFixed(3)})`);
      }
      return hit;
    }

    for (const subjectName of Object.keys(MAP)){
      const hit = ensure(subjectName);
      if (!hit) missing.push(subjectName);
      for (const kind of ['cursada','final']){
        for (const dep of (MAP[subjectName][kind] || [])){
          const h2 = ensure(dep);
          if (!h2) missing.push(`${subjectName} → prereq faltante: ${dep}`);
        }
      }
    }

    if (missing.length){
      console.error('❌ No pude matchear los siguientes nombres en subjects Contabilidad/7:');
      for (const m of missing) console.error('  -', m);
      if (debug.length){
        console.error('\nSugerencias (mejor candidato hallado):');
        for (const d of debug) console.error(d);
      }
      throw new Error('Aborto para no dejar la DB a medias. Ajusta nombres o subjects y vuelve a correr.');
    }

    // Borrar scope
    await run(`
      DELETE FROM correlatives_edges
       WHERE subject_id IN (SELECT id FROM subjects WHERE career=? AND plan=?)`,
      [CAREER, PLAN]
    );

    // Insertar
    let ins = 0;
    for (const subjectName of Object.keys(MAP)){
      const subj = matchOne(subjectName);
      const { cursada, final } = MAP[subjectName];

      for (const depName of (cursada||[])){
        const dep = matchOne(depName);
        await run(`INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
          [subj.id, dep.id, 'cursada']);
        ins++;
      }
      for (const depName of (final||[])){
        const dep = matchOne(depName);
        await run(`INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
          [subj.id, dep.id, 'final']);
        ins++;
      }
    }

    const cnt = await all(`
      SELECT COUNT(*) c
        FROM correlatives_edges ce
        JOIN subjects s ON s.id=ce.subject_id
       WHERE s.career=? AND s.plan=?`, [CAREER, PLAN]);

    console.log(`✅ Contabilidad/7 sobrescrito. Edges insertadas=${ins}. Total en scope ahora=${cnt[0].c}`);
    process.exit(0);
  }catch(e){
    console.error('❌ Error overwrite_contabilidad_plan7_edges:', e);
    process.exit(1);
  }
})();