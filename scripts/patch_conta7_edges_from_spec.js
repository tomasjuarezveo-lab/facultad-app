// scripts/patch_conta7_edges_from_spec.js
// Aplica (sobrescribe) correlativas de Contabilidad · Plan 7 a partir de un SPEC fijo del usuario.
// Inserta SOLO lo que matchea en subjects Contabilidad/7, y reporta omitidos.
// Uso: node scripts/patch_conta7_edges_from_spec.js

const { init, all, run } = require('../models/db');

/* ===== Helpers ===== */
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

/* ===== Alias mínimos seguros (no forzamos materias inexistentes) =====
   Ajustá o ampliá libremente si querés mapear nombres a los de tu subjects real. */
const ALIAS = new Map([
  // Interpretación → nombre real en Contabilidad
  ["Interpretación de los Estados Contables", "Análisis e Interpretación de Estados Contables"],
  ["Interpretación de los Estados Contables (728A)", "Análisis e Interpretación de Estados Contables"],
  // Producción
  ["Administración de la Producción", "Producción"],
  ["Administración de la Producción (736A)", "Producción"],
  // Códigos del ciclo básico
  ["Contabilidad I (Bases y Fundamentos) (7114)", "Contabilidad I (Bases y Fundamentos)"],
  ["Introducción a la Economía y Estructura Económica Argentina (7124)", "Introducción a la Economía y Estructura Económica Argentina"],
  ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones) (7134)",
   "Administración I (Introducción a la Administración y al Estudio de las Organizaciones)"],
  ["Microeconomía I (7144)", "Microeconomía I"],
  ["Matemática I (7154)", "Matemática I"],
  ["Derecho Constitucional y Administrativo (7164)", "Derecho Constitucional y Administrativo"],
  ["Introducción a las Ciencias Sociales y al Conocimiento Científico (7174)",
   "Introducción a las Ciencias Sociales y al Conocimiento Científico"],
  ["Macroeconomía I (7224)", "Macroeconomía I"],
  ["Historia Económica y Social I (7234)", "Historia Económica y Social I"],
  ["Administración II (Técnicas Administrativas y Gestión Organizacional) (7243)",
   "Administración II (Técnicas Administrativas y Gestión Organizacional)"],
  ["Derecho Privado (7252)", "Derecho Privado"],
  ["Finanzas Públicas (7264)", "Finanzas Públicas"],
  ["Matemática II (7272)", "Matemática II"],
  ["Administración III (Planeamiento y Control Organizacional) (731A)",
   "Administración III (Planeamiento y Control Organizacional)"],
  ["Administración Pública (732A)", "Administración Pública"],
  ["Estadística Aplicada (7332)", "Estadística Aplicada"],
  ["Derecho Empresario (734A)", "Derecho Empresario"],
  ["Matemática para Decisiones Empresarias (7352)", "Matemática para Decisiones Empresarias"],
  ["Diseño de Sistemas de Información (741A)", "Diseño de Sistemas de Información"],
  ["Marketing Estratégico (742A)", "Marketing Estratégico"],
  ["Trabajo y Sociedad (743A)", "Trabajo y Sociedad"],
  ["Finanzas de Empresas (744A)", "Finanzas de Empresas"],
  ["Psicosociología Organizacional (745A)", "Psicosociología Organizacional"],
  ["Costos para la Gestión (7462)", "Costos para la Gestión"],
  ["Gestión y Desarrollo de las Personas en la Organización (751A)",
   "Gestión y Desarrollo de las Personas en la Organización"],
  ["Tecnología Informática y Sistemas de Información para la Dirección (752A)",
   "Tecnología Informática y Sistemas de Información para la Dirección"],
  ["Marketing Táctico y Operativo (753A)", "Marketing Táctico y Operativo"],
  ["Negocios Internacionales (754A)", "Negocios Internacionales"],
  ["Tópicos Avanzados en Finanzas (755A)", "Tópicos Avanzados en Finanzas"],
  ["Dirección General (756A)", "Dirección General"],
]);

/* ===== SPEC del usuario (Contabilidad Plan 7) =====
   Formato: { "Materia destino": { cursada:[...], final:[...] } }
   Solo se insertan relaciones cuando la materia y sus prereqs existen en subjects Contabilidad/7
*/
const SPEC = {
  "Contabilidad I (Bases y Fundamentos) (7114)": { cursada: [], final: [] },
  "Introducción a la Economía y Estructura Económica Argentina (7124)": { cursada: [], final: [] },
  "Administración I (Introducción a la Administración y al Estudio de las Organizaciones) (7134)": { cursada: [], final: [] },

  "Microeconomía I (7144)": { cursada: [], final: ["Introducción a la Economía y Estructura Económica Argentina (7124)"] },
  "Matemática I (7154)": { cursada: [], final: ["Introducción a la Economía y Estructura Económica Argentina (7124)"] },
  "Derecho Constitucional y Administrativo (7164)": { cursada: [], final: ["Contabilidad I (Bases y Fundamentos) (7114)","Introducción a la Economía y Estructura Económica Argentina (7124)"] },
  "Introducción a las Ciencias Sociales y al Conocimiento Científico (7174)": { cursada: [], final: ["Contabilidad I (Bases y Fundamentos) (7114)"] },

  "Contabilidad II (Ajuste y Valuación)": { cursada: [], final: ["Contabilidad I (Bases y Fundamentos) (7114)"] },
  "Macroeconomía I (7224)": { cursada: [], final: ["Introducción a la Economía y Estructura Económica Argentina (7124)"] },
  "Historia Económica y Social I (7234)": { cursada: [], final: ["Introducción a la Economía y Estructura Económica Argentina (7124)"] },
  "Administración II (Técnicas Administrativas y Gestión Organizacional) (7243)": { cursada: [], final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones) (7134)"] },
  "Derecho Privado (7252)": { cursada: [], final: ["Derecho Constitucional y Administrativo (7164)"] },
  "Matemática II (7272)": { cursada: [], final: ["Matemática I (7154)"] },
  "Finanzas Públicas (7264)": { cursada: [], final: ["Microeconomía I (7144)","Introducción a la Economía y Estructura Económica Argentina (7124)"] },

  "Contabilidad III (Estados Contables)": { cursada: [], final: ["Contabilidad II (Ajuste y Valuación)"] },
  "Interpretación de los Estados Contables (728A)": { cursada: [], final: ["Contabilidad I (Bases y Fundamentos) (7114)"] },
  "Comportamiento Humano en las Organizaciones (721A)": { cursada: [], final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones) (7134)","Contabilidad I (Bases y Fundamentos) (7114)","Introducción a la Economía y Estructura Económica Argentina (7124)"] },
  "Administración III (Planeamiento y Control Organizacional) (731A)": { cursada: [], final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones) (7134)","Administración II (Técnicas Administrativas y Gestión Organizacional) (7243)","Derecho Constitucional y Administrativo (7164)","Interpretación de los Estados Contables (728A)","Introducción a las Ciencias Sociales y al Conocimiento Científico (7174)","Matemática I (7154)","Microeconomía I (7144)"] },
  "Administración Pública (732A)": { cursada: [], final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones) (7134)","Comportamiento Humano en las Organizaciones (721A)","Derecho Constitucional y Administrativo (7164)","Introducción a las Ciencias Sociales y al Conocimiento Científico (7174)","Matemática I (7154)","Microeconomía I (7144)"] },
  "Estadística Aplicada (7332)": { cursada: [], final: ["Matemática I (7154)","Matemática II (7272)","Introducción a la Economía y Estructura Económica Argentina (7124)"] },
  "Derecho Empresario (734A)": { cursada: [], final: ["Derecho Privado (7252)","Derecho Constitucional y Administrativo (7164)"] },
  "Matemática para Decisiones Empresarias (7352)": { cursada: [], final: ["Matemática II (7272)","Matemática I (7154)"] },
  "Estructura Económica Societaria": { cursada: [], final: ["Introducción a la Economía y Estructura Económica Argentina (7124)","Derecho Privado (7252)"] },
  "Sistema de Información Contable de Apoyo a las Operaciones": { cursada: [], final: ["Contabilidad II (Ajuste y Valuación)"] },
  "Comercialización": { cursada: [], final: ["Administración I (Introducción a la Administración y al Estudio de las Organizaciones) (7134)","Introducción a la Economía y Estructura Económica Argentina (7124)","Contabilidad I (Bases y Fundamentos) (7114)"] },

  "Administración de la Producción (736A)": { cursada: [], final: ["Administración II (Técnicas Administrativas y Gestión Organizacional) (7243)","Estadística Aplicada (7332)"] },
  "Diseño de Sistemas de Información (741A)": { cursada: [], final: ["Administración III (Planeamiento y Control Organizacional) (731A)","Comportamiento Humano en las Organizaciones (721A)","Derecho Privado (7252)","Finanzas Públicas (7264)","Historia Económica y Social I (7234)","Macroeconomía I (7224)","Matemática II (7272)"] },
  "Marketing Estratégico (742A)": { cursada: [], final: ["Administración II (Técnicas Administrativas y Gestión Organizacional) (7243)","Comportamiento Humano en las Organizaciones (721A)","Derecho Privado (7252)","Estadística Aplicada (7332)","Finanzas Públicas (7264)","Historia Económica y Social I (7234)","Interpretación de los Estados Contables (728A)","Macroeconomía I (7224)"] },
  "Trabajo y Sociedad (743A)": { cursada: [], final: ["Administración II (Técnicas Administrativas y Gestión Organizacional) (7243)","Comportamiento Humano en las Organizaciones (721A)","Derecho Constitucional y Administrativo (7164)","Derecho Privado (7252)","Finanzas Públicas (7264)","Historia Económica y Social I (7234)","Interpretación de los Estados Contables (728A)","Introducción a las Ciencias Sociales y al Conocimiento Científico (7174)","Macroeconomía I (7224)","Matemática I (7154)","Matemática II (7272)","Microeconomía I (7144)"] },
  "Finanzas de Empresas (744A)": { cursada: [], final: ["Administración III (Planeamiento y Control Organizacional) (731A)","Comportamiento Humano en las Organizaciones (721A)","Derecho Privado (7252)","Finanzas Públicas (7264)","Historia Económica y Social I (7234)","Macroeconomía I (7224)","Matemática para Decisiones Empresarias (7352)"] },
  "Psicosociología Organizacional (745A)": { cursada: [], final: ["Administración II (Técnicas Administrativas y Gestión Organizacional) (7243)","Comportamiento Humano en las Organizaciones (721A)","Derecho Constitucional y Administrativo (7164)","Derecho Privado (7252)","Finanzas Públicas (7264)","Historia Económica y Social I (7234)","Interpretación de los Estados Contables (728A)","Introducción a las Ciencias Sociales y al Conocimiento Científico (7174)","Macroeconomía I (7224)","Matemática I (7154)","Matemática II (7272)","Microeconomía I (7144)"] },
  "Costos para la Gestión (7462)": { cursada: [], final: ["Administración de la Producción (736A)","Comportamiento Humano en las Organizaciones (721A)","Derecho Privado (7252)","Finanzas Públicas (7264)","Historia Económica y Social I (7234)","Interpretación de los Estados Contables (728A)","Macroeconomía I (7224)"] },

  "Gestión y Desarrollo de las Personas en la Organización (751A)": { cursada: [], final: ["Administración III (Planeamiento y Control Organizacional) (731A)","Administración Pública (732A)","Administración de la Producción (736A)","Derecho Empresario (734A)","Matemática para Decisiones Empresarias (7352)","Trabajo y Sociedad (743A)"] },
  "Tecnología Informática y Sistemas de Información para la Dirección (752A)": { cursada: [], final: ["Administración Pública (732A)","Administración de la Producción (736A)","Derecho Empresario (734A)","Diseño de Sistemas de Información (741A)","Matemática para Decisiones Empresarias (7352)"] },
  "Marketing Táctico y Operativo (753A)": { cursada: [], final: ["Administración III (Planeamiento y Control Organizacional) (731A)","Administración Pública (732A)","Administración de la Producción (736A)","Derecho Empresario (734A)","Marketing Estratégico (742A)","Matemática para Decisiones Empresarias (7352)"] },
  "Negocios Internacionales (754A)": { cursada: [], final: ["Administración III (Planeamiento y Control Organizacional) (731A)","Administración Pública (732A)","Administración de la Producción (736A)","Derecho Empresario (734A)","Marketing Estratégico (742A)","Matemática para Decisiones Empresarias (7352)"] },
  "Tópicos Avanzados en Finanzas (755A)": { cursada: [], final: ["Administración Pública (732A)","Administración de la Producción (736A)","Derecho Empresario (734A)","Finanzas de Empresas (744A)"] },
  "Dirección General (756A)": { cursada: [], final: ["Administración Pública (732A)","Costos para la Gestión (7462)","Derecho Empresario (734A)","Finanzas de Empresas (744A)","Marketing Estratégico (742A)"] },

  // Profesionales específicas / Impuestos / Auditoría
  "Teoría y Técnica Impositiva I": { cursada: [], final: ["Contabilidad II (Ajuste y Valuación)","Derecho Privado (7252)"] },
  "Teoría y Técnica Impositiva II": { cursada: [], final: ["Teoría y Técnica Impositiva I"] },
  "Contabilidad del Sector Público": { cursada: [], final: ["Contabilidad II (Ajuste y Valuación)","Finanzas Públicas (7264)"] },
  "Sistema de Información Contable para la Toma de Decisiones": { cursada: [], final: ["Contabilidad II (Ajuste y Valuación)"] },
  "Auditoría": { cursada: [], final: ["Contabilidad III (Estados Contables)","Interpretación de los Estados Contables (728A)","Costos para la Gestión (7462)"] },
  "Organización y Práctica Profesional": { cursada: [], final: [] }, // Se deja sin edges para no forzar requisitos no-modelados
  "Actuación Profesional Laboral y Previsional": { cursada: [], final: ["Derecho Privado (7252)","Derecho Constitucional y Administrativo (7164)"] },
  "Actuación Profesional en la Justicia": { cursada: [], final: ["Derecho Privado (7252)"] },
  "Seminario (obligatorio a partir de 22 materias aprobadas)": { cursada: [], final: [] }, // se modela con credit threshold fuera del grafo
  "Práctica Profesional Supervisada (PPS) — 100 horas (a partir de 22 materias aprobadas)": { cursada: [], final: [] }, // idem
};

/* ===== main (parcial-seguro) ===== */
(async () => {
  try{
    await init();
    await run(`CREATE TABLE IF NOT EXISTS correlatives_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL,
      depends_on_id INTEGER NOT NULL,
      req_type TEXT
    )`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_subject ON correlatives_edges(subject_id)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_dep ON correlatives_edges(depends_on_id)`);

    const CAREER = 'Contabilidad', PLAN = 7;
    const subs = await all(`SELECT id, name FROM subjects WHERE career=? AND plan=?`, [CAREER, PLAN]);

    const byNorm = new Map(), byNormNoPar = new Map();
    for (const s of subs){
      byNorm.set(normalize(s.name), s);
      byNormNoPar.set(normalize(withoutParens(s.name)), s);
    }
    function alias(name){ return ALIAS.get(name) || name; }
    function match(name){
      const ali = alias(name);
      const n = normalize(ali), np = normalize(withoutParens(ali));
      return byNorm.get(n) || byNormNoPar.get(np) || null;
    }

    // Limpiamos TODO el scope de Contabilidad/7
    await run(`DELETE FROM correlatives_edges WHERE subject_id IN (SELECT id FROM subjects WHERE career=? AND plan=?)`, [CAREER, PLAN]);

    let ins=0, skippedSubjects=[], skippedDeps=[];
    for (const [dest, reqs] of Object.entries(SPEC)){
      const destHit = match(dest);
      if (!destHit){ skippedSubjects.push(dest); continue; }
      for (const dep of (reqs.cursada || [])){
        const depHit = match(dep);
        if (!depHit){ skippedDeps.push(`${dest} ←(cursada)— ${dep}`); continue; }
        await run(`INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`, [destHit.id, depHit.id, 'cursada']);
        ins++;
      }
      for (const dep of (reqs.final || [])){
        const depHit = match(dep);
        if (!depHit){ skippedDeps.push(`${dest} ←(final)— ${dep}`); continue; }
        await run(`INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`, [destHit.id, depHit.id, 'final']);
        ins++;
      }
    }

    const cnt = await all(`
      SELECT COUNT(*) c
        FROM correlatives_edges ce
        JOIN subjects s ON s.id=ce.subject_id
       WHERE s.career=? AND s.plan=?`, [CAREER, PLAN]);

    console.log(`✅ Contabilidad/7: edges insertadas=${ins}, total en scope=${cnt[0].c}`);
    if (skippedSubjects.length){
      console.log('\\n⚠ Materias destino omitidas (no existen en subjects Contabilidad/7):');
      for (const s of skippedSubjects) console.log('  -', s);
    }
    if (skippedDeps.length){
      console.log('\\n⚠ Prerrequisitos omitidos (no existen en subjects Contabilidad/7):');
      for (const s of skippedDeps) console.log('  -', s);
    }
    process.exit(0);
  }catch(e){
    console.error('❌ Error patch_conta7_edges_from_spec:', e);
    process.exit(1);
  }
})();
