// lib/questions.js — core loader (DB + filesystem) con soporte canonical_key
const fs   = require('fs');
const path = require('path');
const { get, all } = require('../models/db');

const PREG_DIR = path.join(__dirname, '..', 'preguntas');
fs.mkdirSync(PREG_DIR, { recursive: true });

function normalizeName(s){
  return String(s || 'desconocido')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\s/g, '-')
    .toLowerCase();
}

function canonicalFromName(name){
  // clave estable para agrupar la misma materia entre planes
  // (coincide con subjects.canonical_key cuando está disponible)
  return normalizeName(name).replace(/-/g, '_');
}

function parseTxt(content){
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let buf = [];
  for (const ln of lines){
    if (/^---\s*$/.test(ln)) {
      if (buf.length >= 5) blocks.push(buf.slice());
      buf = [];
      continue;
    }
    if (ln.trim().length === 0 && buf.length === 0) continue;
    buf.push(ln);
  }
  if (buf.length >= 5) blocks.push(buf);

  const out = [];
  for (const b of blocks){
    const correct = b[b.length - 1].trim();
    const false3  = b[b.length - 2].trim();
    const false2  = b[b.length - 3].trim();
    const false1  = b[b.length - 4].trim();
    const q       = b.slice(0, b.length - 4).join('\n').trim();
    if (!q || !correct || !false1 || !false2 || !false3) continue;
    out.push({
      question: q,
      choices: [false1, false2, false3, correct],
      correct: correct
    });
  }
  return out;
}

function loadQuestions(materia, plan){
  const base = normalizeName(materia) + '-' + normalizeName(plan) + '.txt';
  const fp = path.join(PREG_DIR, base);
  if (!fs.existsSync(fp)) return [];
  try{
    const txt = fs.readFileSync(fp, 'utf8');
    return parseTxt(txt);
  } catch (e){
    console.error('loadQuestions error', e);
    return [];
  }
}

/* =========================
   ✅ NUEVO: DB por canonical_key (compartido entre planes)
   ========================= */
async function loadQuestionsCanonicalDb(canonicalKey, career){
  try{
    const ck  = String(canonicalKey || '').trim();
    const car = String(career || '').trim();
    if (!ck) return [];

    let row = null;

    if (car){
      row = await get(
        `SELECT questions_json
           FROM questions_bank
          WHERE canonical_key=?
            AND LOWER(career)=LOWER(?)
          ORDER BY updated_at DESC
          LIMIT 1`,
        [ck, car]
      );
    }

    if (!row){
      row = await get(
        `SELECT questions_json
           FROM questions_bank
          WHERE canonical_key=?
          ORDER BY
            CASE WHEN career IS NULL OR TRIM(career)='' THEN 1 ELSE 0 END,
            updated_at DESC
          LIMIT 1`,
        [ck]
      );
    }

    if (!row) return [];
    const arr = JSON.parse(row.questions_json);
    return Array.isArray(arr) ? arr : [];
  } catch(e){
    console.error('loadQuestionsCanonicalDb error', e);
    return [];
  }
}

/* =========================
   ✅ LEGACY: DB por (subject_name + plan)
   - se mantiene como fallback para no perder compatibilidad
   ========================= */
async function loadQuestionsDb(materia, plan){
  try{
    const row = await get(
      `SELECT questions_json
         FROM questions_bank
        WHERE LOWER(subject_name)=LOWER(?)
          AND CAST(plan AS TEXT)=CAST(? AS TEXT)
        ORDER BY updated_at DESC
        LIMIT 1`,
      [String(materia || ''), String(plan || '')]
    );

    if (!row) return [];
    const arr = JSON.parse(row.questions_json);
    return Array.isArray(arr) ? arr : [];
  } catch(e){
    console.error('loadQuestionsDb error', e);
    return [];
  }
}

/**
 * ✅ LEGACY: combina TODOS los planes por subject_name (fallback)
 */
async function loadQuestionsAnyPlanDb(materia){
  try{
    const rows = await all(
      `SELECT questions_json
         FROM questions_bank
        WHERE LOWER(subject_name)=LOWER(?)
        ORDER BY updated_at DESC`,
      [String(materia || '')]
    );

    if (!rows || !rows.length) return [];

    let out = [];
    for (const r of rows){
      try{
        const arr = JSON.parse(r.questions_json);
        if (Array.isArray(arr) && arr.length) out = out.concat(arr);
      } catch(e){ /* skip */ }
    }
    return out;
  } catch(e){
    console.error('loadQuestionsAnyPlanDb error', e);
    return [];
  }
}

function shuffleInPlace(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadQuestionsAnyPlan(materia){
  try{
    const basePrefix = normalizeName(materia) + '-';
    const files = fs.readdirSync(PREG_DIR).filter(f => f.startsWith(basePrefix) && f.endsWith('.txt'));
    let out = [];
    for (const f of files){
      try{
        const txt = fs.readFileSync(path.join(PREG_DIR, f), 'utf8');
        const parsed = parseTxt(txt);
        if (Array.isArray(parsed) && parsed.length) out = out.concat(parsed);
      } catch(e){ /* skip bad file */ }
    }
    return out;
  } catch(e){
    return [];
  }
}

module.exports = {
  PREG_DIR,
  normalizeName,
  canonicalFromName,
  parseTxt,
  loadQuestions,
  loadQuestionsDb,
  loadQuestionsAnyPlan,
  loadQuestionsAnyPlanDb,
  loadQuestionsCanonicalDb,
  shuffleInPlace
};