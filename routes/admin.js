// routes/admin.js
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const fsp     = require('fs/promises');
const bcrypt  = require('bcrypt');
const multer  = require('multer');
const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB

// ===== R2 env (para leer/borrar .txt subidos) =====
function norm(v){ return String(v ?? '').trim(); }
function canonKey(v){
  let s = String(v ?? '').trim().toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  s = s.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return s;
}

let R2_ENDPOINT = norm(process.env.R2_ENDPOINT);
const R2_BUCKET = norm(process.env.R2_BUCKET);
const R2_ACCESS_KEY_ID = norm(process.env.R2_ACCESS_KEY_ID);
const R2_SECRET_ACCESS_KEY = norm(process.env.R2_SECRET_ACCESS_KEY);

// Normalizar endpoint (si viene con /bucket)
if (R2_ENDPOINT && R2_ENDPOINT.includes('.r2.cloudflarestorage.com/')) {
  R2_ENDPOINT = R2_ENDPOINT.split('.r2.cloudflarestorage.com/')[0] + '.r2.cloudflarestorage.com';
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

async function r2ReadText(key){
  const out = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const chunks = [];
  for await (const ch of out.Body) chunks.push(Buffer.from(ch));
  return Buffer.concat(chunks).toString('utf-8');
}

async function r2DeleteKey(key){
  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}


// ✅ IMPORTANTE: traemos también `db` para poder usar db.batch() (transacción remota segura en Turso/libSQL)
const { db, all, get, run } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');

/* ========= Helpers de archivos ========= */
const ROOT   = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function uniq(arr){ return Array.from(new Set(arr)); }

function candidatePaths(p){
  if (!p) return [];
  if (path.isAbsolute(p)) return [p];

  const clean = String(p).replace(/^(\.\/|\/)/,''); // quita ./ o /
  const base  = path.basename(clean);

  const variants = [
    clean,
    path.join('public', clean),
    path.join('uploads', clean),
    path.join('public','uploads', clean),
    path.join('public','uploads','docs', clean),
    path.join('public','uploads','docs', base),
    path.join('public','uploads','subjects', clean),
    path.join('public','uploads','subjects', base),
    path.join('uploads','docs', base),
    path.join('uploads','subjects', base),
  ];

  const abs = [];
  for (const v of variants){
    abs.push(path.join(ROOT, v));
  }
  abs.push(path.join(PUBLIC, 'uploads', 'docs', base));
  abs.push(path.join(PUBLIC, 'uploads', 'subjects', base));

  return uniq(abs);
}

async function safeUnlinkMany(relOrAbs){
  const cands = path.isAbsolute(relOrAbs) ? [relOrAbs] : candidatePaths(relOrAbs);
  for (const abs of cands){
    try{
      await fsp.unlink(abs);
      return true;
    }catch(e){
      if (e.code !== 'ENOENT'){ console.warn('[unlink]', e.message); }
    }
  }
  return false;
}

/* ========= Correlativas (EDGES): tabla real que consume routes/correlativas.js =========
 * La vista arma los “hilos” desde correlatives_edges:
 *   correlatives_edges(subject_id, depends_on_id, req_type)  req_type: 'cursada' | 'final'
 */
async function ensureCorrelativesEdgesTable(){
  try{
    await run(`
      CREATE TABLE IF NOT EXISTS correlatives_edges (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id    INTEGER NOT NULL,
        depends_on_id INTEGER NOT NULL,
        req_type      TEXT DEFAULT 'cursada'
      )
    `);

    // Asegurar columnas por si existe una versión vieja
    const cols = await all(`PRAGMA table_info(correlatives_edges)`);
    const has = (n) => Array.isArray(cols) && cols.some(c => String(c.name) === String(n));
    if (!has('subject_id'))    await run(`ALTER TABLE correlatives_edges ADD COLUMN subject_id INTEGER`);
    if (!has('depends_on_id')) await run(`ALTER TABLE correlatives_edges ADD COLUMN depends_on_id INTEGER`);
    if (!has('req_type'))      await run(`ALTER TABLE correlatives_edges ADD COLUMN req_type TEXT DEFAULT 'cursada'`);

    // Índices (no rompen si ya existen)
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_subject ON correlatives_edges(subject_id)`).catch(()=>{});
    await run(`CREATE INDEX IF NOT EXISTS idx_ce_depends ON correlatives_edges(depends_on_id)`).catch(()=>{});
  }catch(e){
    console.warn('[correlatives_edges] ensure warning:', e?.message);
  }
}

function normKey(v){
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " y ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(i)\b$/g, "1")
    .replace(/\b(ii)\b$/g, "2")
    .replace(/\b(iii)\b$/g, "3")
    .replace(/\b(iv)\b$/g, "4")
    .replace(/\b(v)\b$/g, "5")
    .replace(/\b(vi)\b$/g, "6");
}

function stripParens(s){
  return String(s ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCorrelativasTxt(raw){
  // Devuelve [{ name, career, plan, regList[], finalList[] }]
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  // -----------------------------
  // 1) Formato por BLOQUES (original)
  // -----------------------------
  const blocks = text.split(/\n{2,}/);
  const outBlocks = [];
  for (let b of blocks){
    const lines = b.split('\n').map(s=>s.trim()).filter(Boolean);
    if (!lines.length) continue;

    let name = '';
    let career = '';
    let plan = '';
    let reg = '';
    let fin = '';

    for (let i=0; i<lines.length; i++){
      const ln = lines[i];

      if (i === 0 && !/^materia\s*:/i.test(ln)){
        name = String(ln).replace(/:\s*$/,'').trim();
        continue;
      }

      const mMateria = ln.match(/^materia\s*:\s*(.+)$/i);
      const mCarrera = ln.match(/^carrera\s*:\s*(.+)$/i);
      const mPlan    = ln.match(/^plan\s*:\s*(.+)$/i);
      const mReg     = ln.match(/^regularizada(s)?\s*:\s*(.*)$/i);
      const mFin     = ln.match(/^(final\s+aprobado|final)\s*:\s*(.*)$/i);

      if (mMateria) name   = (mMateria[1] || '').trim();
      if (mCarrera) career = (mCarrera[1] || '').trim();
      if (mPlan)    plan   = (mPlan[1] || '').trim();
      if (mReg)     reg    = (mReg[2] || mReg[1] || '').trim();
      if (mFin)     fin    = (mFin[2] || '').toString().trim();
    }

    if (!name) continue;

    const splitSmart = (str) => {
      const t = String(str || '').trim();
      if (!t) return [];
      if (/^(ninguna|ninguno|nan|n\/a|no)\.?$/i.test(t)) return [];
      return t
        .split(/[,\n;]+/g)
        .map(x => x.replace(/^[-•*–]\s*/,'').trim())
        .filter(Boolean)
        .filter(x => !/^(ninguna|ninguno|nan)$/i.test(x));
    };

    const regList   = splitSmart(reg);
    const finalList = splitSmart(fin);
    outBlocks.push({ name, career, plan, regList, finalList });
  }
  if (outBlocks.length) return outBlocks;

  // -----------------------------
  // 2) Formato CONSOLIDADO (flecha)
  // -----------------------------
  const out = [];
  const rxStart = /(^|[\n\.]|(?:\)\s+(?=[A-ZÁÉÍÓÚÑ])))\s*([^→\n]+?)\s*→\s*Regularizadas?\s*:/gi;

  const starts = [];
  let mm;
  while ((mm = rxStart.exec(text)) !== null){
    const delimLen = (mm[1] || '').length;
    const startIdx = mm.index + delimLen;
    const name = String(mm[2] || '').trim();
    starts.push({ startIdx, name });
  }

  if (!starts.length) return [];

  for (let i=0; i<starts.length; i++){
    const s = starts[i];
    const end = (i+1 < starts.length) ? starts[i+1].startIdx : text.length;
    const chunk = text.slice(s.startIdx, end).trim();

    const mReg = chunk.match(/→\s*Regularizadas?\s*:\s*([\s\S]*?)(?:\s*\|\s*Final\s+aprobado\s*:\s*|\s*Final\s+aprobado\s*:\s*|$)/i);
    const mFin = chunk.match(/Final\s+aprobado\s*:\s*([\s\S]*)/i);

    let reg = (mReg?.[1] || '').trim();
    let fin = (mFin?.[1] || '').trim();

    const cleanList = (str) => {
      const t = String(str || '').trim();
      if (!t) return [];
      if (/^(ninguna|ninguno|nan|n\/a|no)\.?$/i.test(t)) return [];
      return t.split(/\s*,\s*/).map(x=>x.trim()).filter(Boolean).filter(x=>!/^(ninguna|nan)$/i.test(x));
    };

    const regList = cleanList(reg);
    const finalList = cleanList(fin);

    out.push({ name: s.name, career:'', plan:'', regList, finalList });
  }

  return out;
}

async function findSubjectIdByHints({ name, career, plan }){
  const wantedRaw = String(name ?? '').trim();
  if (!wantedRaw) return null;

  const careerNorm = career ? normalizeCareer(career) : '';
  const planStr = (plan !== undefined && plan !== null && String(plan).trim() !== '') ? String(plan).trim() : '';

  let rows = [];
  if (careerNorm && planStr){
    rows = await all(
      `SELECT id, name FROM subjects
      WHERE LOWER(career)=LOWER(?) AND CAST(plan AS TEXT)=?`,
      [careerNorm, planStr]
    );
  } else {
    rows = await all(`SELECT id, name FROM subjects`);
  }

  if (!rows || !rows.length) return null;

  const wantedLower = wantedRaw.toLowerCase();
  const wantedNoPar = stripParens(wantedRaw);
  const wantedNoParLower = wantedNoPar.toLowerCase();

  const wantedKey = normKey(wantedRaw);
  const wantedNoParKey = normKey(wantedNoPar);

  const byLower = new Map();
  const byNoParLower = new Map();
  const byKey = new Map();
  const byNoParKey = new Map();

  for (const r of rows){
    const n = String(r.name ?? '').trim();
    const nLower = n.toLowerCase();
    const nNoPar = stripParens(n);
    const nNoParLower = nNoPar.toLowerCase();

    byLower.set(nLower, r.id);
    byNoParLower.set(nNoParLower, r.id);

    const k = normKey(n);
    const k2 = normKey(nNoPar);
    if (k)  byKey.set(k, r.id);
    if (k2) byNoParKey.set(k2, r.id);
  }

  if (byLower.has(wantedLower)) return byLower.get(wantedLower);
  if (byNoParLower.has(wantedNoParLower)) return byNoParLower.get(wantedNoParLower);
  if (wantedKey && byKey.has(wantedKey)) return byKey.get(wantedKey);
  if (wantedNoParKey && byNoParKey.has(wantedNoParKey)) return byNoParKey.get(wantedNoParKey);

  for (const r of rows){
    const n = String(r.name ?? '').trim();
    const nNoPar = stripParens(n);

    const a = wantedNoParLower;
    const b = nNoPar.toLowerCase();

    if (a && b && (b.includes(a) || a.includes(b))) {
      return r.id;
    }
  }

  const norm = (s) => String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\([^)]*\)/g,' ')
    .replace(/&/g,' y ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .replace(/\b(i)\b$/g,'1')
    .replace(/\b(ii)\b$/g,'2')
    .replace(/\b(iii)\b$/g,'3')
    .replace(/\b(iv)\b$/g,'4')
    .replace(/\b(v)\b$/g,'5')
    .replace(/\b(vi)\b$/g,'6');

  const tokenSim = (a,b) => {
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;

    const A = new Set(na.split(' ').filter(Boolean));
    const B = new Set(nb.split(' ').filter(Boolean));
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;

    const containsBonus = (nb.includes(na) || na.includes(nb)) ? 0.15 : 0;
    const base = inter / Math.max(1, Math.max(A.size, B.size));
    return Math.min(1, base + containsBonus);
  };

  let bestId = null;
  let bestScore = 0;
  for (const r of rows){
    const sc = tokenSim(wantedRaw, r.name);
    if (sc > bestScore){
      bestScore = sc;
      bestId = r.id;
    }
  }

  if (bestId && bestScore >= 0.50) return bestId;
  return null;
}

async function upsertCorrelativasEdgesFromBlocks(blocks){
  await ensureCorrelativesEdgesTable();

  let updatedSubjects = 0;
  let insertedEdges = 0;

  const notFoundSubjects = [];
  const missReqs = [];

  const stmts = [];

  for (const b of blocks){
    const subjectId = await findSubjectIdByHints(b);
    if (!subjectId){
      notFoundSubjects.push(b.name);
      continue;
    }

    stmts.push({
      sql: `DELETE FROM correlatives_edges WHERE subject_id=?`,
      args: [subjectId]
    });

    const regList = Array.isArray(b.regList) ? b.regList : [];
    for (const reqName of regList){
      const dependsId = await findSubjectIdByHints({ name: reqName, career: b.career, plan: b.plan });
      if (!dependsId){
        missReqs.push({ subject: b.name, req: reqName, tipo: 'cursada' });
        continue;
      }
      stmts.push({
        sql: `INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
        args: [subjectId, dependsId, 'cursada']
      });
      insertedEdges++;
    }

    const finList = Array.isArray(b.finalList) ? b.finalList : [];
    for (const reqName of finList){
      const dependsId = await findSubjectIdByHints({ name: reqName, career: b.career, plan: b.plan });
      if (!dependsId){
        missReqs.push({ subject: b.name, req: reqName, tipo: 'final' });
        continue;
      }
      stmts.push({
        sql: `INSERT INTO correlatives_edges (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
        args: [subjectId, dependsId, 'final']
      });
      insertedEdges++;
    }

    updatedSubjects++;
  }

  if (stmts.length){
    await db.batch(stmts, 'write');
  }

  return { updatedSubjects, insertedEdges, notFoundSubjects, missReqs };
}

/* ========= Subjects: migración para relajar CHECK del plan ========= */
async function ensureSubjectsPlanRelaxed(){
  const row = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='subjects'`);
  if (!row || !row.sql) return;

  const sql = String(row.sql);
  const hasCheck = /CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/i.test(sql);
  if (!hasCheck) return;

  const newCreate = sql
    .replace(/CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/ig, '')
    .replace(/CREATE\s+TABLE\s+("?subjects"?)/i, 'CREATE TABLE subjects_v2');

  await run('BEGIN');
  try{
    await run(newCreate);
    await run(`INSERT INTO subjects_v2 SELECT * FROM subjects`);
    await run(`DROP TABLE subjects`);
    await run(`ALTER TABLE subjects_v2 RENAME TO subjects`);
    await run('COMMIT');
    console.log('[migración] subjects: CHECK plan IN (7,8) removido');
  }catch(e){
    await run('ROLLBACK').catch(()=>{});
    console.error('[migración] subjects fallida:', e);
    throw e;
  }
}

/* ===== users.phone: asegurar columna opcional ===== */
async function ensureUsersPhoneColumn(){
  try{
    const cols = await all(`PRAGMA table_info(users)`);
    const has = Array.isArray(cols) && cols.some(c => String(c.name) === 'phone');
    if (!has){
      await run(`ALTER TABLE users ADD COLUMN phone TEXT`);
      console.log('[migración] users: columna phone agregada');
    }
  }catch(e){
    console.warn('No se pudo asegurar users.phone (continuo sin romper):', e?.message);
  }
}

/* ===== users.career: relajar CHECK de carreras fijas ===== */
async function ensureUsersCareerRelaxed(){
  const row = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`);
  if (!row || !row.sql) return;

  const sql = String(row.sql);

  const hasCareerCheck =
    /CHECK\s*\(\s*career\s+IN\s*\(/i.test(sql) ||
    /CHECK\s*\(\s*LOWER\s*\(\s*career\s*\)/i.test(sql);

  if (!hasCareerCheck) return;

  let newCreate = sql;
  newCreate = newCreate.replace(/CHECK\s*\(\s*career\s+IN\s*\([^)]*\)\s*\)\s*/ig, '');
  newCreate = newCreate.replace(/CHECK\s*\(\s*LOWER\s*\(\s*career\s*\)[^)]*\)\s*\)\s*/ig, '');
  newCreate = newCreate.replace(/CREATE\s+TABLE\s+("?users"?)/i, 'CREATE TABLE users_v2');

  await run('BEGIN');
  try{
    await run(newCreate);

    const cols = await all(`PRAGMA table_info(users)`);
    const colNames = cols.map(c => c.name).join(', ');

    await run(`INSERT INTO users_v2 (${colNames}) SELECT ${colNames} FROM users`);
    await run(`DROP TABLE users`);
    await run(`ALTER TABLE users_v2 RENAME TO users`);
    await run('COMMIT');
    console.log('[migración] users: CHECK career eliminado');
  }catch(e){
    await run('ROLLBACK').catch(()=>{});
    console.error('[migración] users: no se pudo relajar CHECK de career:', e?.message);
    throw e;
  }
}

/* ===== finals: asegurar tabla/columnas requeridas ===== */
async function ensureFinalsSchema(){
  const exists = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='finals'`);
  if (!exists) {
    await run(`
      CREATE TABLE IF NOT EXISTS finals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        career TEXT DEFAULT '',
        plan INTEGER DEFAULT 7,
        subject_id INTEGER,
        year INTEGER,
        modalidad TEXT DEFAULT '',
        libre TEXT DEFAULT '',
        regular TEXT DEFAULT '',
        exam_type TEXT NOT NULL DEFAULT 'escrito y oral' CHECK (exam_type IN ('escrito','oral','escrito y oral')),
        rendible INTEGER DEFAULT 1,
        prob_regular INTEGER DEFAULT 0,
        prob_libre INTEGER DEFAULT 0,
        top_units_json TEXT DEFAULT '[]',
        best_months TEXT DEFAULT '',
        worst_months TEXT DEFAULT '',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[migración] finals: tabla creada completa');
    return;
  }

  const cols = await all(`PRAGMA table_info(finals)`);
  const has = (name) => cols.some(c => String(c.name) === String(name));

  if (!has('career'))         await run(`ALTER TABLE finals ADD COLUMN career TEXT DEFAULT ''`);
  if (!has('plan'))           await run(`ALTER TABLE finals ADD COLUMN plan INTEGER DEFAULT 7`);
  if (!has('subject_id'))     await run(`ALTER TABLE finals ADD COLUMN subject_id INTEGER`);
  if (!has('year'))           await run(`ALTER TABLE finals ADD COLUMN year INTEGER`);
  if (!has('modalidad'))      await run(`ALTER TABLE finals ADD COLUMN modalidad TEXT DEFAULT ''`);
  if (!has('libre'))          await run(`ALTER TABLE finals ADD COLUMN libre TEXT DEFAULT ''`);
  if (!has('regular'))        await run(`ALTER TABLE finals ADD COLUMN regular TEXT DEFAULT ''`);
  if (!has('exam_type'))      await run(`ALTER TABLE finals ADD COLUMN exam_type TEXT DEFAULT 'escrito y oral'`);
  if (!has('rendible'))       await run(`ALTER TABLE finals ADD COLUMN rendible INTEGER DEFAULT 1`);
  if (!has('prob_regular'))   await run(`ALTER TABLE finals ADD COLUMN prob_regular INTEGER DEFAULT 0`);
  if (!has('prob_libre'))     await run(`ALTER TABLE finals ADD COLUMN prob_libre INTEGER DEFAULT 0`);
  if (!has('top_units_json')) await run(`ALTER TABLE finals ADD COLUMN top_units_json TEXT DEFAULT '[]'`);
  if (!has('best_months'))    await run(`ALTER TABLE finals ADD COLUMN best_months TEXT DEFAULT ''`);
  if (!has('worst_months'))   await run(`ALTER TABLE finals ADD COLUMN worst_months TEXT DEFAULT ''`);
  if (!has('created_at'))     await run(`ALTER TABLE finals ADD COLUMN created_at TEXT`);
  if (!has('updated_at'))     await run(`ALTER TABLE finals ADD COLUMN updated_at TEXT`);

  await run(`UPDATE finals SET career = '' WHERE career IS NULL`);
  await run(`UPDATE finals SET plan = 7 WHERE plan IS NULL`);
  await run(`UPDATE finals SET modalidad = '' WHERE modalidad IS NULL`);
  await run(`UPDATE finals SET libre = '' WHERE libre IS NULL`);
  await run(`UPDATE finals SET regular = '' WHERE regular IS NULL`);
  await run(`UPDATE finals SET rendible = 1 WHERE rendible IS NULL`);
  await run(`UPDATE finals SET prob_regular = 0 WHERE prob_regular IS NULL`);
  await run(`UPDATE finals SET prob_libre = 0 WHERE prob_libre IS NULL`);
  await run(`UPDATE finals SET top_units_json = '[]' WHERE top_units_json IS NULL OR TRIM(top_units_json) = ''`);
  await run(`UPDATE finals SET best_months = '' WHERE best_months IS NULL`);
  await run(`UPDATE finals SET worst_months = '' WHERE worst_months IS NULL`);
  await run(`UPDATE finals SET created_at = datetime('now') WHERE created_at IS NULL OR TRIM(created_at) = ''`);
  await run(`UPDATE finals SET updated_at = datetime('now') WHERE updated_at IS NULL OR TRIM(updated_at) = ''`);
}


/* ===== finals: asegurar tabla (legacy helper) ===== */
async function ensureFinalsTable(){
  await ensureFinalsSchema();
}


async function ensureCursadasTables(){
  const tableRow = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cursadas'`);
  const tableSql = String(tableRow?.sql || '');

  const needsRebuild =
    !tableRow ||
    !/subject\s+TEXT/i.test(tableSql) ||
    !/commission\s+TEXT/i.test(tableSql) ||
    /UNIQUE\s*\(\s*career\s*,\s*plan\s*,\s*subject_id\s*\)/i.test(tableSql);

  if (needsRebuild) {
    try { await run(`DROP INDEX IF EXISTS idx_cursadas_unique_subject`); } catch (_) {}
    try { await run(`DROP INDEX IF EXISTS idx_cursadas_unique_subject_commission`); } catch (_) {}

    await run(`
      CREATE TABLE IF NOT EXISTS cursadas_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        career TEXT DEFAULT '',
        plan INTEGER DEFAULT 0,
        subject_id INTEGER,
        subject TEXT DEFAULT '',
        year INTEGER,
        commission TEXT DEFAULT '',
        schedule_text TEXT DEFAULT '',
        approval_pct INTEGER DEFAULT 0,
        promotion_pct INTEGER DEFAULT 0,
        class_type TEXT DEFAULT '',
        teachers_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    if (tableRow) {
      const cols = await all(`PRAGMA table_info(cursadas)`);
      const has = (name) => cols.some(c => String(c.name) === String(name));

      await run(
        `INSERT INTO cursadas_new (
          id, career, plan, subject_id, subject, year, commission, schedule_text,
          approval_pct, promotion_pct, class_type, teachers_json, created_at, updated_at
        )
        SELECT
          id,
          COALESCE(career, ''),
          COALESCE(plan, 0),
          subject_id,
          ${has('subject') ? `COALESCE(subject, '')` : `''`},
          year,
          ${has('commission') ? `COALESCE(commission, '')` : `''`},
          COALESCE(schedule_text, ''),
          COALESCE(approval_pct, 0),
          COALESCE(promotion_pct, 0),
          COALESCE(class_type, ''),
          COALESCE(teachers_json, '[]'),
          COALESCE(created_at, datetime('now')),
          COALESCE(updated_at, datetime('now'))
        FROM cursadas`
      );

      await run(`DROP TABLE cursadas`);
    }

    await run(`ALTER TABLE cursadas_new RENAME TO cursadas`);
  }

  const cols = await all(`PRAGMA table_info(cursadas)`);
  const has = (name) => cols.some(c => String(c.name) === String(name));

  if (!has('career'))        await run(`ALTER TABLE cursadas ADD COLUMN career TEXT DEFAULT ''`);
  if (!has('plan'))          await run(`ALTER TABLE cursadas ADD COLUMN plan INTEGER DEFAULT 0`);
  if (!has('subject_id'))    await run(`ALTER TABLE cursadas ADD COLUMN subject_id INTEGER`);
  if (!has('subject'))       await run(`ALTER TABLE cursadas ADD COLUMN subject TEXT DEFAULT ''`);
  if (!has('year'))          await run(`ALTER TABLE cursadas ADD COLUMN year INTEGER`);
  if (!has('commission'))    await run(`ALTER TABLE cursadas ADD COLUMN commission TEXT DEFAULT ''`);
  if (!has('schedule_text')) await run(`ALTER TABLE cursadas ADD COLUMN schedule_text TEXT DEFAULT ''`);
  if (!has('approval_pct'))  await run(`ALTER TABLE cursadas ADD COLUMN approval_pct INTEGER DEFAULT 0`);
  if (!has('promotion_pct')) await run(`ALTER TABLE cursadas ADD COLUMN promotion_pct INTEGER DEFAULT 0`);
  if (!has('class_type'))    await run(`ALTER TABLE cursadas ADD COLUMN class_type TEXT DEFAULT ''`);
  if (!has('teachers_json')) await run(`ALTER TABLE cursadas ADD COLUMN teachers_json TEXT DEFAULT '[]'`);
  if (!has('created_at'))    await run(`ALTER TABLE cursadas ADD COLUMN created_at TEXT`);
  if (!has('updated_at'))    await run(`ALTER TABLE cursadas ADD COLUMN updated_at TEXT`);

  await run(`UPDATE cursadas SET career = '' WHERE career IS NULL`);
  await run(`UPDATE cursadas SET plan = 0 WHERE plan IS NULL`);
  await run(`UPDATE cursadas SET subject = '' WHERE subject IS NULL`);
  await run(`UPDATE cursadas SET commission = '' WHERE commission IS NULL`);
  await run(`UPDATE cursadas SET schedule_text = '' WHERE schedule_text IS NULL`);
  await run(`UPDATE cursadas SET approval_pct = 0 WHERE approval_pct IS NULL`);
  await run(`UPDATE cursadas SET promotion_pct = 0 WHERE promotion_pct IS NULL`);
  await run(`UPDATE cursadas SET class_type = '' WHERE class_type IS NULL`);
  await run(`UPDATE cursadas SET teachers_json = '[]' WHERE teachers_json IS NULL OR TRIM(teachers_json) = ''`);
  await run(`UPDATE cursadas SET created_at = datetime('now') WHERE created_at IS NULL OR TRIM(created_at) = ''`);
  await run(`UPDATE cursadas SET updated_at = datetime('now') WHERE updated_at IS NULL OR TRIM(updated_at) = ''`);

  await run(`
    CREATE TABLE IF NOT EXISTS cursada_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cursada_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cursada_id, user_id)
    )
  `);

  try {
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cursada_reactions_unique ON cursada_reactions(cursada_id, user_id)`);
  } catch (_) {}
}


function splitBlocksFromTxt(text){
  const raw = String(text || '').replace(/\r/g, '');

  const normalized = raw
    .replace(/\n(?=Materia:\s*)/g, '\n---\n')
    .replace(/\n{3,}/g, '\n\n');

  return normalized
    .split(/\n---+\n/g)
    .map(b => b.trim())
    .filter(Boolean);
}

function parseMultilineFields(block){
  const out = {};
  let currentKey = '';
  const lines = String(block || '').replace(/\r/g, '').split('\n');

  for (const raw of lines){
    const line = String(raw || '');
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (m){
      currentKey = canonKey(m[1]);
      out[currentKey] = String(m[2] || '').trim();
      continue;
    }
    if (currentKey){
      const extra = line.trim();
      if (!extra) continue;
      out[currentKey] = out[currentKey] ? `${out[currentKey]}\n${extra}` : extra;
    }
  }

  return out;
}

function parsePercent(value){
  const raw = String(value ?? '').trim();
  if (!raw) return 0;

  const cleaned = raw
    .replace(/%/g, '')
    .replace(/\s+/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');

  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;

  const num = Math.round(parseFloat(match[0]));
  if (!Number.isFinite(num)) return 0;

  return Math.max(0, Math.min(100, num));
}

function parseList(value){
  return String(value || '')
    .split(/\||,|;|\n/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseBooleanYesNo(value, fallback = true){
  const v = canonKey(value);
  if (!v) return fallback;
  if (['si', 'sí', 'yes', 'true', '1', 'habilitado', 'permitido'].includes(v)) return true;
  if (['no', 'false', '0', 'no rinde', 'deshabilitado', 'prohibido'].includes(v)) return false;
  return fallback;
}


function normalizeMateriaLoose(value){
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\bintro\b/g, 'introduccion')
    .replace(/\badm\b/g, 'administracion')
    .replace(/\bsist\b/g, 'sistema')
    .replace(/\binfo\b/g, 'informacion')
    .replace(/\becon\b/g, 'economia')
    .replace(/\bcontab\b/g, 'contabilidad')
    .replace(/\bcatedras?\b/g, ' ')
    .replace(/\bcomisiones?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function materiaLooseTokens(value){
  const stop = new Set(['de','del','la','las','los','y','e','a','al','en','para','por','con','sin','el','un','una']);
  return normalizeMateriaLoose(value)
    .split(' ')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(token => !stop.has(token));
}

function materiaRomanLevel(tokens){
  return tokens.find(t => /^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(t)) || '';
}

function materiaAliases(value){
  const raw = normalizeMateriaLoose(value);
  const out = new Set();
  if (raw) out.add(raw);

  const tokens = materiaLooseTokens(value);
  if (tokens.length) {
    out.add(tokens.join(' '));
    out.add(tokens.slice(0, 2).join(' '));
    out.add(tokens.slice(0, 3).join(' '));

    const romanIdx = tokens.findIndex(t => /^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(t));
    if (romanIdx >= 0) {
      out.add(tokens.slice(0, romanIdx + 1).join(' '));
    }
  }

  return [...out].filter(Boolean);
}

function materiaMatchScore(inputName, candidateName, expectedYear, candidateYear){
  const inputAliases = materiaAliases(inputName);
  const candidateAliases = materiaAliases(candidateName);

  if (!inputAliases.length || !candidateAliases.length) return 0;

  const yearBonus = (
    expectedYear &&
    candidateYear &&
    Number(expectedYear) === Number(candidateYear)
  ) ? 5 : 0;

  for (const a of inputAliases) {
    for (const b of candidateAliases) {
      if (a && b && a === b) return 100 + yearBonus;
    }
  }

  for (const a of inputAliases) {
    for (const b of candidateAliases) {
      if (a && b && a.length >= 6 && b.includes(a)) return 92 + yearBonus;
      if (a && b && b.length >= 6 && a.includes(b)) return 92 + yearBonus;
    }
  }

  const inputTokens = materiaLooseTokens(inputName);
  const candidateTokens = materiaLooseTokens(candidateName);
  if (!inputTokens.length || !candidateTokens.length) return 0;

  const inputRoman = materiaRomanLevel(inputTokens);
  const candidateRoman = materiaRomanLevel(candidateTokens);
  if (inputRoman && candidateRoman && inputRoman !== candidateRoman) return 0;

  const setA = new Set(inputTokens);
  const setB = new Set(candidateTokens);
  let common = 0;
  for (const token of setA) {
    if (setB.has(token)) common += 1;
  }

  const minSize = Math.max(1, Math.min(setA.size, setB.size));
  let score = (common / minSize) * 80;

  if (setA.size === 1) {
    const only = [...setA][0];
    if (only && only.length >= 7 && setB.has(only)) {
      score = Math.max(score, 88);
    }
  }

  return score + yearBonus;
}

async function findSubjectsByNameGlobal(name, expectedYear){
  const rows = await all(`
    SELECT id, name, subject_name, canonical_key, year, career, plan
    FROM subjects
    ORDER BY COALESCE(year, 99), name, career, plan, id
  `);

  const scored = rows.map(r => {
    const variants = [
      String(r.name || ''),
      String(r.subject_name || ''),
      String(r.canonical_key || '')
    ].filter(Boolean);

    let bestScore = 0;
    for (const variant of variants) {
      bestScore = Math.max(
        bestScore,
        materiaMatchScore(name, variant, expectedYear, r.year)
      );
    }

    const groupKey =
      String(r.canonical_key || '').trim() ||
      normalizeMateriaLoose(r.subject_name || r.name || '');

    return {
      ...r,
      _score: bestScore,
      _groupKey: groupKey
    };
  }).filter(r => r._score >= 60)
    .sort((a, b) =>
      (b._score - a._score) ||
      ((Number(a.year || 99)) - (Number(b.year || 99))) ||
      String(a.name || '').localeCompare(String(b.name || ''), 'es')
    );

  if (!scored.length) return [];

  const chosen = scored[0];
  const groupKey = chosen._groupKey;

  const sameGroup = rows.filter(r => {
    const currentKey =
      String(r.canonical_key || '').trim() ||
      normalizeMateriaLoose(r.subject_name || r.name || '');
    return currentKey && groupKey && currentKey === groupKey;
  }).sort((a, b) =>
    ((Number(a.year || 99)) - (Number(b.year || 99))) ||
    String(a.name || '').localeCompare(String(b.name || ''), 'es')
  );

  return sameGroup.length ? sameGroup : [chosen];
}

function parseFinalesTxt(text){
  const blocks = splitBlocksFromTxt(text);

  return blocks.map(block => {
    const map = parseMultilineFields(block);

    const materia = String(
      map['materia'] ||
      map['nombre'] ||
      map['nombre materia'] ||
      ''
    ).trim();

    const year = parseInt(
      String(map['ano'] || map['año'] || map['year'] || '').replace(/[^\d]/g, ''),
      10
    ) || null;

    const regular = String(
      map['regular'] ||
      map['condiciones regular'] ||
      map['condicion regular'] ||
      ''
    ).trim();

    const libre = String(
      map['libre'] ||
      map['condiciones libre'] ||
      map['condicion libre'] ||
      ''
    ).trim();

    const rindeLibreRaw = String(
      map['rinde libre'] ||
      map['rinde_libre'] ||
      map['permite libre'] ||
      map['permite_libre'] ||
      map['modalidad libre'] ||
      ''
    ).trim();

    const topUnits = parseList(
      map['unidades probables'] ||
      map['top 5'] ||
      map['top5'] ||
      map['unidades'] ||
      ''
    ).slice(0, 5);

    const bestMonths = parseList(
      map['mejores meses'] ||
      map['mejores'] ||
      map['mejores meses para rendir'] ||
      ''
    ).slice(0, 3);

    const worstMonths = parseList(
      map['peores meses'] ||
      map['peores'] ||
      map['peores meses para rendir'] ||
      ''
    ).slice(0, 3);

    const probRegular = parsePercent(
      map['% aprobacion regular'] ||
      map['% aprobación regular'] ||
      map['aprobacion regular'] ||
      map['aprobación regular'] ||
      map['probabilidad regular'] ||
      map['regular %'] ||
      '0'
    );

    const probLibre = parsePercent(
      map['% aprobacion libre'] ||
      map['% aprobación libre'] ||
      map['aprobacion libre'] ||
      map['aprobación libre'] ||
      map['probabilidad libre'] ||
      map['libre %'] ||
      '0'
    );

    const explicitNo = /^(no|n)$/i.test(rindeLibreRaw);
    const explicitYes = /^(si|sí|s)$/i.test(rindeLibreRaw);

    const libreForbids =
      libre === '-' ||
      /no posee modalidad libre/i.test(libre);

    const libreHasUsefulText =
      !!libre &&
      libre !== '-' &&
      !/no posee modalidad libre/i.test(libre);

    const permiteLibre = libreForbids
      ? false
      : explicitNo
        ? false
        : (explicitYes || libreHasUsefulText || probLibre > 0);

    return {
      materia,
      year,
      regular,
      libre,
      permiteLibre,
      probRegular,
      probLibre,
      topUnits,
      bestMonths,
      worstMonths
    };
  }).filter(item => item.materia);
}

function parseCursadasTxt(text){
  const blocks = splitBlocksFromTxt(text);

  return blocks.map(block => {
    const map = parseMultilineFields(block);

    const materia = String(
      map['materia'] ||
      map['nombre'] ||
      map['nombre materia'] ||
      ''
    ).trim();

    const year = parseInt(
      String(map['ano'] || map['año'] || map['year'] || '').replace(/[^\d]/g, ''),
      10
    ) || null;

    const commission = String(
      map['comision'] ||
      map['comisión'] ||
      map['comision cursada'] ||
      map['comisión cursada'] ||
      ''
    ).trim();

    const scheduleText = String(
      map['dias horarios'] ||
      map['dias y horarios'] ||
      map['horarios'] ||
      map['cursada'] ||
      ''
    ).trim();

    const approvalPct = parsePercent(
      map['% aprobacion'] ||
      map['aprobacion'] ||
      map['porcentaje aprobacion'] ||
      '0'
    );

    const promotionPct = parsePercent(
      map['% promocion'] ||
      map['promocion'] ||
      map['porcentaje promocion'] ||
      '0'
    );

    const classType = String(
      map['tipo'] ||
      map['modalidad'] ||
      ''
    ).trim();

    let teachers = parseList(
      map['docentes'] ||
      map['profesores'] ||
      map['docente'] ||
      ''
    );

    const p1 = String(map['docente 1'] || map['profesor 1'] || '').trim();
    const p2 = String(map['docente 2'] || map['profesor 2'] || '').trim();

    if (p1) teachers.push(p1);
    if (p2) teachers.push(p2);

    teachers = [...new Set(teachers.filter(Boolean))].slice(0, 4);

    return {
      materia,
      year,
      commission,
      scheduleText,
      approvalPct,
      promotionPct,
      classType,
      teachers
    };
  }).filter(item => item.materia);
}

/* ========= Router ========= */
module.exports = () => {
  const router = express.Router();

  router.use(express.json({ limit: '2mb' }));
  router.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Ejecutar migraciones sin bloquear
  (async()=>{ try{ await ensureUsersPhoneColumn(); }catch(_){ } })();
  (async()=>{ try{ await ensureUsersCareerRelaxed(); }catch(_){ } })();
  (async()=>{ try{ await ensureFinalsTable(); }catch(_){ } })();
  (async()=>{ try{ await ensureFinalsSchema(); }catch(_){ } })();
  (async()=>{ try{ await ensureCursadasTables(); }catch(_){ } })();
  (async()=>{ try{ await ensureCorrelativesEdgesTable(); }catch(_){ } })();

  /* =========================================================
   *        C O R R E L A T I V A S   (UPLOAD .TXT) (ADMIN)
   * ========================================================= */

  router.post('/correlativas/upload', upload.single('correlativas'), async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).send('Solo administrador');
      }
      if (!req.file || !req.file.buffer){
        return res.status(400).send('Falta archivo .txt');
      }

      const text = req.file.buffer.toString('utf-8');
      const blocks = parseCorrelativasTxt(text);

      const defaultCareer = req.user?.career ? normalizeCareer(req.user.career) : '';
      const defaultPlan   = req.user?.plan ? String(req.user.plan) : '';

      for (const b of blocks){
        if (!b.career) b.career = defaultCareer;
        if (!b.plan)   b.plan   = defaultPlan;
      }

      if (!blocks.length){
        return res.status(400).send('Formato vacío o inválido');
      }

      const { updatedSubjects, insertedEdges, notFoundSubjects, missReqs } =
        await upsertCorrelativasEdgesFromBlocks(blocks);

      const wantsJson = (req.headers.accept||'').includes('application/json') ||
                        (req.headers['content-type']||'').includes('application/json');
      if (wantsJson){
        return res.json({
          ok:true,
          updatedSubjects,
          insertedEdges,
          notFoundSubjects,
          missReqs
        });
      }

      const q = new URLSearchParams({
        ok:'1',
        subj:String(updatedSubjects),
        edges:String(insertedEdges),
        nf:String(notFoundSubjects.length),
        mr:String(missReqs.length)
      }).toString();

      return res.redirect('/app/correlativas?' + q);
    }catch(err){
      console.error('❌ correlativas/upload error:', err);
      return res.status(500).send('Error procesando correlativas');
    }
  });

  /* =========================================================
   *        C A R R E R A S  → crear/listar/borrar (solo admin)
   * ========================================================= */

  router.post('/careers/create', upload.single('subjectsFile'), async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).send('Solo administrador');
      }

      await ensureSubjectsPlanRelaxed();

      const careerName = String(req.body.career_name || '').trim();
      const plan      = parseInt(req.body.plan, 10);
      if (!careerName || !Number.isFinite(plan)){
        return res.status(400).send('Faltan datos (nombre/plan)');
      }
      if (!req.file || !req.file.buffer){
        return res.status(400).send('Falta archivo .txt');
      }

      const career = normalizeCareer(careerName);
      const txt = req.file.buffer.toString('utf-8');

      const lines = txt.replace(/\r\n/g,'\n').split('\n').map(s=>s.trim()).filter(Boolean);

      const parsed = [];
      const rx = /^(.*?)[\s\-–—]+año\s*([1-9]\d*)$/i;
      const rx2= /^(.*?)\s*-\s*([1-9]\d*)$/i;
      for (const ln of lines){
        let name='', yearStr='';
        const m = ln.match(rx);
        if (m){
          name = m[1].trim();
          yearStr = m[2].trim();
        }else{
          const m2 = ln.match(rx2);
          if (m2){
            name = m2[1].trim();
            yearStr = m2[2].trim();
          }
        }
        const year = parseInt(yearStr, 10);
        if (name && Number.isFinite(year)) parsed.push({ name, year });
      }
      if (!parsed.length){
        return res.status(400).send('No se reconocieron líneas con formato "Materia - Año X"');
      }

      let created=0, updated=0;
      for (const it of parsed){
        const exists = await get(
          `SELECT id, year FROM subjects WHERE LOWER(name)=LOWER(?) AND LOWER(career)=LOWER(?) AND plan=?`,
          [it.name, career, plan]
        );
        if (exists && exists.id){
          if (parseInt(exists.year,10)!==it.year){
            await run(`UPDATE subjects SET year=? WHERE id=?`, [it.year, exists.id]);
          }
          updated++;
        } else {
          await run(
            `INSERT INTO subjects (name, year, career, plan) VALUES (?,?,?,?)`,
            [it.name, it.year, career, plan]
          );
          created++;
        }
      }

      const wantsJson = (req.headers.accept||'').includes('application/json') ||
                        (req.headers['content-type']||'').includes('application/json');
      if (wantsJson){
        return res.json({ ok:true, created, updated, career, plan, total: parsed.length });
      }

      const q = new URLSearchParams({
        ok:'1', created:String(created), updated:String(updated), career, plan:String(plan)
      }).toString();
      return res.redirect('/app/materias?' + q);
    }catch(e){
      if (String(e && e.message || '').includes('CHECK constraint failed') && String(e.message).includes('plan IN (7,8)')){
        return res.status(400).send('El esquema de la base restringe el plan a (7,8). Ya agregamos una migración automática para quitarlo, pero falló. Revisá permisos del archivo .sqlite o ejecutá manualmente la migración.');
      }
      console.error('❌ /admin/careers/create error:', e);
      return res.status(500).send('Error creando carrera: ' + (e.message||''));
    }
  });

  router.get('/careers/list', async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).json({ ok:false, error:'Solo administrador' });
      }
      const rows = await all(
        `SELECT career, plan, COUNT(*) AS subjects
           FROM subjects
          GROUP BY career, plan
          ORDER BY career, plan`
      );
      return res.json({ ok:true, items: rows.map(r => ({
        career: r.career,
        plan: Number(r.plan),
        subjects: Number(r.subjects)
      })) });
    }catch(e){
      console.error('GET /admin/careers/list error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo listar carreras' });
    }
  });

  router.delete('/careers', async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).json({ ok:false, error:'Solo administrador' });
      }
      const career = normalizeCareer(String(req.body.career || '').trim());
      const plan   = parseInt(req.body.plan, 10);
      if (!career || !Number.isFinite(plan)){
        return res.status(400).json({ ok:false, error:'career/plan inválidos' });
      }

      const subs = await all(
        `SELECT id FROM subjects WHERE LOWER(career)=LOWER(?) AND plan=?`,
        [career, plan]
      );
      if (!subs.length){
        return res.json({ ok:true, deletedSubjects:0, deletedDocs:0, deletedEdges:0 });
      }

      const ids = subs.map(s=>s.id);
      let deletedDocs = 0;

      await run('BEGIN');
      try{
        const docs = await all(`SELECT id, filename FROM documents WHERE subject_id IN (${ids.map(()=>'?').join(',')})`, ids);
        for (const d of docs){
          if (d && d.filename){
            try{ await safeUnlinkMany(d.filename); }catch(_){}
          }
        }
        await run(`DELETE FROM documents WHERE subject_id IN (${ids.map(()=>'?').join(',')})`, ids);
        deletedDocs = docs.length;

        await run(
          `DELETE FROM correlatives_edges
            WHERE subject_id IN (${ids.map(()=>'?').join(',')})
               OR depends_on_id IN (${ids.map(()=>'?').join(',')})`,
          [...ids, ...ids]
        ).catch(()=>{});

        await run(`DELETE FROM subjects WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);

        await run('COMMIT');
      }catch(e){
        await run('ROLLBACK').catch(()=>{});
        throw e;
      }

      return res.json({
        ok:true,
        deletedSubjects: ids.length,
        deletedDocs,
        deletedEdges:'ok'
      });
    }catch(e){
      console.error('DELETE /admin/careers error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo borrar la carrera' });
    }
  });

  /* =========================================================
   *               U S U A R I O S   (ADMIN)
   * ========================================================= */

  router.get('/users', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const like = `%${q}%`;
      const rows = await all(
        `
        SELECT id, name, email, phone, role, career, plan, created_at, terms_accepted_at, privacy_accepted_at
        FROM users
        WHERE (? = '' OR
              LOWER(name)   LIKE ? OR
              LOWER(email)  LIKE ? OR
              LOWER(career) LIKE ? OR
              CAST(plan AS TEXT) LIKE ? OR
              COALESCE(phone,'') LIKE ?)
        ORDER BY datetime(created_at) DESC, id DESC
        `,
        [ q === '' ? '' : q, like, like, like, like, like ]
      );
      return res.json({ ok: true, users: rows });
    } catch (e) {
      console.error('GET /admin/users error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo listar usuarios' });
    }
  });

  router.put('/users/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok:false, error:'ID inválido' });

      const name    = String(req.body.name    || '').trim();
      const email   = String(req.body.email   || '').trim().toLowerCase();
      const phone   = String(req.body.phone   || '').trim();
      const career  = normalizeCareer(String(req.body.career || '').trim());
      const plan    = parseInt(String(req.body.plan || '').trim(), 10) || 0;
      const newPass = String(req.body.password || '').trim();

      if (!name || !email || !career || !plan) {
        return res.status(400).json({ ok:false, error:'Faltan campos' });
      }

      const validCombo = await get(
        `SELECT 1 AS ok FROM subjects WHERE LOWER(career)=LOWER(?) AND plan=? LIMIT 1`,
        [career, plan]
      );
      if (!validCombo) {
        return res.status(400).json({
          ok:false,
          error:`El plan ${plan} no existe para la carrera "${career}"`
        });
      }

      if (newPass) {
        const hash = await bcrypt.hash(newPass, 10);
        await run(
          `UPDATE users SET name=?, email=?, phone=?, career=?, plan=?, pass_hash=? WHERE id=?`,
          [name, email, phone, career, plan, hash, id]
        );
      } else {
        await run(
          `UPDATE users SET name=?, email=?, phone=?, career=?, plan=? WHERE id=?`,
          [name, email, phone, career, plan, id]
        );
      }

      const row = await get(
        `SELECT id, name, email, phone, role, career, plan, created_at, terms_accepted_at, privacy_accepted_at FROM users WHERE id=?`,
        [id]
      );

      if (req.user && parseInt(String(req.user.id), 10) === id) {
        req.user.name   = row.name;
        req.user.email  = row.email;
        req.user.career = row.career;
        req.user.plan   = row.plan;

        if (req.session && req.session.user) {
          req.session.user.name   = row.name;
          req.session.user.email  = row.email;
          req.session.user.career = row.career;
          req.session.user.plan   = row.plan;
        }
      }

      return res.json({ ok:true, user: row });
    } catch (e) {
      console.error('PUT /admin/users/:id error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo actualizar el usuario' });
    }
  });

  router.delete('/users/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok:false, error:'ID inválido' });

      const row = await get(`SELECT id, role FROM users WHERE id=?`, [id]);
      if (!row) return res.status(404).json({ ok:false, error:'Usuario no encontrado' });

      if (String(row.role || '') === 'admin') {
        return res.status(400).json({ ok:false, error:'No se puede eliminar un administrador' });
      }

      await run(`DELETE FROM users WHERE id=?`, [id]);
      return res.json({ ok:true, deleted: id });
    } catch (e) {
      console.error('DELETE /admin/users/:id error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo eliminar el usuario' });
    }
  });

  /* =========================================================
   *               M A T E R I A S   (ADMIN)
   * ========================================================= */

  router.post('/materias', async (req, res) => {
    try {
      const { name, year, career, plan } = req.body;
      if (!name || !year || !career || !plan) {
        return res.status(400).send('Faltan campos obligatorios');
      }
      const nm = String(name).trim();
      const ck = canonKey(nm);

      await run(
        `INSERT INTO subjects (name, subject_name, canonical_key, year, career, plan) VALUES (?,?,?,?,?,?)`,
        [ nm, nm, ck, parseInt(year,10), normalizeCareer(career), parseInt(plan,10) ]
      );
      return res.redirect('/app/materias');
    } catch (err) {
      console.error('❌ Error creando materia:', err);
      return res.status(500).send('Error creando materia');
    }
  });

  router.post('/subjects/:id/update', async (req, res) => {
    try {
      const { name, year, career, plan } = req.body;
      const subject = await get(`SELECT * FROM subjects WHERE id=?`, [req.params.id]);
      if (!subject) return res.status(404).send('Materia no encontrada');

      const newName   = name   !== undefined ? String(name).trim()     : subject.name;
      const newYear   = year   !== undefined ? parseInt(year,10)       : subject.year;
      const newCareer = career !== undefined ? normalizeCareer(career) : subject.career;
      const newPlan   = plan   !== undefined ? parseInt(plan,10)       : subject.plan;

      const ck = canonKey(newName);
      await run(`UPDATE subjects SET name=?, subject_name=?, canonical_key=?, year=?, career=?, plan=? WHERE id=?`,
        [newName, newName, ck, newYear, newCareer, newPlan, req.params.id]);

      return res.redirect(req.query.redirect || '/app/materias');
    } catch (err) {
      console.error('❌ Error actualizando materia:', err);
      return res.status(500).send('Error actualizando materia');
    }
  });

  router.post('/subjects/:id/delete', async (req, res) => {
    try {
      const sid  = String(req.params.id);
      const docs = await all(`SELECT id, filename FROM documents WHERE subject_id=?`, [sid]);

      for (const d of docs) {
        if (d && d.filename) {
          try { await safeUnlinkMany(d.filename); } catch(_) {}
        }
        try { await run(`DELETE FROM documents WHERE id=?`, [d.id]); } catch(_) {}
      }

      await run(`DELETE FROM correlatives_edges WHERE subject_id=? OR depends_on_id=?`, [sid, sid]).catch(()=>{});

      await run(`DELETE FROM subjects WHERE id=?`, [sid]);
      return res.redirect(req.query.redirect || '/app/materias');
    } catch (err) {
      console.error('❌ Error eliminando materia:', err);
      return res.status(500).send('Error eliminando materia');
    }
  });

  /* =========================================================
   *            D O C U M E N T O S   (ADMIN)
   * ========================================================= */

  router.post('/docs/:id/rename', async (req, res) => {
    try {
      const { title } = req.body;
      if (title === undefined) return res.status(400).send('Falta el título');
      const doc = await get(`SELECT id FROM documents WHERE id=?`, [req.params.id]);
      if (!doc) return res.status(404).send('Documento no encontrado');

      await run(`UPDATE documents SET title=? WHERE id=?`, [String(title).trim(), req.params.id]);

      if ((req.headers['content-type'] || '').includes('application/json')) {
        return res.json({ ok:true });
      }
      return res.redirect(req.query.redirect || '/app/materias');
    } catch (err) {
      console.error('❌ Error renombrando documento:', err);
      return res.status(500).send('Error renombrando documento');
    }
  });

  router.post('/docs/:id/delete', async (req, res) => {
    try {
      const doc = await get(`SELECT id, filename FROM documents WHERE id=?`, [req.params.id]);
      if (doc) {
        if (doc.filename) {
          try { await safeUnlinkMany(doc.filename); } catch(_){}
          try {
            const key = String(doc.filename || '');
            if (key.startsWith('docs/')) await r2DeleteKey(key);
          } catch(e) {
            console.warn('[admin delete-doc] no se pudo borrar en R2:', e.message);
          }
        }
        await run(`DELETE FROM documents WHERE id=?`, [req.params.id]);
      }

      if ((req.headers.accept || '').includes('application/json')) {
        return res.json({ ok:true });
      }
      return res.redirect(req.query.redirect || '/app/materias');
    } catch (err) {
      console.error('❌ Error eliminando documento:', err);
      return res.status(500).send('Error eliminando documento');
    }
  });

  // =========================
  // Admin: ver texto de un documento (para Definiciones)
  // =========================
  router.get('/doc-text', async (req, res) => {
    try{
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ ok:false, error:'Falta id' });

      const doc = await get(`SELECT id, title, filename, mimetype FROM documents WHERE id=?`, [id]);
      if (!doc) return res.status(404).json({ ok:false, error:'Documento no encontrado' });

      const key = String(doc.filename || '');
      if (!key) return res.status(400).json({ ok:false, error:'Documento sin key' });

      const name = key.toLowerCase();
      const mt = String(doc.mimetype || '').toLowerCase();
      if (!name.endsWith('.txt') && mt !== 'text/plain') {
        return res.status(400).json({ ok:false, error:'Solo disponible para .txt' });
      }

      const text = await r2ReadText(key);
      return res.json({ ok:true, title: doc.title || 'Texto', text });
    }catch(err){
      console.error('GET /admin/doc-text error:', err);
      return res.status(500).json({ ok:false, error:'Error leyendo texto' });
    }
  });

  router.post('/delete-doc', async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || '').trim();
      if (!id) return res.status(400).json({ ok:false, error:'Falta id' });

      const doc = await get(`SELECT id, filename FROM documents WHERE id=?`, [id]);
      if (!doc) return res.status(404).json({ ok:false, error:'Documento no encontrado' });

      if (doc.filename) { try { await safeUnlinkMany(doc.filename); } catch(_){} }
      await run(`DELETE FROM documents WHERE id=?`, [id]);

      return res.json({ ok:true });
    } catch (e) {
      console.error('POST /admin/delete-doc error:', e);
      return res.status(500).json({ ok:false, error:'Error eliminando' });
    }
  });

  router.post('/rename-group', async (req, res) => {
    try {
      const { group_uid, title } = req.body;
      if (!group_uid || !title) return res.status(400).send('Parámetros inválidos');
      await run(`UPDATE documents SET title=? WHERE group_uid=?`, [String(title).trim(), group_uid]);
      return res.json({ ok:true });
    } catch (e) {
      console.error('Error rename-group:', e);
      return res.status(500).send('Error');
    }
  });

  router.post('/delete-group', async (req, res) => {
    try {
      const { group_uid } = req.body;
      if (!group_uid) return res.status(400).send('group_uid requerido');

      const docs = await all(`SELECT id, filename FROM documents WHERE group_uid=?`, [group_uid]);
      let removedFiles = 0;
      for (const d of docs) {
        if (d && d.filename) {
          try { const ok = await safeUnlinkMany(d.filename); if (ok) removedFiles++; } catch(_) {}
        }
        try { await run(`DELETE FROM documents WHERE id=?`, [d.id]); } catch(_) {}
      }
      return res.json({ ok:true, deleted: docs.length, removedFiles });
    } catch (e) {
      console.error('Error delete-group:', e);
      return res.status(500).send('Error');
    }
  });

  /* =========================================================
   *            F I N A L E S  /  C U R S A D A S   (ADMIN)
   * ========================================================= */

  router.post('/finales/upload', upload.single('finalesFile'), async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).send('Solo administrador');
      }
      if (!req.file || !req.file.buffer){
        return res.status(400).send('Falta archivo .txt');
      }

      await ensureFinalsSchema();

      const parsed = parseFinalesTxt(req.file.buffer.toString('utf-8'));

      if (!parsed.length){
        return res.status(400).send('El archivo de finales está vacío o tiene formato inválido.');
      }

      const normalizeFinalKey = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      const dedupMap = new Map();

      for (const item of parsed){
        const subjectName = String(item.materia || '').trim();
        if (!subjectName) continue;

        const yearValue = Number(item.year || 0) || 0;
        const key = `${yearValue}::${normalizeFinalKey(subjectName)}`;

        if (!dedupMap.has(key)) {
          dedupMap.set(key, {
            materia: subjectName,
            year: yearValue || null,
            regular: String(item.regular || '').trim(),
            libre: String(item.libre || '').trim(),
            permiteLibre: !!item.permiteLibre,
            probRegular: Number(item.probRegular || 0) || 0,
            probLibre: Number(item.probLibre || 0) || 0,
            topUnits: Array.isArray(item.topUnits) ? item.topUnits.slice(0, 5) : [],
            bestMonths: Array.isArray(item.bestMonths) ? item.bestMonths : [],
            worstMonths: Array.isArray(item.worstMonths) ? item.worstMonths : []
          });
          continue;
        }

        const prev = dedupMap.get(key);

        dedupMap.set(key, {
          materia: prev.materia,
          year: prev.year || (yearValue || null),
          regular: prev.regular || String(item.regular || '').trim(),
          libre: prev.libre || String(item.libre || '').trim(),
          permiteLibre: prev.permiteLibre || !!item.permiteLibre,
          probRegular: Math.max(prev.probRegular || 0, Number(item.probRegular || 0) || 0),
          probLibre: Math.max(prev.probLibre || 0, Number(item.probLibre || 0) || 0),
          topUnits: [...new Set([...(prev.topUnits || []), ...((Array.isArray(item.topUnits) ? item.topUnits : []).slice(0, 5))])].slice(0, 5),
          bestMonths: [...new Set([...(prev.bestMonths || []), ...(Array.isArray(item.bestMonths) ? item.bestMonths : [])])],
          worstMonths: [...new Set([...(prev.worstMonths || []), ...(Array.isArray(item.worstMonths) ? item.worstMonths : [])])]
        });
      }

      const cleanItems = Array.from(dedupMap.values());

      await run(`DELETE FROM finals`);

      for (const item of cleanItems){
        const yearValue = Number(item.year || 0) || null;
        const matchedSubjects = await findSubjectsByNameGlobal(item.materia, yearValue);
        const primarySubject = matchedSubjects.length ? matchedSubjects[0] : null;

        await run(
          `INSERT INTO finals (
            career, plan, subject_id, subject, year, modalidad, libre, regular,
            exam_type, rendible, prob_regular, prob_libre,
            top_units_json, best_months, worst_months, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
          [
            '',
            0,
            primarySubject ? Number(primarySubject.id) : null,
            String(item.materia || '').trim(),
            yearValue || (primarySubject ? Number(primarySubject.year || 0) || null : null),
            item.permiteLibre ? 'libre y regular' : 'regular',
            String(item.libre || '').trim(),
            String(item.regular || '').trim(),
            'escrito y oral',
            item.permiteLibre ? 1 : 0,
            Number(item.probRegular || 0) || 0,
            item.permiteLibre ? (Number(item.probLibre || 0) || 0) : 0,
            JSON.stringify(item.topUnits || []),
            (item.bestMonths || []).join(' | '),
            (item.worstMonths || []).join(' | ')
          ]
        );
      }

      const qs = new URLSearchParams({
        ok: '1',
        loaded: String(cleanItems.length),
        missing: '0'
      }).toString();

      return res.redirect('/app/finales?' + qs);
    }catch(e){
      console.error('POST /admin/finales/upload error:', e);
      return res.status(500).send('Error procesando el archivo de finales');
    }
  });

    async function findSubjectByNameForCareerPlan(subjectName, career, plan){
    const wantedRaw = String(subjectName || '').trim();
    if (!wantedRaw) return null;

    const careerNorm = normalizeCareer(career || '');
    const planNorm = parseInt(plan || '7', 10) || 7;

    const rows = await all(
      `SELECT id, name, subject_name, canonical_key, year, career, plan
        FROM subjects
        WHERE COALESCE(career, '') = ?
          AND COALESCE(plan, 7) = ?
        ORDER BY COALESCE(year, 99), name, id`,
      [careerNorm, planNorm]
    );

    if (!Array.isArray(rows) || !rows.length) return null;

    const wanted = canonKey(wantedRaw);
    const wantedNoParens = canonKey(stripParens(wantedRaw));

    let match =
      rows.find(r => canonKey(r.name || '') === wanted) ||
      rows.find(r => canonKey(r.subject_name || '') === wanted) ||
      rows.find(r => canonKey(r.canonical_key || '') === wanted);

    if (match) return match;

    match =
      rows.find(r => canonKey(stripParens(r.name || '')) === wantedNoParens) ||
      rows.find(r => canonKey(stripParens(r.subject_name || '')) === wantedNoParens) ||
      rows.find(r => canonKey(stripParens(r.canonical_key || '')) === wantedNoParens);

    if (match) return match;

    match =
      rows.find(r => canonKey(r.name || '').includes(wanted)) ||
      rows.find(r => canonKey(r.subject_name || '').includes(wanted)) ||
      rows.find(r => canonKey(r.canonical_key || '').includes(wanted)) ||
      rows.find(r => wanted.includes(canonKey(r.name || ''))) ||
      rows.find(r => wanted.includes(canonKey(r.subject_name || ''))) ||
      rows.find(r => wanted.includes(canonKey(r.canonical_key || '')));

    if (match) return match;

    return null;
  }

  router.post('/cursadas/upload', upload.single('cursadasFile'), async (req, res) => {
  try{
    if (!req.user || req.user.role !== 'admin'){
      return res.status(403).send('Solo administrador');
    }
    if (!req.file || !req.file.buffer){
      return res.status(400).send('Falta archivo .txt');
    }

    await ensureCursadasTables();

    const parsed = parseCursadasTxt(req.file.buffer.toString('utf-8'));

    if (!parsed.length){
      return res.status(400).send('El archivo de cursadas está vacío o tiene formato inválido.');
    }

    const normalizeKey = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    const dedupMap = new Map();

    for (const item of parsed){
      const key = [
        normalizeKey(item.materia),
        Number(item.year || 0) || 0,
        normalizeKey(item.commission || '')
      ].join('::');

      if (!dedupMap.has(key)) {
        dedupMap.set(key, {
          materia: String(item.materia || '').trim(),
          year: Number(item.year || 0) || null,
          commission: String(item.commission || '').trim(),
          scheduleText: String(item.scheduleText || '').trim(),
          approvalPct: Number(item.approvalPct || 0) || 0,
          promotionPct: Number(item.promotionPct || 0) || 0,
          classType: String(item.classType || '').trim(),
          teachers: Array.isArray(item.teachers) ? item.teachers.slice(0, 4) : []
        });
        continue;
      }

      const prev = dedupMap.get(key);

      dedupMap.set(key, {
        materia: prev.materia,
        year: prev.year || (Number(item.year || 0) || null),
        commission: prev.commission || String(item.commission || '').trim(),
        scheduleText: prev.scheduleText || String(item.scheduleText || '').trim(),
        approvalPct: Math.max(prev.approvalPct || 0, Number(item.approvalPct || 0) || 0),
        promotionPct: Math.max(prev.promotionPct || 0, Number(item.promotionPct || 0) || 0),
        classType: prev.classType || String(item.classType || '').trim(),
        teachers: [...new Set([...(prev.teachers || []), ...((Array.isArray(item.teachers) ? item.teachers : []).slice(0, 4))])].slice(0, 4)
      });
    }

    const rows = Array.from(dedupMap.values());

    await run(`DELETE FROM cursada_reactions`);
    await run(`DELETE FROM cursadas`);

    for (const row of rows){
      await run(
        `INSERT INTO cursadas (
          career, plan, subject_id, subject, year, commission, schedule_text,
          approval_pct, promotion_pct, class_type, teachers_json,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [
          '',
          0,
          null,
          row.materia,
          row.year,
          row.commission,
          row.scheduleText,
          row.approvalPct,
          row.promotionPct,
          row.classType,
          JSON.stringify(row.teachers || [])
        ]
      );
    }

    const qs = new URLSearchParams({
      ok: '1',
      loaded: String(rows.length),
      missing: '0'
    }).toString();

    return res.redirect('/app/cursadas?' + qs);
  }catch(e){
    console.error('POST /admin/cursadas/upload error:', e);
    return res.status(500).send('Error procesando el archivo de cursadas');
  }
});

  /* =========================================================
   *        C H A T B O T   K B   (ADMIN upload)
   * ========================================================= */

  // Parsea el .txt del chatbot en un árbol de categorías/preguntas/respuestas
  // Formato:
  //   # Título de categoría
  //   ? Pregunta del usuario
  //   = Respuesta del bot
  function parseChatbotTxt(raw) {
    const lines = String(raw || '').split(/\r?\n/);
    const categories = [];
    let currentCat = null;
    let currentQ = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;

      if (line.startsWith('# ')) {
        currentCat = { title: line.slice(2).trim(), questions: [] };
        categories.push(currentCat);
        currentQ = null;
      } else if (line.startsWith('? ') && currentCat) {
        currentQ = { question: line.slice(2).trim(), answer: '' };
        currentCat.questions.push(currentQ);
      } else if (line.startsWith('= ') && currentQ) {
        currentQ.answer += (currentQ.answer ? '\n' : '') + line.slice(2).trim();
      }
    }
    return categories;
  }

  const chatbotUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
  });

  router.post('/chatbot/upload', chatbotUpload.single('chatbotFile'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: 'No se envió archivo' });

      const name = String(req.file.originalname || '').toLowerCase();
      if (!name.endsWith('.txt')) {
        return res.status(400).json({ ok: false, error: 'Solo se aceptan archivos .txt' });
      }

      const raw = req.file.buffer.toString('utf-8');
      const kb = parseChatbotTxt(raw);

      await run(`
        CREATE TABLE IF NOT EXISTS chatbot_kb (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          raw_text TEXT NOT NULL,
          kb_json TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);

      // Borrar todo lo anterior y guardar solo el nuevo
      await run(`DELETE FROM chatbot_kb`);
      await run(
        `INSERT INTO chatbot_kb (raw_text, kb_json, updated_at) VALUES (?, ?, datetime('now'))`,
        [raw, JSON.stringify(kb)]
      );

      return res.json({ ok: true, categories: kb.length });
    } catch (e) {
      console.error('POST /admin/chatbot/upload error:', e);
      return res.status(500).json({ ok: false, error: 'Error procesando el archivo' });
    }
  });

  return router;
};