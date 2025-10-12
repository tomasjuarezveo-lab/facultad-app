// scripts/overwrite_admin_plan7_edges.js
// Sobrescribe correlativas de Lic. en Administración de Empresas - Plan 7
// con el mapeo EXACTO que indicó el usuario.
// Uso: node scripts/overwrite_admin_plan7_edges.js

const { init, all, run } = require('../models/db');

/* -------- helpers de normalización + fuzzy -------- */
function normalize(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita acentos
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
      dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
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

/* -------- mapeo declarado por el usuario --------
   Claves = nombre de la materia (Admin/7)
   Valores: { cursada: [...], final: [...] } con nombres de materias prerequisito.
   NOTA: Las tres bases (Contabilidad I, Introducción a la Economía..., Administración I)
         no tienen correlativas (se dejan arrays vacíos).
*/
const MAP = {
  "Contabilidad I (Bases y Fundamentos)": { cursada: [], final: [] },
  "Introducción a la Economía y Estructura Económica Argentina": { cursada: [], final: [] },
  "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)": { cursada: [], final: [] },

  "Microeconomía I": {
    cursada: ["Introducción a la Economía y Estructura Económica Argentina"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Contabilidad I (Bases y Fundamentos)"]
  },
  "Matemática I": {
    cursada: ["Introducción a la Economía y Estructura Económica Argentina"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Contabilidad I (Bases y Fundamentos)"]
  },
  "Derecho Constitucional y Administrativo": {
    cursada: ["Contabilidad I (Bases y Fundamentos)", "Introducción a la Economía y Estructura Económica Argentina"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)"]
  },
  "Introducción a las Ciencias Sociales y al Conocimiento Científico": {
    cursada: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Introducción a la Economía y Estructura Económica Argentina"],
    final: ["Contabilidad I (Bases y Fundamentos)"]
  },
  "Comportamiento Humano en las Organizaciones": {
    cursada: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)"],
    final: ["Contabilidad I (Bases y Fundamentos)", "Introducción a la Economía y Estructura Económica Argentina"]
  },
  "Macroeconomía I": {
    cursada: ["Introducción a la Economía y Estructura Económica Argentina"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Contabilidad I (Bases y Fundamentos)"]
  },
  "Historia Económica y Social I": {
    cursada: ["Introducción a la Economía y Estructura Económica Argentina"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Contabilidad I (Bases y Fundamentos)"]
  },
  "Administración II (Técnicas Administrativas y Gestión Organizacional)": {
    cursada: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)"],
    final: ["Contabilidad I (Bases y Fundamentos)", "Introducción a la Economía y Estructura Económica Argentina"]
  },
  "Derecho Privado": {
    cursada: ["Derecho Constitucional y Administrativo"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)"]
  },
  "Finanzas Públicas": {
    cursada: ["Introducción a la Economía y Estructura Económica Argentina", "Microeconomía I"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Contabilidad I (Bases y Fundamentos)"]
  },
  "Matemática II": {
    cursada: ["Introducción a la Economía y Estructura Económica Argentina", "Matemática I"],
    final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Contabilidad I (Bases y Fundamentos)"]
  },
  "Interpretación de los Estados Contables": {
    cursada: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones)", "Introducción a la Economía y Estructura Económica Argentina"],
    final: ["Contabilidad I (Bases y Fundamentos)"]
  },
  "Administración III (Planeamiento y Control Organizacional)": {
    cursada: [],
    final: [
      "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)",
      "Administración II (Técnicas Administrativas y Gestión Organizacional)",
      "Derecho Constitucional y Administrativo",
      "Interpretación de los Estados Contables",
      "Introducción a las Ciencias Sociales y al Conocimiento Científico",
      "Matemática I",
      "Microeconomía I"
    ]
  },
  "Administración Pública": {
    cursada: [],
    final: [
      "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)",
      "Comportamiento Humano en las Organizaciones",
      "Derecho Constitucional y Administrativo",
      "Introducción a las Ciencias Sociales y al Conocimiento Científico",
      "Matemática I",
      "Microeconomía I"
    ]
  },
  "Estadística Aplicada": {
    cursada: [],
    final: [
      "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)",
      "Derecho Constitucional y Administrativo",
      "Introducción a la Economía y Estructura Económica Argentina",
      "Introducción a las Ciencias Sociales y al Conocimiento Científico",
      "Matemática I",
      "Matemática II",
      "Microeconomía I"
    ]
  },
  "Derecho Empresario": {
    cursada: [],
    final: [
      "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)",
      "Derecho Constitucional y Administrativo",
      "Derecho Privado",
      "Introducción a la Economía y Estructura Económica Argentina",
      "Introducción a las Ciencias Sociales y al Conocimiento Científico",
      "Matemática I",
      "Microeconomía I"
    ]
  },
  "Matemática para Decisiones Empresarias": {
    cursada: [],
    final: [
      "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)",
      "Derecho Constitucional y Administrativo",
      "Introducción a la Economía y Estructura Económica Argentina",
      "Introducción a las Ciencias Sociales y al Conocimiento Científico",
      "Matemática I",
      "Matemática II",
      "Microeconomía I"
    ]
  },
  "Administración de la Producción": {
    cursada: [],
    final: [
      "Administración II (Técnicas Administrativas y Gestión Organizacional)",
      "Estadística Aplicada"
    ]
  },
  "Diseño de Sistemas de Información": {
    cursada: [],
    final: [
      "Administración III (Planeamiento y Control Organizacional)",
      "Comportamiento Humano en las Organizaciones",
      "Derecho Privado",
      "Finanzas Públicas",
      "Historia Económica y Social I",
      "Macroeconomía I",
      "Matemática II"
    ]
  },
  "Marketing Estratégico": {
    cursada: [],
    final: [
      "Administración II (Técnicas Administrativas y Gestión Organizacional)",
      "Comportamiento Humano en las Organizaciones",
      "Derecho Privado",
      "Estadística Aplicada",
      "Finanzas Públicas",
      "Historia Económica y Social I",
      "Interpretación de los Estados Contables",
      "Macroeconomía I"
    ]
  },
  "Trabajo y Sociedad": {
    cursada: [],
    final: [
      "Administración II (Técnicas Administrativas y Gestión Organizacional)",
      "Comportamiento Humano en las Organizaciones",
      "Derecho Constitucional y Administrativo",
      "Derecho Privado",
      "Finanzas Públicas",
      "Historia Económica y Social I",
      "Interpretación de los Estados Contables",
      "Introducción a las Ciencias Sociales y al Conocimiento Científico",
      "Macroeconomía I",
      "Matemática I",
      "Matemática II",
      "Microeconomía I"
    ]
  },
  "Finanzas de Empresas": {
    cursada: [],
    final: [
      "Administración III (Planeamiento y Control Organizacional)",
      "Comportamiento Humano en las Organizaciones",
      "Derecho Privado",
      "Finanzas Públicas",
      "Historia Económica y Social I",
      "Macroeconomía I",
      "Matemática para Decisiones Empresarias"
    ]
  },
  "Psicosociología Organizacional": {
    cursada: [],
    final: [
      "Administración II (Técnicas Administrativas y Gestión Organizacional)",
      "Comportamiento Humano en las Organizaciones",
      "Derecho Constitucional y Administrativo",
      "Derecho Privado",
      "Finanzas Públicas",
      "Historia Económica y Social I",
      "Interpretación de los Estados Contables",
      "Introducción a las Ciencias Sociales y al Conocimiento Científico",
      "Macroeconomía I",
      "Matemática I",
      "Matemática II",
      "Microeconomía I"
    ]
  },
  "Costos para la Gestión": {
    cursada: [],
    final: [
      "Administración de la Producción",
      "Comportamiento Humano en las Organizaciones",
      "Derecho Privado",
      "Finanzas Públicas",
      "Historia Económica y Social I",
      "Interpretación de los Estados Contables",
      "Macroeconomía I"
    ]
  },
  "Gestión y Desarrollo de las personas en la Organizaciones": {
    cursada: [],
    final: [
      "Administración III (Planeamiento y Control Organizacional)",
      "Administración Pública",
      "Administración de la Producción",
      "Derecho Empresario",
      "Matemática para Decisiones Empresarias",
      "Trabajo y Sociedad"
    ]
  },
  "Tecnología Informática y Sistemas de Información para la Dirección": {
    cursada: [],
    final: [
      "Administración Pública",
      "Administración de la Producción",
      "Derecho Empresario",
      "Diseño de Sistemas de Información",
      "Matemática para Decisiones Empresarias"
    ]
  },
  "Marketing Táctico y Operativo": {
    cursada: [],
    final: [
      "Administración III (Planeamiento y Control Organizacional)",
      "Administración Pública",
      "Administración de la Producción",
      "Derecho Empresario",
      "Marketing Estratégico",
      "Matemática para Decisiones Empresarias"
    ]
  },
  "Negocios Internacionales": {
    cursada: [],
    final: [
      "Administración III (Planeamiento y Control Organizacional)",
      "Administración Pública",
      "Administración de la Producción",
      "Derecho Empresario",
      "Marketing Estratégico",
      "Matemática para Decisiones Empresarias"
    ]
  },
  "Tópicos Avanzados en Finanzas": {
    cursada: [],
    final: [
      "Administración Pública",
      "Administración de la Producción",
      "Derecho Empresario",
      "Finanzas de Empresas"
    ]
  },
  "Dirección General": {
    cursada: [],
    final: [
      "Administración Pública",
      "Costos para la Gestión",
      "Derecho Empresario",
      "Finanzas de Empresas",
      "Marketing Estratégico"
    ]
  }
};

/* -------- main -------- */
(async () => {
  try{
    await init();

    // Asegurar tabla de edges
    await run(`CREATE TABLE IF NOT EXISTS correlatives_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      depends_on_id INTEGER NOT NULL,
      req_type TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_subject ON correlatives_edges(subject_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_dep ON correlatives_edges(depends_on_id)`);

    const CAREER = 'Lic. en Administración de Empresas';
    const PLAN = 7;

    // Cargar subjects del scope
    const subjects = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);
    if (!subjects.length) {
      throw new Error('No hay subjects para Lic. en Administración de Empresas · Plan 7');
    }

    // Índices para matching robusto
    const byNorm = new Map();
    const byNormNoPar = new Map();
    const list = [];
    for (const s of subjects){
      byNorm.set(normalize(s.name), s);
      byNormNoPar.set(normalize(withoutParens(s.name)), s);
      list.push(s);
    }
    function matchOne(name){
      const k = normalize(name);
      const kp = normalize(withoutParens(name));
      if (byNorm.has(k)) return byNorm.get(k);
      if (byNormNoPar.has(kp)) return byNormNoPar.get(kp);
      let best=null, score=0;
      for (const cand of list){
        const sc = sim(name, cand.name);
        if (sc>score){ score=sc; best=cand; }
      }
      return score>=0.85 ? best : null; // umbral exigente
    }

    // Validar que todas las materias del MAP existan en el scope
    const missingSubjects = [];
    for (const subjectName of Object.keys(MAP)){
      const hit = matchOne(subjectName);
      if (!hit) missingSubjects.push(subjectName);
      // además validar todos sus prerequisitos
      for (const arrName of ['cursada','final']){
        for (const dep of (MAP[subjectName][arrName] || [])){
          const h2 = matchOne(dep);
          if (!h2) missingSubjects.push(`${subjectName} → prereq faltante: ${dep}`);
        }
      }
    }
    if (missingSubjects.length){
      console.error('❌ No pude matchear los siguientes nombres en subjects Admin/7:');
      for (const m of missingSubjects) console.error('  -', m);
      throw new Error('Aborto para no dejar la DB a medias. Ajusta nombres o subjects y vuelve a correr.');
    }

    // Borrar edges previas del scope
    await run(`
      DELETE FROM correlatives_edges
       WHERE subject_id IN (SELECT id FROM subjects WHERE career=? AND plan=?)`,
      [CAREER, PLAN]
    );

    // Insertar edges nuevas
    let ins = 0;
    for (const subjectName of Object.keys(MAP)){
      const subj = matchOne(subjectName);
      const { cursada, final } = MAP[subjectName];

      for (const depName of cursada || []){
        const dep = matchOne(depName);
        await run(
          `INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
          [subj.id, dep.id, 'cursada']
        );
        ins++;
      }
      for (const depName of final || []){
        const dep = matchOne(depName);
        await run(
          `INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
          [subj.id, dep.id, 'final']
        );
        ins++;
      }
    }

    const cnt = await all(`
      SELECT COUNT(*) c
        FROM correlatives_edges ce
        JOIN subjects s ON s.id=ce.subject_id
       WHERE s.career=? AND s.plan=?`, [CAREER, PLAN]);

    console.log(`✅ Admin/7 sobrescrito. Edges insertadas=${ins}. Total en scope ahora=${cnt[0].c}`);
    process.exit(0);
  }catch(e){
    console.error('❌ Error overwrite_admin_plan7_edges:', e);
    process.exit(1);
  }
})();