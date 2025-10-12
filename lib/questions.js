
// lib/questions.js — core loader (sin cambios funcionales)
const fs   = require('fs');
const path = require('path');

const PREG_DIR = path.join(__dirname, '..', 'preguntas');
fs.mkdirSync(PREG_DIR, { recursive: true });

function normalizeName(s){
  return String(s || 'desconocido')
    .trim()
    .replace(/[\\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\s/g, '-')
    .toLowerCase();
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

function shuffleInPlace(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { PREG_DIR, normalizeName, parseTxt, loadQuestions, loadQuestionsAnyPlan, shuffleInPlace };


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
