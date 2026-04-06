﻿const express = require('express');
const { all, get, run } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');
const { loadQuestionsDb, loadQuestionsAnyPlanDb, loadQuestionsCanonicalDb, shuffleInPlace } = require('../lib/questions');
const { S3Client, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// ===== R2 helper (para Definiciones/TXT) =====
function normStr(v){ return String(v ?? '').trim(); }

const R2_ENDPOINT = normStr(process.env.R2_ENDPOINT);
const R2_BUCKET = normStr(process.env.R2_BUCKET);
const R2_ACCESS_KEY_ID = normStr(process.env.R2_ACCESS_KEY_ID);
const R2_SECRET_ACCESS_KEY = normStr(process.env.R2_SECRET_ACCESS_KEY);

const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

function hasR2(){
  return !!(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
}

const SUBJECT_BASE_COLUMNS = `
  id,
  career,
  plan,
  year,
  semester,
  name,
  subject_name,
  canonical_key
`;

async function r2GetText(key){
  const out = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const chunks = [];
  for await (const ch of out.Body) chunks.push(Buffer.from(ch));
  return Buffer.concat(chunks).toString('utf-8');
}

async function r2Delete(key){
  if (!hasR2()) return;
  try { await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); } catch (_) {}
}
function buildDocumentDownloadUrl(doc){
  const key = String(doc?.filename || '').split('#')[0].trim();
  const urlDb = String(doc?.url || '').split('#')[0].trim();

  if (key){
    if (/^https?:\/\//i.test(key)) return `/pdf-view/r2?url=${encodeURIComponent(key)}&download=1`;
    if (key.startsWith('/uploads/')) return key;
    return `/pdf-view/r2?key=${encodeURIComponent(key)}&download=1`;
  }

  if (urlDb) {
    if (/^https?:\/\//i.test(urlDb)) return `/pdf-view/r2?url=${encodeURIComponent(urlDb)}&download=1`;
    if (urlDb.startsWith('/uploads/')) return urlDb;
    return `/pdf-view/r2?key=${encodeURIComponent(urlDb)}&download=1`;
  }
  return '';
}
function normKey(s){
  s = String(s ?? '').trim().toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch {}
  return s;
}


// ===== fuzzy helpers (para tolerar errores, sin tildes, etc.) =====
function cleanMatch(s){
  s = normKey(s);
  // reemplaza todo lo no alfanumerico por espacio y colapsa
  s = s.replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  return s;
}

function levenshtein(a,b){
  a = cleanMatch(a); b = cleanMatch(b);
  if (!a || !b) return Math.max(a.length, b.length);
  const n=a.length, m=b.length;
  if (n===0) return m;
  if (m===0) return n;

  let prev = new Array(m+1);
  let cur  = new Array(m+1);
  for (let j=0;j<=m;j++) prev[j]=j;

  for (let i=1;i<=n;i++){
    cur[0]=i;
    const ca=a.charCodeAt(i-1);
    for (let j=1;j<=m;j++){
      const cost = (ca===b.charCodeAt(j-1)) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + cost);
    }
    const tmp=prev; prev=cur; cur=tmp;
  }
  return prev[m];
}

function similarity(a,b){
  a = cleanMatch(a); b = cleanMatch(b);
  if (!a || !b) return 0;
  const d = levenshtein(a,b);
  const L = Math.max(a.length, b.length) || 1;
  return 1 - (d / L);
}

function tokensOf(s){
  const t = cleanMatch(s).split(' ').filter(Boolean);
  const stop = new Set(['de','del','la','el','y','en','un','una','los','las','para','por','a']);
  return t.filter(x=>!stop.has(x));
}

function tokenSubsetScore(q, cand){
  const qt=tokensOf(q);
  const ct=new Set(tokensOf(cand));
  if (qt.length===0) return 0;
  let hit=0;
  for (const w of qt) if (ct.has(w)) hit++;
  return hit/qt.length;
}

function bestFuzzyMatch(q, candidates, getText){
  let best=null;
  for (const c of candidates){
    const t=getText(c);
    const sim=similarity(q, t);
    const tok=tokenSubsetScore(q, t);
    const score=(sim*0.75) + (tok*0.25);
    if (!best || score>best.score) best={ c, score, sim, tok };
  }
  return best;
}



function parseDefsTxt(raw){
  const lines = String(raw ?? '').replace(/\r/g,'').split('\n');
  let section = ''; // 'defs' | 'topics'
  const defs = new Map(); // keyNorm -> { title, body }
  const topics = [];      // [{ title, body, titleNorm, fullTextNorm }]

  let curTitle = '';
  let curBody = [];

  function flush(){
    if (!curTitle) return;
    const body = curBody.join('\n').trim();
    if (section === 'defs'){
      const title = curTitle.trim();
      const titleNorm = normKey(title);
      const fullTextNorm = normKey(title + '\n' + body);
      defs.set(titleNorm, { title, body, titleNorm, fullTextNorm });
    } else if (section === 'topics'){
      const title = curTitle.trim();
      const titleNorm = normKey(title);
      const fullTextNorm = normKey(title + '\n' + body);
      topics.push({ title, body, titleNorm, fullTextNorm });
    }
    curTitle = '';
    curBody = [];
  }

  for (const line of lines){
    const h = line.trim();

    if (/^\[(DEFINICIONES|DEFINICION)\]$/i.test(h)){ flush(); section='defs'; continue; }
    if (/^\[(TEMAS|TEMA)\]$/i.test(h)){ flush(); section='topics'; continue; }

    const m = h.match(/^(.+?)\s*:\s*(.*)$/);
    if (m && section){
      flush();
      curTitle = m[1];
      const first = m[2] ?? '';
      if (first) curBody.push(first);
      continue;
    }
    if (section && curTitle) curBody.push(line);
  }
  flush();
  return { defs, topics };
}

// cache (5 min)
const __defsCache = new Map(); // subjectKey -> { ts, parsed }
const __CACHE_MS = 5 * 60 * 1000; // ✅ cache 5 min para no releer/parsing en cada request

const __subjectViewCache = new Map();
const __subjectViewInflight = new Map();
const __classSectionsCache = new Map();
const __SUBJECT_VIEW_CACHE_MS = 20 * 1000;
const __CLASS_SECTIONS_CACHE_MS = 60 * 1000;
let __documentsSchemaFlagsPromise = null;

async function getDocumentsSchemaFlags(){
  if (__documentsSchemaFlagsPromise) return __documentsSchemaFlagsPromise;

  __documentsSchemaFlagsPromise = (async () => {
    const rows = await all(`SELECT name FROM pragma_table_info('documents')`);
    const names = new Set((rows || []).map(r => String(r.name || '')));
    return {
      hasSubcategory: names.has('subcategory'),
      hasLevel: names.has('level'),
      hasGroupUid: names.has('group_uid'),
      hasDocGroup: names.has('doc_group'),
      hasSubjectKey: names.has('subject_key')
    };
  })().catch((err) => {
    __documentsSchemaFlagsPromise = null;
    throw err;
  });

  return __documentsSchemaFlagsPromise;
}

function cloneSubjectCacheValue(value){
  return JSON.parse(JSON.stringify(value));
}

async function getCachedSubjectView(key, builder){
  const now = Date.now();
  const hit = __subjectViewCache.get(key);
  if (hit && (now - hit.ts) < __SUBJECT_VIEW_CACHE_MS) {
    return cloneSubjectCacheValue(hit.value);
  }

  if (__subjectViewInflight.has(key)) {
    const inflightValue = await __subjectViewInflight.get(key);
    return cloneSubjectCacheValue(inflightValue);
  }

  const promise = (async () => {
    const built = await builder();
    __subjectViewCache.set(key, { ts: Date.now(), value: cloneSubjectCacheValue(built) });

    if (__subjectViewCache.size > 300) {
      const oldestKey = __subjectViewCache.keys().next().value;
      if (oldestKey) __subjectViewCache.delete(oldestKey);
    }

    return built;
  })();

  __subjectViewInflight.set(key, promise);

  try {
    const value = await promise;
    return cloneSubjectCacheValue(value);
  } finally {
    __subjectViewInflight.delete(key);
  }
}

async function getCachedClassSections(subjectKey){
  const key = String(subjectKey || '').trim();
  const now = Date.now();
  const hit = __classSectionsCache.get(key);

  if (hit && (now - hit.ts) < __CLASS_SECTIONS_CACHE_MS) {
    return cloneSubjectCacheValue(hit.value);
  }

  const rows = await all(
    `SELECT MIN(cs.id) AS id, cs.name AS name
       FROM classes_sections cs
       JOIN subjects s ON s.id = cs.subject_id
      WHERE s.canonical_key = ?
      GROUP BY cs.name
      ORDER BY MIN(cs.id) ASC`,
    [key]
  );

  __classSectionsCache.set(key, { ts: now, value: cloneSubjectCacheValue(rows) });
  return cloneSubjectCacheValue(rows);
}

async function getSubjectKeyById(subjectId){
  const row = await get(
    `SELECT COALESCE(NULLIF(canonical_key,''), '') AS canonical_key,
            COALESCE(NULLIF(subject_name,''), NULLIF(name,'')) AS nm
       FROM subjects
      WHERE id=?`,
    [subjectId]
  );
  const ck = String(row?.canonical_key || '').trim();
  if (ck) return ck;
  return cleanMatch(row?.nm || '');
}
function bustSubjectCaches(subjectKey){
  const key = String(subjectKey || '').trim();
  if (key) __classSectionsCache.delete(key);
  __subjectViewCache.clear();
  __subjectViewInflight.clear();
}
  async function loadDefsForSubjectKey(subjectKey){
  const now = Date.now();
  const k = String(subjectKey || '').trim();
  const cached = __defsCache.get(k);
  if (cached && (now - cached.ts) < __CACHE_MS) return cached.parsed;

  const rows = await all(
    `SELECT d.filename AS filename
      FROM documents d
      WHERE COALESCE(NULLIF(d.subject_key,''), '') = ?
        AND d.category='definiciones'
      ORDER BY d.id DESC`,
    [k]
  );

  let combined = '';
  if (hasR2()) {
    for (const r of rows){
      const key = r.filename;
      if (!key) continue;
      const txt = await r2GetText(key);
      combined += '\n\n' + txt;
    }
  }

  const parsed = parseDefsTxt(combined);
  __defsCache.set(k, { ts: now, parsed });
  return parsed;
}


module.exports = (deps = {}) => {
  const router = express.Router();

  const ensureAdmin =
    deps.ensureAdmin ||
    ((req, res, next) => {
      if (req.user && req.user.role === 'admin') return next();
      return res.status(403).send('Solo para administradores');
    });

  // Helper: obtener usuario de forma segura
  function safeUser(req) {
    const u = req.user || {};
    return {
      id: u.id ?? 0,
      role: u.role || 'user',
      career: normalizeCareer(u.career || ''),
      plan: Number.isInteger(u.plan) ? u.plan : parseInt(u.plan || '0', 10) || 0
    };
  }
  async function tableHasColumn(tableName, columnName) {
  const rows = await all(`PRAGMA table_info(${tableName})`);
  return Array.isArray(rows) && rows.some(r => String(r.name || '') === String(columnName));
}
    // =========================
  // Suscripciones (solo admin)
  // =========================
  router.get('/suscripciones', ensureAdmin, async (req, res) => {
    try {
      return res.render('suscripciones', {
        title: 'Suscripciones · CleverWave'
      });
    } catch (err) {
      console.error('GET /app/suscripciones error:', err);
      return res.status(500).send('Error cargando suscripciones');
    }
  });
  // =========================
// ✅ Cuenta: actualizar nombre/mail/teléfono/carrera/plan
// POST /app/account/update
// body: { name, email, phone, career, plan }
// =========================
router.post('/account/update', express.json(), async (req, res) => {
  try{
    if (req.user && req.user.role === 'guest') {
      return res.status(403).json({ ok:false, error:'Para usar Configuración necesitás crear una cuenta gratis.' });
    }

    const uid = Number(req.user && req.user.id);
        // ✅ cooldown 24h (persistente en DB)
    await run(`
      CREATE TABLE IF NOT EXISTS account_cooldowns (
        user_id INTEGER PRIMARY KEY,
        name_at  INTEGER,
        email_at INTEGER,
        phone_at INTEGER,
        career_at INTEGER,
        plan_at INTEGER
      )
    `);
    try { await run(`ALTER TABLE account_cooldowns ADD COLUMN phone_at INTEGER`); } catch (_) {}
    if (!uid) return res.status(401).json({ ok:false, error:'No autenticado' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    let name  = String(body.name || '').replace(/\s+/g,' ').trim();
    let email = String(body.email || '').trim();
    let phone = String(body.phone || '').trim().slice(0, 32);
    let career = normalizeCareer(String(body.career || (req.user && req.user.career) || ''));
    let plan = Number.isFinite(Number(body.plan)) ? parseInt(String(body.plan), 10) : (req.user ? parseInt(String(req.user.plan||'0'),10) : 0);

    // nombre: max 11 (como el input)
    if (name.length > 11) name = name.slice(0,11);
    if (!name) return res.status(400).json({ ok:false, error:'Nombre inválido' });

    // mail básico
    if (!email || !/^\S+@\S+\.[A-Za-z]{2,}$/.test(email)) return res.status(400).json({ ok:false, error:'Mail inválido' });
    if (phone && !/^[\d+\-()/\s]{6,32}$/.test(phone)) {
      return res.status(400).json({ ok:false, error:'Teléfono inválido' });
    }

    // plan permitido
        // plan permitido según carrera
    const PLANS_BY_CAREER = {
      'Lic. en Administración de Empresas': [6,7,8],
      'Contabilidad': [6,7],
      'Lic. en Economía': [6,7]
    };
    const allowedPlans = PLANS_BY_CAREER[career] || [6,7];
    if (!allowedPlans.includes(plan)) plan = allowedPlans[0] || 6;

    // email único
    const ex = await get(`SELECT id FROM users WHERE lower(email) = lower(?) AND id != ? LIMIT 1`, [email, uid]);
    if (ex) return res.status(400).json({ ok:false, error:'Ese mail ya está en uso.' });
    const COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const PHONE_COOLDOWN_MS = 72 * 60 * 60 * 1000;
    const now = Date.now();

    const cd = await get(
      `SELECT name_at, email_at, phone_at, career_at, plan_at FROM account_cooldowns WHERE user_id=?`,
      [uid]
    ) || { name_at:null, email_at:null, phone_at:null, career_at:null, plan_at:null };

    function isLocked(ts, windowMs = COOLDOWN_MS){
      if (!ts) return false;
      const t = Number(ts) || 0;
      if (!t) return false;
      return (now - t) < windowMs;
    }

    // valores actuales en DB (para comparar y detectar cambios reales)
    const curDb = await get(
      `SELECT name, email, phone, career, plan FROM users WHERE id=? LIMIT 1`,
      [uid]
    );
    if (!curDb) return res.status(404).json({ ok:false, error:'Usuario no encontrado' });

    const changed = {
      name:  String(curDb.name || '')  !== String(name || ''),
      email: String(curDb.email || '') !== String(email || ''),
      phone: String(curDb.phone || '') !== String(phone || ''),
      career: normalizeCareer(String(curDb.career || '')) !== normalizeCareer(String(career || '')),
      plan:  parseInt(String(curDb.plan || '0'),10) !== parseInt(String(plan || '0'),10)
    };

    // bloqueos 24h
    if (changed.name && isLocked(cd.name_at))   return res.status(429).json({ ok:false, error:'Nombre bloqueado por 24 horas.' });
    if (changed.email && isLocked(cd.email_at)) return res.status(429).json({ ok:false, error:'Mail bloqueado por 24 horas.' });
    if (changed.phone && isLocked(cd.phone_at, PHONE_COOLDOWN_MS)) return res.status(429).json({ ok:false, error:'Teléfono bloqueado por 72 horas.' });
    if (changed.career && isLocked(cd.career_at)) return res.status(429).json({ ok:false, error:'Carrera bloqueada por 24 horas.' });
    if (changed.plan && isLocked(cd.plan_at))   return res.status(429).json({ ok:false, error:'Plan bloqueado por 24 horas.' });
    const sets = [];
    const params = [];

    sets.push('name = ?');
    params.push(name);

    sets.push('email = ?');
    params.push(email);

    sets.push('phone = ?');
    params.push(phone);

    sets.push('career = ?');
    params.push(career);

    sets.push('plan = ?');
    params.push(plan);

    params.push(uid);

    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
        // ✅ setear cooldown solo para los campos que realmente cambiaron
    const upd = [];
    const updParams = [];

    if (changed.name)   { upd.push('name_at=?');   updParams.push(now); }
    if (changed.email)  { upd.push('email_at=?');  updParams.push(now); }
    if (changed.phone)  { upd.push('phone_at=?');  updParams.push(now); }
    if (changed.career) { upd.push('career_at=?'); updParams.push(now); }
    if (changed.plan)   { upd.push('plan_at=?');   updParams.push(now); }

    if (upd.length){
      await run(
        `INSERT INTO account_cooldowns (user_id, name_at, email_at, phone_at, career_at, plan_at)
         VALUES (?, NULL, NULL, NULL, NULL, NULL)
         ON CONFLICT(user_id) DO NOTHING`,
        [uid]
      );

      await run(
        `UPDATE account_cooldowns SET ${upd.join(', ')} WHERE user_id=?`,
        [...updParams, uid]
      );
    }

    // sincronizar req.user + session user
    try{
      if (req.user){
        req.user.name = name;
        req.user.email = email;
        req.user.phone = phone;
        req.user.career = career;
        req.user.plan = plan;
      }
    }catch(_){}
    try{
      if (req.session && req.session.user){
        req.session.user.name = name;
        req.session.user.email = email;
        req.session.user.phone = phone;
        req.session.user.career = career;
        req.session.user.plan = plan;
      }
    }catch(_){}
    try{
      if (req.session && req.session.passport && req.session.passport.user) {
        req.session.passport.user.name = name;
        req.session.passport.user.email = email;
        req.session.passport.user.phone = phone;
        req.session.passport.user.career = career;
        req.session.passport.user.plan = plan;
      }
    }catch(_){}

    return res.json({ ok:true });
  }catch(err){
    console.error('POST /app/account/update error:', err);
    return res.status(500).json({ ok:false, error:'No se pudo guardar' });
  }
});

  // =========================
  // DB helpers (migraciones seguras en runtime)
  // =========================
  async function ensureTable(createSql, label = 'table') {
    try {
      await run(createSql);
    } catch (e) {
      console.warn(`[db] ensure ${label} warning:`, e?.message || e);
    }
  }

  async function hasColumn(table, col) {
    try {
      const row = await get(`SELECT 1 ok FROM pragma_table_info('${table}') WHERE name=?`, [col]);
      return !!row;
    } catch (e) {
      return false;
    }
  }
  async function ensureColumn(table, col, alterSql) {
    try {
      const ok = await hasColumn(table, col);
      if (ok) return true;
      await run(alterSql);
      return true;
    } catch (e) {
      // Si dos instancias corren al mismo tiempo, puede tirar "duplicate column name"
      const msg = String(e?.message || '');
      if (msg.toLowerCase().includes('duplicate column')) return true;
      console.warn(`[db] ensureColumn ${table}.${col} warning:`, msg || e);
      return false;
    }
  }
  
  async function ensureProfessorsSchema(){
    // Tabla base (si no existe)
    await ensureTable(`
      CREATE TABLE IF NOT EXISTS professors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        photo_url TEXT,
        career TEXT,
        plan INTEGER,
        subjects_text TEXT
      )
    `);

    // Migraciones seguras (si existe vieja, agrega columnas faltantes)
    // ⚠️ IMPORTANTE: ensureColumn espera un ALTER TABLE completo (NO "TEXT"/"INTEGER")
    await ensureColumn('professors', 'name', `ALTER TABLE professors ADD COLUMN name TEXT`);
    await ensureColumn('professors', 'photo_url', `ALTER TABLE professors ADD COLUMN photo_url TEXT`);
    await ensureColumn('professors', 'subjects_text', `ALTER TABLE professors ADD COLUMN subjects_text TEXT`);
    await ensureColumn('professors', 'career', `ALTER TABLE professors ADD COLUMN career TEXT`);
    await ensureColumn('professors', 'plan', `ALTER TABLE professors ADD COLUMN plan INTEGER`);

    // ✅ Columna para “mismo profesor en varias materias” sin duplicar perfiles
    await ensureColumn('professors', 'name_norm', `ALTER TABLE professors ADD COLUMN name_norm TEXT`);
        // ✅ Stats manuales editables por admin (promoción / aprobación)
    await ensureColumn('professors', 'promotion_avg', `ALTER TABLE professors ADD COLUMN promotion_avg TEXT`);
    await ensureColumn('professors', 'approval_pct', `ALTER TABLE professors ADD COLUMN approval_pct INTEGER`);

    // Compatibilidad con esquemas viejos (si existían columnas distintas)
    try{
      const cols = await all(`PRAGMA table_info(professors)`);
      const hasNombre  = cols.some(c => c.name === 'nombre');
      const hasAvatar  = cols.some(c => c.name === 'avatar');
      const hasMateria = cols.some(c => c.name === 'materia');

      if (hasNombre){
        await run(`
          UPDATE professors
          SET name = COALESCE(NULLIF(TRIM(name),''), TRIM(nombre))
          WHERE (name IS NULL OR TRIM(name)='') AND nombre IS NOT NULL AND TRIM(nombre)<>'' 
        `);
      }

      if (hasAvatar){
        await run(`
          UPDATE professors
          SET photo_url = COALESCE(NULLIF(TRIM(photo_url),''), TRIM(avatar))
          WHERE (photo_url IS NULL OR TRIM(photo_url)='') AND avatar IS NOT NULL AND TRIM(avatar)<>'' 
        `);
      }

      if (hasMateria){
        await run(`
          UPDATE professors
          SET subjects_text = COALESCE(NULLIF(TRIM(subjects_text),''), TRIM(materia))
          WHERE (subjects_text IS NULL OR TRIM(subjects_text)='') AND materia IS NOT NULL AND TRIM(materia)<>'' 
        `);
      }

      // Si quedaron null/vacíos, set mínimo para evitar fallos aguas abajo
      await run(`
        UPDATE professors
        SET name = 'Sin nombre'
        WHERE name IS NULL OR TRIM(name)=''
      `);

      // ✅ Completar name_norm para filas existentes (si quedó vacío)
      // (requiere que exista una función normName(str) en el mismo archivo)
      try{
        const rows = await all(`SELECT id, name, name_norm FROM professors`);
        for (const r of rows){
          const nn = (r.name_norm && String(r.name_norm).trim()) ? String(r.name_norm).trim() : normName(r.name);
          await run(`UPDATE professors SET name_norm=? WHERE id=?`, [nn, r.id]);
        }
      }catch(e2){
        console.warn('[db] fill name_norm warning:', String(e2?.message || e2));
      }

    }catch(e){
      console.warn('[db] ensureProfessorsSchema compat warning:', String(e?.message || e));
    }

    // Índices útiles (no rompen si ya existen)
    try { await run(`CREATE INDEX IF NOT EXISTS idx_professors_career_plan ON professors(career, plan)`); } catch {}
    try { await run(`CREATE INDEX IF NOT EXISTS idx_professors_name ON professors(name)`); } catch {}

    // ✅ Índice único: mismo profe (normalizado) dentro del mismo career/plan = 1 solo perfil
    // Si tenés duplicados viejos puede fallar; no rompemos el server.
    try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_prof_norm_career_plan ON professors(name_norm, career, plan)`); } catch {}
  }

  async function ensureReviewsSchema() {
    // Tabla para likes/dislikes de comentarios
    await ensureTable(
      `
    CREATE TABLE IF NOT EXISTS review_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      vote INTEGER NOT NULL, -- 1 like, -1 dislike
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(review_id, user_id)
    )
    `,
      'review_votes'
    );
    // Columnas extra en reviews (si tu DB es vieja, no existen todavía)
    await ensureColumn('reviews', 'corre', `ALTER TABLE reviews ADD COLUMN corre INTEGER`);
    await ensureColumn('reviews', 'clases', `ALTER TABLE reviews ADD COLUMN clases INTEGER`);
    await ensureColumn('reviews', 'onda', `ALTER TABLE reviews ADD COLUMN onda INTEGER`);
    await ensureColumn('reviews', 'tp_imp', `ALTER TABLE reviews ADD COLUMN tp_imp INTEGER`);
    await ensureColumn('reviews', 'exam_imp', `ALTER TABLE reviews ADD COLUMN exam_imp INTEGER`);
        await ensureColumn('reviews', 'biblio_imp', `ALTER TABLE reviews ADD COLUMN biblio_imp INTEGER`);
    await ensureColumn('reviews', 'focus', `ALTER TABLE reviews ADD COLUMN focus TEXT`);

    // ✅ toma lista: 0 = no sé, 1 = sí, 2 = no
    await ensureColumn('reviews', 'toma_lista', `ALTER TABLE reviews ADD COLUMN toma_lista INTEGER`);

    // ✅ mood/emoji (1..5)
    await ensureColumn('reviews', 'mood', `ALTER TABLE reviews ADD COLUMN mood INTEGER`);

    // ====== ÍNDICES para performance ======
    try { await run(`CREATE INDEX IF NOT EXISTS idx_reviews_prof ON reviews(professor_id)`); } catch {}
    try { await run(`CREATE INDEX IF NOT EXISTS idx_reviews_prof_created ON reviews(professor_id, created_at)`); } catch {}
    try { await run(`CREATE INDEX IF NOT EXISTS idx_review_votes_review_vote ON review_votes(review_id, vote)`); } catch {}
    try { await run(`CREATE INDEX IF NOT EXISTS idx_review_votes_review_user ON review_votes(review_id, user_id)`); } catch {}
    // ===============================
  }

  async function insertReviewSafely(pid, userId, data) {
    // Siempre: mantener 1 review por usuario por profesor
    await run(`DELETE FROM reviews WHERE professor_id=? AND user_id=?`, [pid, userId]);

    // Normalizar mood (1..5 o null)
    let mood = data.mood;
    if (mood === undefined || mood === null || mood === '') mood = null;
    mood = mood == null ? null : Math.max(1, Math.min(5, parseInt(mood, 10) || 0)) || null;

    // Intento 1: esquema nuevo completo (incluye mood + extras)
    try {
      await run(
        `INSERT INTO reviews
          (professor_id, user_id, rating, comment, mood, corre, clases, onda, tp_imp, exam_imp, biblio_imp, focus, toma_lista, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`,
        [
          pid,
          userId,
          data.rating,
          data.comment,
          mood,
          data.corre ?? null,
          data.clases ?? null,
          data.onda ?? null,
          data.tp_imp ?? null,
          data.exam_imp ?? null,
          data.biblio_imp ?? null,
          data.focus || '',
          data.toma_lista ?? null
        ]
      );
      return;
    } catch (e) {
      // Fallback 2: sin extras pero con mood + tri-métricas
      try {
        await run(
          `INSERT INTO reviews
          (professor_id, user_id, rating, comment, mood, corre, clases, onda, created_at)
         VALUES (?,?,?,?,?,?,?,?, datetime('now'))`,
          [pid, userId, data.rating, data.comment, mood, data.corre ?? null, data.clases ?? null, data.onda ?? null]
        );
        return;
      } catch (e2) {
        // Fallback 3: esquema mínimo
        await run(
          `INSERT INTO reviews
          (professor_id, user_id, rating, comment, created_at)
         VALUES (?,?,?,?, datetime('now'))`,
          [pid, userId, data.rating, data.comment]
        );
        return;
      }
    }
  }
  // =========================
  // Grupos (Mis grupos vs Explorar)
  // =========================
  router.get('/grupos', async (req, res) => {
    try {
      const user = safeUser(req);
      if (!user.id) return res.redirect('/login');

      const tab = req.query.tab === 'explorar' ? 'explorar' : 'mis';
      const year = Number.isInteger(parseInt(req.query.year, 10)) ? parseInt(req.query.year, 10) : 0; // 0 = todos
      const q = (req.query.q || '').toString().trim().toLowerCase();

      const hasGmTable = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='group_messages'`);

      let myGroups;
      if (hasGmTable) {
        myGroups = await all(
          `
          SELECT 
            s.*,
            gm.joined_at,
            lm.last_msg_text,
            lm.last_msg_at
          FROM subjects s
          JOIN group_members gm
            ON gm.subject_id = s.id
           AND gm.user_id   = ?
          LEFT JOIN (
            SELECT g.subject_id,
                   g.text       AS last_msg_text,
                   g.created_at AS last_msg_at
            FROM group_messages g
            JOIN (
                SELECT subject_id, MAX(created_at) AS max_ts
                FROM group_messages
                GROUP BY subject_id
            ) t ON t.subject_id = g.subject_id
               AND t.max_ts     = g.created_at
          ) lm ON lm.subject_id = s.id
          WHERE s.career = ? AND s.plan = ?
          ORDER BY 
            COALESCE(lm.last_msg_at, '') DESC,
            s.year, s.name
          `,
          [user.id, user.career, user.plan]
        );
      } else {
        myGroups = await all(
          `
          SELECT s.*, gm.joined_at
            FROM subjects s
            JOIN group_members gm
              ON gm.subject_id = s.id
             AND gm.user_id   = ?
           WHERE s.career = ? AND s.plan = ?
           ORDER BY s.year, s.name
          `,
          [user.id, user.career, user.plan]
        );
      }

      const exploreGroups = await all(
        `
        SELECT s.*
          FROM subjects s
         WHERE s.career = ?
           AND s.plan   = ?
           AND NOT EXISTS (
                 SELECT 1
                   FROM group_members gm
                  WHERE gm.subject_id = s.id
                    AND gm.user_id    = ?
           )
         ORDER BY s.year, s.name
        `,
        [user.career, user.plan, user.id]
      );

      function applyFilters(list) {
        let out = list;
        if (year && Number.isInteger(year)) out = out.filter((r) => parseInt(r.year || '0', 10) === year);
        if (q) out = out.filter((r) => String(r.name || '').toLowerCase().includes(q));
        return out;
      }

      const groups = tab === 'mis' ? applyFilters(myGroups) : applyFilters(exploreGroups);

      return res.render('grupos', {
        title: 'Grupos',
        tab,
        year,
        q,
        groups,
        carrera: user.career,
        plan: user.plan,
        user: req.user || {}
      });
    } catch (err) {
      console.error('GET /app/grupos error:', err);
      return res.status(500).send('Error cargando grupos');
    }
  });

  // =========================
  // Materias (home) — filtro por career/plan (admin puede forzar por query)
  // =========================
  router.get('/materias', async (req, res) => {
    try {
      const user = safeUser(req);
      let career = user.career;
      let plan = user.plan;

      if (user.role === 'admin' && (req.query.career || req.query.plan)) {
        if (req.query.career) career = normalizeCareer(String(req.query.career));
        if (req.query.plan) plan = parseInt(req.query.plan, 10) || 0;
      }

      // ✅ Auto-fix: asegurar tabla subjects en Turso (por si init no la creó todavía)
      await run(`
        CREATE TABLE IF NOT EXISTS subjects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          career TEXT,
          plan TEXT,
          year INTEGER,
          name TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      const subjects = await all(
        `SELECT ${SUBJECT_BASE_COLUMNS}
           FROM subjects
          WHERE career=?
            AND plan=?
          ORDER BY year ASC, COALESCE(semester, 9) ASC, name ASC`,
        [career, plan]
      );

      let adminFilters = null;
      if (user.role === 'admin') {
        const careersRows = await all(
          `SELECT DISTINCT career FROM (
            SELECT career FROM subjects
            UNION
            SELECT career FROM users
          ) WHERE career IS NOT NULL AND TRIM(career) <> '' ORDER BY career`
        );
        const plansRows = await all(
          `SELECT DISTINCT plan FROM (
            SELECT plan FROM subjects
            UNION
            SELECT plan FROM users
          ) WHERE plan IS NOT NULL ORDER BY plan`
        );

                const normalizedPlans = [...new Set(
          plansRows
            .map((r) => parseInt(String(r.plan ?? '').trim(), 10))
            .filter((p) => [6,7,8].includes(p))
        )].sort((a, b) => a - b);

        adminFilters = {
          careers: careersRows.map((r) => normalizeCareer(r.career)),
          plans: normalizedPlans,
          selectedCareer: career,
          selectedPlan: parseInt(String(plan || '0'), 10) || 0
        };
      }

      return res.render('materias', {
        title: 'Materias · iOS',
        subjects,
        adminFilters,
        carrera: career,
        plan
      });
    } catch (err) {
      console.error('GET /app/materias error:', err);
      return res.status(500).send('Error listando materias');
    }
  });

  // =========================
  // Crear materia
  // =========================
  router.post('/materias', ensureAdmin, async (req, res) => {
    try {
      const { name, year, career, plan } = req.body;

      const nm = String(name || '').trim();
      const ck = cleanMatch(nm);

      const r = await run(`INSERT INTO subjects (name, subject_name, canonical_key, year, career, plan) VALUES (?,?,?,?,?,?)`, [
        nm,
        nm,
        ck,
        parseInt(year, 10) || null,
        normalizeCareer(career),
        parseInt(plan, 10) || 0
      ]);
      const subjectId = r.lastID;

      const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

      const cursada = toArr(req.body['prereq_cursada[]'] || req.body.prereq_cursada);
      const finalReq = toArr(req.body['prereq_final[]'] || req.body.prereq_final);

      for (const depId of cursada) {
        const idNum = parseInt(depId, 10);
        if (!Number.isNaN(idNum)) {
          await run(`INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?,?,?)`, [
            subjectId,
            idNum,
            'cursada'
          ]);
        }
      }

      for (const depId of finalReq) {
        const idNum = parseInt(depId, 10);
        if (!Number.isNaN(idNum)) {
          await run(`INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?,?,?)`, [
            subjectId,
            idNum,
            'final'
          ]);
        }
      }

      return res.redirect('/app/materias');
    } catch (err) {
      console.error('POST /app/materias error:', err);
      return res.status(500).send('Error creando materia');
    }
  });

  // =========================
  // Renombrar materia
  // =========================
  router.post('/materias/:id/rename', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');
      const nm = String(req.body.name || '').trim();
      const ck = cleanMatch(nm);
      await run(`UPDATE subjects SET name=?, subject_name=?, canonical_key=? WHERE id=?`, [nm, nm, ck, id]);
      return res.redirect('/app/materias');
    } catch (err) {
      console.error('POST /app/materias/:id/rename error:', err);
      return res.status(500).send('Error renombrando materia');
    }
  });

  // =========================
  // Reordenar documentos (solo admin)
  // =========================
  router.post('/materias/:id/docs/reorder', ensureAdmin, express.json(), async (req, res) => {
    try {
      const subjectId = parseInt(req.params.id, 10);
      if (!subjectId) return res.status(400).json({ ok:false, error:'ID inválido' });

      const subjectKey = await getSubjectKeyById(subjectId);

      const VALID_CATS = new Set(['parciales','finales','trabajos','bibliografia','resumenes','clases','definiciones']);
      const category = String((req.body && req.body.category) || req.query.category || '').toLowerCase();

      // Reorder solo para categorías “normales” (si querés también para resumenes te lo adapto)
      if (!VALID_CATS.has(category) || category === 'resumenes') {
        return res.status(400).json({ ok:false, error:'Categoría inválida' });
      }

      const idsRaw = (req.body && req.body.ids) || [];
      const ids = Array.isArray(idsRaw)
        ? idsRaw.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0)
        : [];

      if (!ids.length) return res.status(400).json({ ok:false, error:'Lista vacía' });

      // Validar que esos docs existan y pertenezcan a esa materia/categoría
      const placeholders = ids.map(()=>'?').join(',');
      // Subcategory (solo para Trabajos/Clases)
      const reqSub = String((req.body && req.body.subcategory) || '').trim();
      const subcategory = (category === 'trabajos' || category === 'clases') ? reqSub : '';

        let checkSql =
        `SELECT d.id
           FROM documents d
          WHERE COALESCE(NULLIF(d.subject_key,''), '')=?
            AND d.category=?
            AND d.id IN (${placeholders})`;

      const checkArgs = [subjectKey, category, ...ids];

      if (subcategory && category === 'clases') {
        checkSql += ` AND LOWER(COALESCE(d.subcategory,'')) = LOWER(?)`;
        checkArgs.push(subcategory);
      }
      if (subcategory && category === 'trabajos') {
        checkSql += ` AND COALESCE(d.subcategory,'') = ?`;
        checkArgs.push(subcategory);
      }

      const rows = await all(checkSql, checkArgs);

      if (rows.length !== ids.length) {
        return res.status(400).json({ ok:false, error:'Hay documentos inválidos' });
      }

      // Asignar orden: 1..n (el 1 sale primero)
      const n = ids.length;
      for (let i = 0; i < n; i++) {
        const sort = i + 1;
        await run(`UPDATE documents SET sort_order=? WHERE id=?`, [sort, ids[i]]);
      }

      bustSubjectCaches(subjectKey);
      return res.json({ ok:true });
    } catch (e) {
      console.error('POST /app/materias/:id/docs/reorder error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo guardar el orden' });
    }
  });

  // =========================
  // Descargar PDF con límite diario (excepto admin)
  // =========================
  router.post('/materias/:id/download-ticket', express.json(), async (req, res) => {
    try {
      const subjectId = parseInt(req.params.id, 10);
      const docId = parseInt(req.body?.docId, 10);

      if (Number.isNaN(subjectId) || Number.isNaN(docId)) {
        return res.status(400).json({ ok:false, error:'Solicitud inválida' });
      }

      const user = safeUser(req);

      if (user.role === 'guest') {
        return res.status(403).json({ ok:false, error:'Para descargar PDFs necesitás crear una cuenta gratis.' });
      }

      if (user.role !== 'admin' && !user.id) {
        return res.status(403).json({ ok:false, error:'Tenés que iniciar sesión para descargar.' });
      }

      let subject;
      if (user.role === 'admin') {
        subject = await get(
          `SELECT ${SUBJECT_BASE_COLUMNS}
             FROM subjects
            WHERE id=?
            LIMIT 1`,
          [subjectId]
        );
      } else {
        subject = await get(
          `SELECT ${SUBJECT_BASE_COLUMNS}
             FROM subjects
            WHERE id=?
              AND career=?
              AND plan=?
            LIMIT 1`,
          [subjectId, user.career, user.plan]
        );
      }

      if (!subject) {
        return res.status(404).json({ ok:false, error:'Materia no encontrada' });
      }

      const subjectKey = String(subject.canonical_key || '').trim()
        || cleanMatch((subject.subject_name || subject.name || ''));

      const doc = await get(
        `SELECT id, subject_id, filename, url, category,
                COALESCE(NULLIF(subject_key,''), '') AS subject_key
           FROM documents
          WHERE id=?`,
        [docId]
      );

      if (!doc) {
        return res.status(404).json({ ok:false, error:'Documento no encontrado' });
      }

      const docSubjectKey = String(doc.subject_key || '').trim();
      const belongsToSubject =
        Number(doc.subject_id || 0) === subjectId ||
        (docSubjectKey && docSubjectKey === subjectKey);

      if (!belongsToSubject) {
        return res.status(403).json({ ok:false, error:'Ese documento no pertenece a esta materia.' });
      }

      const downloadUrl = buildDocumentDownloadUrl(doc);
      if (!downloadUrl) {
        return res.status(404).json({ ok:false, error:'No se encontró el archivo para descargar.' });
      }

      if (user.role === 'admin') {
        return res.json({ ok:true, downloadUrl });
      }

      await run(`
        CREATE TABLE IF NOT EXISTS pdf_download_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          document_id INTEGER NOT NULL,
          downloaded_at INTEGER NOT NULL
        )
      `);

      await run(`
        CREATE INDEX IF NOT EXISTS idx_pdf_download_logs_user_time
        ON pdf_download_logs(user_id, downloaded_at)
      `);

      const DAY_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const since = now - DAY_MS;

      const row = await get(
        `SELECT COUNT(*) AS total, MIN(downloaded_at) AS oldest_recent
           FROM pdf_download_logs
          WHERE user_id=? AND downloaded_at>=?`,
        [user.id, since]
      );

      const total = Number(row?.total || 0);
      const oldestRecent = Number(row?.oldest_recent || 0);

      if (total >= 3) {
        const waitMs = Math.max(0, (oldestRecent + DAY_MS) - now);
        return res.status(429).json({
          ok:false,
          error:'Ya alcanzaste el máximo de 3 descargas en las últimas 24 horas.',
          waitMs
        });
      }

      await run(
        `INSERT INTO pdf_download_logs (user_id, document_id, downloaded_at)
         VALUES (?, ?, ?)`,
        [user.id, docId, now]
      );

      return res.json({ ok:true, downloadUrl });
    } catch (err) {
      console.error('POST /app/materias/:id/download-ticket error:', err);
      return res.status(500).json({ ok:false, error:'No se pudo iniciar la descarga.' });
    }
  });
  // =========================
  // Eliminar materia
  // =========================
  router.post('/materias/:id/delete', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');
      await run(`DELETE FROM subjects WHERE id=?`, [id]);
      return res.redirect('/app/materias');
    } catch (err) {
      console.error('POST /app/materias/:id/delete error:', err);
      return res.status(500).send('Error eliminando materia');
    }
  });

  // =========================
  // Vista de materia (con agrupado de “resúmenes” por doc_group y nivel)
  // =========================
  router.get('/materias/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');

      const user = safeUser(req);
      const isGuest = (user.role === 'guest');
      let subject;

      if (user.role === 'admin') {
        subject = await get(
          `SELECT ${SUBJECT_BASE_COLUMNS}
             FROM subjects
            WHERE id=?
            LIMIT 1`,
          [id]
        );
      } else {
        subject = await get(
          `SELECT ${SUBJECT_BASE_COLUMNS}
             FROM subjects
            WHERE id=?
              AND career=?
              AND plan=?
            LIMIT 1`,
          [id, user.career, user.plan]
        );
      }
      if (!subject) return res.status(404).send('Materia no encontrada');

      // ✅ Clave canónica: unifica materias repetidas entre carreras/planes (mismo contenido en todas)
      const subjectKey = String(subject.canonical_key || '').trim()
        || cleanMatch((subject.subject_name || subject.name || ''));
      // ✅ Categorías válidas (incluye DEFINICIONES)
      const VALID_CATS = new Set([
        'parciales',
        'finales',
        'trabajos',
        'bibliografia',
        'resumenes',
        'clases',
        'definiciones'
      ]);

      // ✅ default: parciales (o dejalo como finales si querés, pero así evitás cosas raras)
      let category = String(req.query.category || 'parciales').toLowerCase().trim();
      if (!VALID_CATS.has(category)) category = 'parciales';

            // =========================
      // Subcategorías (Trabajos / Clases)
      // =========================
      const schema = await getDocumentsSchemaFlags();
      const hasSubcategory = schema.hasSubcategory;

      let classSections = [];
      if (category === 'clases') {
        try {
          classSections = await getCachedClassSections(subjectKey);
        } catch (e) {
          classSections = [];
        }
      }

      let subcategory = String(req.query.subcategory || '').trim();

      // Trabajos: por defecto TPs (y solo permite TPs/Resoluciones)
      if (category === 'trabajos') {
        subcategory = (subcategory || 'tps').toLowerCase();
        const VALID_WORK_SUBS = new Set(['tps', 'resoluciones']);
        if (!VALID_WORK_SUBS.has(subcategory)) subcategory = 'tps';
      }

      // Clases: si hay secciones creadas y no viene subcategory, entramos a la primera
      if (category === 'clases') {
        if (!subcategory && classSections.length) subcategory = classSections[0].name;
      }

      // En otras categorías no usamos subcategory
      if (category !== 'trabajos' && category !== 'clases') {
        subcategory = '';
      }

      const hasLevel = schema.hasLevel;
      const hasGroupUid = schema.hasGroupUid;
      const hasDocGroup = schema.hasDocGroup;
      const hasAnyGroup = hasGroupUid || hasDocGroup;
      const hasSubjectKey = schema.hasSubjectKey;
      const docsSelectColumns = [
        'd.id',
        'd.subject_id',
        'd.title',
        'd.filename',
        'd.url',
        'd.category',
        hasSubcategory ? 'd.subcategory' : `'' AS subcategory`,
        hasLevel ? 'd.level' : `'' AS level`,
        hasGroupUid ? 'd.group_uid' : `'' AS group_uid`,
        hasDocGroup ? 'd.doc_group' : `'' AS doc_group`,
        'd.sort_order',
        'd.created_at'
      ];

      const VALID_LEVELS = new Set(['completo', 'mediano', 'facil']);
      let level = String(req.query.level || 'completo').toLowerCase();
      if (!VALID_LEVELS.has(level)) level = 'completo';

            // =========================
      // Docs (filtrando por subcategory cuando corresponde)
      // =========================
      const requestedDocId = req.query.doc ? parseInt(req.query.doc, 10) : null;
      const requestedGid = String(req.query.gid || '').trim();
      const subjectCacheKey = [
        'subject-v1',
        String(subject.id),
        category,
        String(subcategory || ''),
        String(level || 'completo'),
        Number.isFinite(requestedDocId) ? String(requestedDocId) : '',
        requestedGid
      ].join('|');

      const subjectViewBase = await getCachedSubjectView(subjectCacheKey, async () => {
        let fullDocs = [];

        if (!(category === 'clases' && !subcategory)) {
          let docsSql = hasSubjectKey
            ? `SELECT
                 ${docsSelectColumns.join(',\n                 ')},
                 d.subject_key
               FROM documents d
               WHERE COALESCE(NULLIF(d.subject_key,''), '')=?
                 AND d.category=?`
            : `SELECT
                 ${docsSelectColumns.join(',\n                 ')},
                 COALESCE(NULLIF(s.canonical_key,''), '') AS subject_key
               FROM documents d
               JOIN subjects s ON s.id = d.subject_id
               WHERE s.canonical_key=?
                 AND d.category=?`;
          const docsArgs = [subjectKey, category];

          if (hasSubcategory && (category === 'trabajos' || category === 'clases')) {
            if (category === 'clases') {
              docsSql += ` AND LOWER(COALESCE(d.subcategory,'')) = LOWER(?)`;
              docsArgs.push(subcategory);
            } else {
              docsSql += ` AND COALESCE(d.subcategory,'') = ?`;
              docsArgs.push(subcategory);
            }
          }

          docsSql += ` ORDER BY COALESCE(d.sort_order, 999999) ASC, d.created_at ASC, d.id ASC`;
          fullDocs = await all(docsSql, docsArgs);
        }

        let fullGroups = null;
        let fullActiveDoc = null;

        if (category === 'resumenes') {
          const map = new Map();
          const pickGroupId = (d) => {
            if (hasGroupUid && d.group_uid) return d.group_uid;
            if (hasDocGroup && d.doc_group) return d.doc_group;
            return `g-${d.id}`;
          };

          for (const d of fullDocs) {
            const gid = hasAnyGroup ? pickGroupId(d) : `g-${d.id}`;
            if (!map.has(gid)) {
              map.set(gid, {
                group_uid: gid,
                title: d.title || 'Resumen',
                latest_at: d.created_at || null,
                versions: { completo: null, mediano: null, facil: null }
              });
            }
            const g = map.get(gid);
            if (!g.title && d.title) g.title = d.title;
            if (d.created_at && (!g.latest_at || d.created_at > g.latest_at)) g.latest_at = d.created_at;

            const lv = hasLevel ? (d.level || 'completo') : 'completo';
            if (!g.versions[lv]) g.versions[lv] = d;
          }

          fullGroups = Array.from(map.values()).sort((a, b) => ((b.latest_at || '') > (a.latest_at || '') ? 1 : -1));

          const activeGroup = fullGroups.find((g) => g.group_uid === requestedGid) || fullGroups[0] || null;
          if (activeGroup) {
            fullActiveDoc =
              activeGroup.versions[level] ||
              activeGroup.versions.completo ||
              activeGroup.versions.mediano ||
              activeGroup.versions.facil ||
              null;
          }
        } else if (category !== 'definiciones') {
          const activeDocId = Number.isFinite(requestedDocId) ? requestedDocId : (fullDocs[0]?.id || null);
          fullActiveDoc = activeDocId ? (fullDocs.find((d) => d.id === activeDocId) || null) : null;
        }

        let temasLocal = [];
        let txtFilesLocal = [];

        if (category === 'definiciones') {
          try {
            const parsed = await loadDefsForSubjectKey(subjectKey);
            temasLocal = (parsed?.topics || []).map(t => t.title).filter(Boolean);

            const rows = await all(
              `SELECT d.id, COALESCE(NULLIF(d.title,''), d.filename) AS name, d.filename
                 FROM documents d
                WHERE COALESCE(NULLIF(d.subject_key,''), '')=?
                  AND d.category='definiciones'
                ORDER BY d.id DESC`,
              [subjectKey]
            );
            txtFilesLocal = rows.map(r => ({ id: r.id, name: r.name, filename: r.filename }));
          } catch (e) {
            console.error('Definiciones loadDefsForSubjectKey error:', e);
          }
        }

        return {
          docs: fullDocs,
          groups: fullGroups,
          activeDoc: fullActiveDoc,
          temas: temasLocal,
          txtFiles: txtFilesLocal
        };
      });

      let docs = subjectViewBase.docs || [];
      let groups = subjectViewBase.groups || null;
      let activeDoc = subjectViewBase.activeDoc || null;

      if (isGuest) {
        if (category === 'resumenes') {
          docs = [];
          groups = null;
          activeDoc = null;
        } else if (category === 'definiciones') {
          docs = [];
          activeDoc = null;
        } else {
          docs = docs.slice(0, 1);
          activeDoc = docs[0] || null;
        }
      }

      let definitionsData = [];
      let temas = subjectViewBase.temas || [];
      let txtFiles = (req.user && req.user.role === 'admin') ? (subjectViewBase.txtFiles || []) : [];

        return res.render('subject', {
          title: subject.name,
          subject,
          category,
          subcategory,
          classSections,
          docs,
          groups,
          activeDoc,
          currentLevel: level,
          query: req.query,
          bodyClass: category === 'definiciones' ? 'page-definitions' : '',
          carrera: user.career,
          plan: user.plan,
          user: req.user || {},
          isAdmin: !!(req.user && req.user.role === 'admin'),
          isGuest: !!isGuest,
          definitionsData,
          temas,
          txtFiles
        });

    } catch (err) {
      console.error('GET /app/materias/:id error:', err);
      return res.status(500).send('Error cargando la materia');
    }
  });

    // =========================
  // Clases: crear subsección (solo admin)
  // =========================
  router.post(
    '/materias/:id/clases/sections',
    ensureAdmin,
    express.urlencoded({ extended: true }),
    async (req, res) => {
      try {
        const subjectId = parseInt(req.params.id, 10);
        if (Number.isNaN(subjectId)) return res.status(400).send('ID inválido');

        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).send('Nombre requerido');
        if (name.length > 40) return res.status(400).send('Nombre demasiado largo (máx 40)');

        await run(
          `INSERT OR IGNORE INTO classes_sections (subject_id, name, created_at)
           VALUES (?, ?, datetime('now'))`,
          [subjectId, name]
        );

        const subjectKey = await getSubjectKeyById(subjectId);
        bustSubjectCaches(subjectKey);

        return res.redirect(
          `/app/materias/${subjectId}?category=clases&subcategory=${encodeURIComponent(name)}`
        );
      } catch (err) {
        console.error('POST /app/materias/:id/clases/sections error:', err);
        return res.status(500).send('Error creando subsección');
      }
    }
  );

  // =========================
  // Clases: renombrar subsección (solo admin)
  // =========================
  router.post(
    '/materias/:id/clases/sections/:sectionId/rename',
    ensureAdmin,
    express.json(),
    async (req, res) => {
      try {
        const subjectId = parseInt(req.params.id, 10);
        const sectionId = parseInt(req.params.sectionId, 10);
        if (Number.isNaN(subjectId) || Number.isNaN(sectionId)) {
          return res.status(400).json({ ok:false, error:'ID inválido' });
        }

        const newName = String(req.body?.name || '').trim();
        if (!newName) return res.status(400).json({ ok:false, error:'Nombre requerido' });
        if (newName.length > 40) return res.status(400).json({ ok:false, error:'Nombre demasiado largo (máx 40)' });

        const row = await get(
          `SELECT cs.id, cs.name, s.id AS subject_id, s.canonical_key,
                  COALESCE(NULLIF(s.subject_name,''), NULLIF(s.name,'')) AS subject_name
             FROM classes_sections cs
             JOIN subjects s ON s.id = cs.subject_id
            WHERE cs.id=?`,
          [sectionId]
        );
        if (!row) return res.status(404).json({ ok:false, error:'Subsección no encontrada' });

        const subjectKey = String(row.canonical_key || '').trim() || cleanMatch(row.subject_name || '');
        const oldName = String(row.name || '').trim();
        if (!oldName) return res.status(400).json({ ok:false, error:'Subsección inválida' });

        const dup = await get(
          `SELECT 1 AS ok
             FROM classes_sections cs
             JOIN subjects s ON s.id = cs.subject_id
            WHERE s.canonical_key = ?
              AND LOWER(TRIM(cs.name)) = LOWER(TRIM(?))
              AND LOWER(TRIM(cs.name)) <> LOWER(TRIM(?))
            LIMIT 1`,
          [subjectKey, newName, oldName]
        );
        if (dup) return res.status(400).json({ ok:false, error:'Ya existe otra subsección con ese nombre' });

        await run(
          `UPDATE classes_sections
              SET name=?
            WHERE id IN (
              SELECT cs2.id
                FROM classes_sections cs2
                JOIN subjects s2 ON s2.id = cs2.subject_id
               WHERE s2.canonical_key = ?
                 AND LOWER(TRIM(cs2.name)) = LOWER(TRIM(?))
            )`,
          [newName, subjectKey, oldName]
        );

        await run(
          `UPDATE documents
              SET subcategory=?
            WHERE COALESCE(NULLIF(subject_key,''), '')=?
              AND category='clases'
              AND LOWER(TRIM(COALESCE(subcategory,''))) = LOWER(TRIM(?))`,
          [newName, subjectKey, oldName]
        );

        bustSubjectCaches(subjectKey);
        return res.json({ ok:true, name:newName, redirect:`/app/materias/${subjectId}?category=clases&subcategory=${encodeURIComponent(newName)}` });
      } catch (err) {
        console.error('POST /app/materias/:id/clases/sections/:sectionId/rename error:', err);
        return res.status(500).json({ ok:false, error:'Error renombrando subsección' });
      }
    }
  );

  // =========================
  // Clases: eliminar subsección + sus archivos (solo admin)
  // =========================
  router.post(
    '/materias/:id/clases/sections/:sectionId/delete',
    ensureAdmin,
    express.json(),
    async (req, res) => {
      try {
        const subjectId = parseInt(req.params.id, 10);
        const sectionId = parseInt(req.params.sectionId, 10);
        if (Number.isNaN(subjectId) || Number.isNaN(sectionId)) {
          return res.status(400).json({ ok:false, error:'ID inválido' });
        }

        const row = await get(
          `SELECT cs.id, cs.name, s.id AS subject_id, s.canonical_key,
                  COALESCE(NULLIF(s.subject_name,''), NULLIF(s.name,'')) AS subject_name
             FROM classes_sections cs
             JOIN subjects s ON s.id = cs.subject_id
            WHERE cs.id=?`,
          [sectionId]
        );
        if (!row) return res.status(404).json({ ok:false, error:'Subsección no encontrada' });

        const subjectKey = String(row.canonical_key || '').trim() || cleanMatch(row.subject_name || '');
        const oldName = String(row.name || '').trim();
        if (!oldName) return res.status(400).json({ ok:false, error:'Subsección inválida' });

        const docs = await all(
          `SELECT id, filename
             FROM documents
            WHERE COALESCE(NULLIF(subject_key,''), '')=?
              AND category='clases'
              AND LOWER(TRIM(COALESCE(subcategory,''))) = LOWER(TRIM(?))`,
          [subjectKey, oldName]
        );

        for (const d of docs) {
          const key = String(d?.filename || '').trim();
          if (key && key.startsWith('docs/')) {
            try { await r2Delete(key); } catch (_) {}
          }
        }

        await run(
          `DELETE FROM documents
            WHERE COALESCE(NULLIF(subject_key,''), '')=?
              AND category='clases'
              AND LOWER(TRIM(COALESCE(subcategory,''))) = LOWER(TRIM(?))`,
          [subjectKey, oldName]
        );

        await run(
          `DELETE FROM classes_sections
            WHERE id IN (
              SELECT cs2.id
                FROM classes_sections cs2
                JOIN subjects s2 ON s2.id = cs2.subject_id
               WHERE s2.canonical_key = ?
                 AND LOWER(TRIM(cs2.name)) = LOWER(TRIM(?))
            )`,
          [subjectKey, oldName]
        );

        bustSubjectCaches(subjectKey);
        return res.json({ ok:true, redirect:`/app/materias/${subjectId}?category=clases` });
      } catch (err) {
        console.error('POST /app/materias/:id/clases/sections/:sectionId/delete error:', err);
        return res.status(500).json({ ok:false, error:'Error eliminando subsección' });
      }
    }
  );
  // =========================
  // Autoevaluaciones
  // =========================
  router.get('/autoevaluaciones', async (req, res) => {
    try {
      const user = safeUser(req);

      const subjects = await all(
        `SELECT
          MIN(id) AS id,
          COALESCE(NULLIF(name,''), NULLIF(subject_name,'')) AS name,
          COALESCE(year,0) AS year,
          career,
          CAST(plan AS INTEGER) AS plan
        FROM subjects
        WHERE LOWER(career)=LOWER(?)
          AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)
        GROUP BY
          COALESCE(
            NULLIF(canonical_key,''),
            LOWER(TRIM(COALESCE(NULLIF(name,''), NULLIF(subject_name,'')))))
        ORDER BY COALESCE(year,0), name`,
        [user.career, user.plan]
      );

      return res.render('autoevaluaciones', {
        title: 'Autoevaluaciones',
        subjects,
        carrera: user.career,
        plan: user.plan,
        user: req.user || {}
      });
    } catch (err) {
      console.error('GET /app/autoevaluaciones error:', err);
      return res.status(500).send('Error cargando autoevaluaciones');
    }
  });

  router.post('/autoevaluaciones/iniciar', express.json(), async (req, res) => {
    try {
      const user = safeUser(req);

      if (user.role === 'guest') {
        return res.status(403).json({ ok:false, error:'Para hacer autoevaluaciones necesitás crear una cuenta gratis.' });
      }


      const { subject_id } = req.body;
      const sid = parseInt(subject_id, 10);
      if (Number.isNaN(sid)) return res.status(400).json({ error: 'subject_id inválido' });

      // ✅ IMPORTANTE: traer también el nombre (antes solo traías id => subject.name era undefined)
      const subject = await get(
        `SELECT id, name, canonical_key, career
           FROM subjects
          WHERE id=?
            AND LOWER(career)=LOWER(?)
            AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)`,
        [sid, user.career, user.plan]
      );
      if (!subject) return res.status(404).json({ error: 'Materia no encontrada para tu perfil' });

      // Cargar preguntas desde /preguntas
      const { loadQuestionsCanonicalDb } = require('../lib/questions');

      let qs = await loadQuestionsCanonicalDb(
        String(subject.canonical_key || '').trim(),
        String(subject.career || user.career || '').trim()
      );

      // fallback legacy (por si algo viejo quedó sin canonical_key)
      if (!qs.length) {
        qs = await loadQuestionsDb(subject.name, String(user.plan));
      }
      if (!qs.length) {
        qs = await loadQuestionsAnyPlanDb(subject.name);
      }
      qs = shuffleInPlace(qs.slice());

      if (!qs.length) {
        return res.status(404).json({ error: 'No hay preguntas cargadas para esta materia/plan' });
      }

      // Tomamos 5 (o menos si hay menos)
      qs = qs.slice(0, 5);

      // Guardar correct keys en sesión (por subject_id)
      req.session = req.session || {};
      req.session.auto_eval = req.session.auto_eval || {};
      req.session.auto_eval[String(sid)] = { map: {}, at: Date.now() };

      function shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      }

      const payload = qs.map((it, idx) => {
        const choices = shuffleArray((it.choices || []).slice(0, 4));
        while (choices.length < 4) choices.push('');

        const opt = { a: choices[0], b: choices[1], c: choices[2], d: choices[3] };

        const correctText = String(it.correct || '').trim();
        let correctKey = null;
        for (const k of ['a', 'b', 'c', 'd']) {
          if (String(opt[k] || '').trim() === correctText) {
            correctKey = k;
            break;
          }
        }

        const qid = idx + 1;
        req.session.auto_eval[String(sid)].map[String(qid)] = { correctKey };

        return { id: qid, q: it.question || '', a: opt.a, b: opt.b, c: opt.c, d: opt.d };
      });

      return res.json({ questions: payload });
    } catch (err) {
      console.error('POST /app/autoevaluaciones/iniciar error:', err);
      return res.status(500).json({ error: 'Error iniciando autoevaluación' });
    }
  });

  router.post('/autoevaluaciones/responder', express.json(), async (req, res) => {
    try {
      const user = safeUser(req);

      if (user.role === 'guest') {
        return res.status(403).json({ ok:false, error:'Para hacer autoevaluaciones necesitás crear una cuenta gratis.' });
      }

      const { subject_id, answers } = req.body;

      const sid = parseInt(subject_id, 10);
      if (Number.isNaN(sid) || !Array.isArray(answers)) return res.status(400).json({ error: 'Datos inválidos' });

      const subject = await get(
        `SELECT id
           FROM subjects
          WHERE id=?
            AND LOWER(career)=LOWER(?)
            AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)`,
        [sid, user.career, user.plan]
      );
      if (!subject) return res.status(404).json({ error: 'Materia no encontrada para tu perfil' });

      let correctCount = 0;
      const details = [];

      for (const ans of answers) {
        const qid = parseInt(ans?.id, 10);
        const choice = (ans?.choice ?? '').toString().trim().toLowerCase();

        if (Number.isNaN(qid) || !choice) {
          details.push({ id: ans?.id, ok: false, correct: null, chosen: choice || null });
          continue;
        }

        const correct = req.session?.auto_eval?.[String(sid)]?.map?.[String(qid)]?.correctKey || null;
        const ok = !!(correct && String(correct).toLowerCase() === choice);

        if (ok) correctCount++;
        details.push({ id: qid, ok, correct, chosen: choice });
      }

      const score = correctCount * 2;

      // ✅ Auto-fix: asegurar tabla quiz_attempts para evitar crasheos si no existe
      await run(`
        CREATE TABLE IF NOT EXISTS quiz_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          subject_id INTEGER,
          score INTEGER,
          total INTEGER,
          answers_json TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      await run(`INSERT INTO quiz_attempts (user_id, subject_id, score, total, answers_json)
         VALUES (?,?,?,?,?)`, [user.id, sid, score, 10, JSON.stringify(answers)]);

      try {
        if (req.session?.auto_eval) delete req.session.auto_eval[String(sid)];
      } catch (_) {
        /* noop */
      }

      return res.json({ score, total: 10, details });
    } catch (err) {
      console.error('POST /app/autoevaluaciones/responder error:', err);
      return res.status(500).json({ error: 'Error registrando respuestas' });
    }
  });

  // =========================
  // Juegos
  // =========================

    router.get('/juegos', async (req, res) => {
      try {
        const user = safeUser(req);




        // asegurar tabla puntos (por si una DB vieja no la tiene)
        await run(`
          CREATE TABLE IF NOT EXISTS game_scores (
            user_id INTEGER PRIMARY KEY,
            points INTEGER DEFAULT 0,
            updated_at TEXT
          )
        `);

        let puntos = null;
        if (user.id) {
          let row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
          if (!row) {
            await run(`INSERT OR IGNORE INTO game_scores (user_id, points) VALUES (?, 0)`, [user.id]);
            row = { points: 0 };
          }
          puntos = Number(row.points || 0);
        }

        // ✅ IMPORTANTE: traer career/plan porque el EJS filtra por eso
        const subjects = await all(
          `SELECT id, name, year, career, plan
            FROM subjects
            WHERE LOWER(career)=LOWER(?)
              AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)
            ORDER BY COALESCE(year,0), name`,
          [user.career, user.plan]
        );

        const selected_subject_id = req.query.subject_id || '';
        const guestGamePlays = (req.session && req.session.guestGamePlays) ? req.session.guestGamePlays : {};
        const guestPoints = Number((req.session && req.session.guestGamePoints) || 0);

        return res.render('juegos', {
          title: 'Juegos',
          user: req.user || {},
          subjects,
          selected_subject_id,
          initialGameKey: '',
          carrera: user.career,
          plan: user.plan,
          puntos: (user.role === 'guest' ? guestPoints : puntos),
          isGuest: (user.role === 'guest'),
          guestGamePlays
        });
      } catch (err) {
        console.error('GET /app/juegos error:', err);
        return res.status(500).send('Error cargando juegos');
      }
    });

        router.get('/juegos/:slug', async (req, res) => {
      try {
        const user = safeUser(req);



        // asegurar tabla puntos (por si una DB vieja no la tiene)
        await run(`
          CREATE TABLE IF NOT EXISTS game_scores (
            user_id INTEGER PRIMARY KEY,
            points INTEGER DEFAULT 0,
            updated_at TEXT
          )
        `);

        let puntos = null;
        if (user.id) {
          let row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
          if (!row) {
            await run(`INSERT OR IGNORE INTO game_scores (user_id, points) VALUES (?, 0)`, [user.id]);
            row = { points: 0 };
          }
          puntos = Number(row.points || 0);
        }

        // ✅ IMPORTANTE: traer career/plan porque el EJS filtra por eso
        const subjects = await all(
          `SELECT id, name, year, career, plan
            FROM subjects
            WHERE LOWER(career)=LOWER(?)
              AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)
            ORDER BY COALESCE(year,0), name`,
          [user.career, user.plan]
        );

        const selected_subject_id = req.query.subject_id || '';
        return res.render('juegos', {
          title: 'Juegos',
          user: req.user || {},
          subjects,
          selected_subject_id,
          initialGameKey: '',
          carrera: user.career,
          plan: user.plan,
          puntos
        });
      } catch (err) {
        console.error('GET /app/juegos/:slug error:', err);
        return res.status(500).send('Error cargando juegos');
      }
    });


    router.get('/juegos/:game', async (req, res) => {
      try {
        const user = safeUser(req);


        await run(`
          CREATE TABLE IF NOT EXISTS game_scores (
            user_id INTEGER PRIMARY KEY,
            points INTEGER DEFAULT 0,
            updated_at TEXT
          )
        `);

        let puntos = null;
        if (user.id) {
          let row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
          if (!row) {
            await run(`INSERT OR IGNORE INTO game_scores (user_id, points) VALUES (?, 0)`, [user.id]);
            row = { points: 0 };
          }
          puntos = Number(row.points || 0);
        }

        const slug = String(req.params.game || '').toLowerCase();

        // slugs (URL) -> keys internas (data-game)
        const slugToKey = {
          ruletaquiz: 'roulette',
          roulette: 'roulette',

          dinamita: 'hotpotato',
          hotpotato: 'hotpotato',

          escaperoom: 'escape',
          escape: 'escape',

          speedrun: 'speedrun',

          cajafuerte: 'num-logic',
          logica: 'num-logic',
          'num-logic': 'num-logic',

          impostorfrase: 'impostor-phrase',
          'impostor-phrase': 'impostor-phrase',

          salafalsa: 'false-room',
          'false-room': 'false-room',

          impostortema: 'impostor-topic',
          'impostor-topic': 'impostor-topic',

          subasta: 'auction',
          auction: 'auction',

          pinturillo: 'sketch',
          dibujo: 'sketch',
          sketch: 'sketch'
        };

        const initialGameKey = slugToKey[slug];
        if (!initialGameKey) return res.redirect('/app/juegos');

        const subjects = await all(
          `SELECT id, name, year, career, plan
            FROM subjects
            WHERE LOWER(career)=LOWER(?)
              AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)
            ORDER BY COALESCE(year,0), name`,
          [user.career, user.plan]
        );

        const selected_subject_id = req.query.subject_id || '';
        return res.render('juegos', {
          title: 'Juegos',
          user: req.user || {},
          subjects,
          selected_subject_id,
          initialGameKey,
          carrera: user.career,
          plan: user.plan,
          puntos
        });
      } catch (err) {
        console.error('GET /app/juegos/:game error:', err);
        return res.status(500).send('Error cargando juegos');
      }
    });

    // =========================
    // Invitado — 1 vez por juego (por sesión)
    // POST /app/api/guest/game-played  body: { game: 'speedrun' }
    // =========================
    router.post('/api/guest/game-played', express.json(), (req, res) => {
      try{
        const user = safeUser(req);
        const key = String(req.body?.game || '').trim();
        if (!key) return res.status(400).json({ ok:false, error:'game requerido' });

        // solo aplica al invitado
        if (user.role !== 'guest') return res.json({ ok:true, locked:false });

        req.session.guestGamePlays = req.session.guestGamePlays || {};
        const plays = req.session.guestGamePlays;

        if (plays[key]) return res.json({ ok:false, locked:true });

        plays[key] = true;
        req.session.guestGamePlays = plays;
        try{ req.session.save(()=>{}); }catch(_){}

        return res.json({ ok:true, locked:false });
      }catch(e){
        console.error('POST /api/guest/game-played error:', e);
        return res.status(500).json({ ok:false, error:'error' });
      }
    });
  // =========================
  // Juegos — API de preguntas (para Subasta y otros modos)
  // Responde a lo que el front ya intenta:
  //   GET /app/quizzes/random?subjectId=...
  //   GET /app/questions/random?subject=...
  // =========================

    async function resolveSubjectForQuiz(req, user){
      const q = req.query || {};
      const sidRaw  = q.subjectId ?? q.subject_id ?? q.id ?? '';
      const nameRaw = q.subject ?? q.subjectName ?? q.name ?? '';

      let subject = null;

      if (sidRaw){
        const sid = parseInt(String(sidRaw), 10);
        if (Number.isFinite(sid)){
          subject = await get(
            `SELECT id, name, canonical_key, career
              FROM subjects
              WHERE id=?
                AND LOWER(career)=LOWER(?)
                AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)`,
            [sid, user.career, user.plan]
          );
        }
      }

      if (!subject && nameRaw){
        const nm = String(nameRaw).trim();
        if (nm){
          subject = await get(
            `SELECT id, name, canonical_key, career
              FROM subjects
              WHERE LOWER(name)=LOWER(?)
                AND LOWER(career)=LOWER(?)
                AND CAST(plan AS INTEGER)=CAST(? AS INTEGER)
              LIMIT 1`,
            [nm, user.career, user.plan]
          );
        }
      }

      return subject;
    }

    async function pickQuizQuestion(subject, user){
    const ck = String(subject?.canonical_key || '').trim();
    const car = String(subject?.career || user.career || '').trim();

    let qs = [];
    if (ck && car){
      qs = await loadQuestionsCanonicalDb(ck, car);
    }

    if (!Array.isArray(qs) || qs.length === 0){
      qs = await loadQuestionsDb(subject.name, String(user.plan));
    }
    if (!Array.isArray(qs) || qs.length === 0){
      qs = await loadQuestionsAnyPlanDb(subject.name);
    }
    if (!Array.isArray(qs) || qs.length === 0) return null;

    const pick = qs[(Math.random() * qs.length) | 0];
    const text = String(pick.question || '').trim();
    let options = Array.isArray(pick.choices) ? pick.choices.slice() : [];
    options = options.map(x => String(x ?? '').trim()).filter(Boolean);

    if (!text || options.length < 2) return null;

    shuffleInPlace(options);

    const correctText = String(pick.correct || '').trim();
    let answer = options.findIndex(o => String(o).trim() === correctText);
    if (answer < 0) answer = 0;

    return { question: text, options, answer };
  }

  async function handleQuizRandom(req, res){
    try{
      const user = safeUser(req);
      const subject = await resolveSubjectForQuiz(req, user);
      if (!subject) return res.status(404).json({ ok:false, error:'Materia no encontrada' });

      const q = await pickQuizQuestion(subject, user);
      if (!q) return res.status(404).json({ ok:false, error:'No hay preguntas cargadas para esta materia' });

      return res.json({ ok:true, subjectId: subject.id, subjectName: subject.name, ...q });
    }catch(err){
      console.error('GET /app/quizzes/random error:', err);
      return res.status(500).json({ ok:false, error:'No se pudo obtener pregunta' });
    }
  }

  async function handleQuizList(req, res){
    try{
      const user = safeUser(req);
      const subject = await resolveSubjectForQuiz(req, user);
      if (!subject) return res.status(404).json({ ok:false, error:'Materia no encontrada' });

      const ck  = String(subject?.canonical_key || '').trim();
      const car = String(subject?.career || user.career || '').trim();

      let qs = [];
      if (ck){
        qs = await loadQuestionsCanonicalDb(ck, car);
      }
      if (!Array.isArray(qs) || qs.length === 0){
        qs = await loadQuestionsDb(subject.name, String(user.plan));
      }
      if (!Array.isArray(qs) || qs.length === 0){
        qs = await loadQuestionsAnyPlanDb(subject.name);
      }
      if (!Array.isArray(qs) || qs.length === 0){
        return res.status(404).json({ ok:false, error:'No hay preguntas cargadas para esta materia' });
      }

      const out = qs.slice(0, 50).map(it => ({
        question: String(it.question || ''),
        options: Array.isArray(it.choices) ? it.choices.slice() : [],
        answer: 0
      }));

      return res.json({ ok:true, subjectId: subject.id, subjectName: subject.name, questions: out });
    }catch(err){
      console.error('GET /app/quizzes error:', err);
      return res.status(500).json({ ok:false, error:'No se pudo listar preguntas' });
    }
  }

  // Endpoints que el front ya prueba automáticamente
  router.get('/quizzes/random', handleQuizRandom);
  router.get('/questions/random', handleQuizRandom);
  router.get('/quiz/random', handleQuizRandom);

  router.get('/quizzes', handleQuizList);
  router.get('/questions', handleQuizList);
  // =========================
  // Correlativas (reservado)
  // =========================

  // =========================
  // Finales / Cursadas
  // =========================
  router.get('/finales', async (req, res) => {
    try {
      const user = safeUser(req);

      if (user.role === 'guest') {
        return res.status(200).render('guest-locked', { title: 'Acceso restringido', section: 'Finales' });
      }

      const rows = await all(
        `SELECT f.*, s.name AS subject_name, s.year AS subject_year
           FROM finals f
           LEFT JOIN subjects s ON s.id = f.subject_id
          ORDER BY COALESCE(f.year, s.year, 99), COALESCE(NULLIF(TRIM(f.subject), ''), s.name, '')`
      );

      const normalizeFinalKey = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      const dedupMap = new Map();

      for (const row of rows) {
        const subjectName = String(row.subject || row.subject_name || '').trim() || 'Materia sin nombre';
        const year = row.year || row.subject_year || null;
        const key = `${year || 0}::${normalizeFinalKey(subjectName)}`;

        const current = {
          id: row.id,
          subjectName,
          year,
          regular: String(row.regular || '').trim(),
          libre: String(row.libre || '').trim(),
          allowsLibre: Number(row.rendible || 0) === 1,
          probRegular: Math.max(0, Math.min(100, parseInt(row.prob_regular || '0', 10) || 0)),
          probLibre: Math.max(0, Math.min(100, parseInt(row.prob_libre || '0', 10) || 0)),
          topUnits: (() => {
            try {
              const parsed = JSON.parse(String(row.top_units_json || '[]'));
              return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
            } catch (_) {
              return [];
            }
          })(),
          bestMonths: String(row.best_months || '').split('|').map(s => s.trim()).filter(Boolean),
          worstMonths: String(row.worst_months || '').split('|').map(s => s.trim()).filter(Boolean)
        };

        if (!dedupMap.has(key)) {
          dedupMap.set(key, current);
          continue;
        }

        const prev = dedupMap.get(key);

        dedupMap.set(key, {
          id: prev.id,
          subjectName: prev.subjectName || current.subjectName,
          year: prev.year || current.year,
          regular: prev.regular || current.regular,
          libre: prev.libre || current.libre,
          allowsLibre: prev.allowsLibre || current.allowsLibre,
          probRegular: Math.max(prev.probRegular || 0, current.probRegular || 0),
          probLibre: Math.max(prev.probLibre || 0, current.probLibre || 0),
          topUnits: [...new Set([...(prev.topUnits || []), ...(current.topUnits || [])])].slice(0, 5),
          bestMonths: [...new Set([...(prev.bestMonths || []), ...(current.bestMonths || [])])].slice(0, 6),
          worstMonths: [...new Set([...(prev.worstMonths || []), ...(current.worstMonths || [])])].slice(0, 6)
        });
      }

      const finals = Array.from(dedupMap.values());

      return res.render('finales', {
        title: 'Finales',
        finals
      });
    } catch (err) {
      console.error('GET /app/finales error:', err);
      return res.status(500).send('Error cargando finales');
    }
  });

  router.get('/cursadas', async (req, res) => {
  try {
    const user = safeUser(req);

    if (user.role === 'guest') {
      return res.status(200).render('guest-locked', { title: 'Acceso restringido', section: 'Cursadas' });
    }

    const rows = await all(
      `SELECT c.*, s.name AS subject_name, s.year AS subject_year
         FROM cursadas c
         LEFT JOIN subjects s ON s.id = c.subject_id
        ORDER BY COALESCE(c.year, s.year, 99), COALESCE(NULLIF(TRIM(c.subject), ''), s.name, '')`
    );

    const reactionRows = await all(
      `SELECT cursada_id, emoji, COUNT(*) AS total
         FROM cursada_reactions
        GROUP BY cursada_id, emoji`
    );

    const userReactions = await all(
      `SELECT cursada_id, emoji
         FROM cursada_reactions
        WHERE user_id = ?`,
      [user.id || 0]
    );

    const countsMap = new Map();
    for (const row of reactionRows) {
      if (!countsMap.has(row.cursada_id)) countsMap.set(row.cursada_id, {});
      countsMap.get(row.cursada_id)[row.emoji] = Number(row.total || 0);
    }

    const mineMap = new Map(userReactions.map(r => [r.cursada_id, r.emoji]));
    const order = ['💩', '🤮', '😐', '😍', '🔥'];

    const cursadas = rows.map(row => ({
      id: row.id,
      subjectName: String(row.subject || row.subject_name || '').trim() || 'Materia sin nombre',
      year: row.year || row.subject_year || null,
      commission: String(row.commission || '').trim(),
      scheduleText: String(row.schedule_text || '').trim(),
      approvalPct: Math.max(0, Math.min(100, parseInt(row.approval_pct || '0', 10) || 0)),
      promotionPct: Math.max(0, Math.min(100, parseInt(row.promotion_pct || '0', 10) || 0)),
      classType: String(row.class_type || '').trim(),
      teachers: (() => {
        try {
          const parsed = JSON.parse(String(row.teachers_json || '[]'));
          return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 4) : [];
        } catch (_) {
          return [];
        }
      })(),
      myReaction: mineMap.get(row.id) || '',
      reactions: order.map(emoji => ({ emoji, count: Number((countsMap.get(row.id) || {})[emoji] || 0) }))
    }));

    return res.render('cursadas', {
      title: 'Cursadas',
      cursadas
    });
  } catch (err) {
    console.error('GET /app/cursadas error:', err);
    return res.status(500).send('Error cargando cursadas');
  }
});

  router.post('/cursadas/:id/react', express.json(), async (req, res) => {
    try {
      const user = safeUser(req);
      if (user.role === 'guest' || !user.id) {
        return res.status(403).json({ ok: false, error: 'Necesitás iniciar sesión para calificar.' });
      }

      const id = parseInt(req.params.id, 10);
      const emoji = String(req.body?.emoji || '').trim();
      const allowed = new Set(['💩', '🤮', '😐', '😍', '🔥']);
      if (!Number.isFinite(id) || !allowed.has(emoji)) {
        return res.status(400).json({ ok: false, error: 'Datos inválidos.' });
      }

      const exists = await get(
        `SELECT id
          FROM cursadas
          WHERE id = ?`,
        [id]
      );
      if (!exists) {
        return res.status(404).json({ ok: false, error: 'La cursada no existe.' });
      }

      await run(
        `INSERT INTO cursada_reactions (cursada_id, user_id, emoji, created_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(cursada_id, user_id)
         DO UPDATE SET emoji = excluded.emoji, updated_at = datetime('now')`,
        [id, user.id, emoji]
      );

      const totals = await all(
        `SELECT emoji, COUNT(*) AS total
           FROM cursada_reactions
          WHERE cursada_id = ?
          GROUP BY emoji`,
        [id]
      );

      const counts = { '💩': 0, '🤮': 0, '😐': 0, '😍': 0, '🔥': 0 };
      for (const row of totals) counts[row.emoji] = Number(row.total || 0);

      return res.json({ ok: true, myReaction: emoji, counts });
    } catch (err) {
      console.error('POST /app/cursadas/:id/react error:', err);
      return res.status(500).json({ ok: false, error: 'No se pudo guardar la calificación.' });
    }
  });


  // =========================
  // Admin: eliminar comentario (review)
  // =========================
  router.post('/reviews/:id/delete', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ ok: false, error: 'ID inválido' });


      try { await run(`DELETE FROM review_votes WHERE review_id=?`, [id]); } catch (_) {}
      await run(`DELETE FROM reviews WHERE id=?`, [id]);

      return res.json({ ok: true });
    } catch (err) {
      console.error('POST /app/reviews/:id/delete error:', err);
      return res.status(500).json({ ok: false, error: 'Error eliminando comentario' });
    }
  });

  // =========================
  // Profesores - votos de comentarios
  // =========================
  router.post('/reviews/:id/vote', express.json(), async (req, res) => {
    try {
      const user = safeUser(req);
      if (!user || !user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });

      const rid = parseInt(req.params.id, 10);
      if (Number.isNaN(rid)) return res.status(400).json({ ok: false, error: 'ID inválido' });



      let vote = Number(req.body?.vote || 0);
      if (vote !== 1 && vote !== -1 && vote !== 0) vote = 0;

      const exists = await get(`SELECT id FROM reviews WHERE id=?`, [rid]);
      if (!exists) return res.status(404).json({ ok: false, error: 'Review no encontrada' });

      if (vote === 0) {
        await run(`DELETE FROM review_votes WHERE review_id=? AND user_id=?`, [rid, user.id]);
      } else {
        await run(`DELETE FROM review_votes WHERE review_id=? AND user_id=?`, [rid, user.id]);
        await run(
          `INSERT INTO review_votes (review_id, user_id, vote, created_at)
           VALUES (?,?,?, datetime('now'))`,
          [rid, user.id, vote]
        );
      }

      const counts = await get(
        `SELECT
          (SELECT COUNT(*) FROM review_votes WHERE review_id=? AND vote= 1) AS likes,
          (SELECT COUNT(*) FROM review_votes WHERE review_id=? AND vote=-1) AS dislikes,
          (SELECT vote FROM review_votes WHERE review_id=? AND user_id=?) AS my_vote`,
        [rid, rid, rid, user.id]
      );

      return res.json({
        ok: true,
        likes: Number(counts?.likes || 0),
        dislikes: Number(counts?.dislikes || 0),
        my_vote: counts?.my_vote == null ? 0 : Number(counts.my_vote)
      });
    } catch (err) {
      console.error('POST /app/reviews/:id/vote error:', err);
      return res.status(500).json({ ok: false, error: 'Error guardando voto' });
    }
  });

  // =========================
  // Profesores — agrupado por materias (para la nueva vista)
  // =========================
  router.get('/profesores', async (req, res) => {
    try {
      const user = safeUser(req);
      const q = String(req.query.q || '').trim();

      function normName(s){
    return String(s || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/\s+/g,' ');
  }

  function mergeSubjects(oldTxt, newTxt){
    const set = new Set();
    String(oldTxt||'').split(/[,;\n]/).map(s=>s.trim()).filter(Boolean).forEach(x=>set.add(x));
    String(newTxt||'').split(/[,;\n]/).map(s=>s.trim()).filter(Boolean).forEach(x=>set.add(x));
    return Array.from(set).join(', ');
  }

  async function findProfessorByNorm(nameNorm, career, plan){
    return await get(
      `SELECT id, name, name_norm, photo_url, subjects_text
      FROM professors
      WHERE name_norm = ? AND career = ? AND plan = ?
      LIMIT 1`,
      [nameNorm, career, plan]
    );
  }




      // Flags de columnas (por compatibilidad con DBs viejas)
      const col = {
        corre: await hasColumn('reviews', 'corre'),
        clases: await hasColumn('reviews', 'clases'),
        onda: await hasColumn('reviews', 'onda'),
        tp_imp: await hasColumn('reviews', 'tp_imp'),
        exam_imp: await hasColumn('reviews', 'exam_imp'),
        biblio_imp: await hasColumn('reviews', 'biblio_imp'),
        focus: await hasColumn('reviews', 'focus'),
        mood: await hasColumn('reviews', 'mood')
      };

      // Materias para agrupar en la vista (sin filtrar por career/plan como pediste)
      const materiasRows = await all(`SELECT DISTINCT name FROM subjects ORDER BY name`);
      const materias = materiasRows.map((r) => r.name);

      // ✅ FIX: Traer TODOS los profesores (para PROFESSORS_ALL en el modal — nunca filtrado)
      const allProfRows = await all(
        `SELECT p.id, p.name, p.photo_url, IFNULL(p.subjects_text,'') AS subjects_text,
                IFNULL(p.promotion_avg,'') AS promotion_avg,
                IFNULL(p.approval_pct,'') AS approval_pct
           FROM professors p
          ORDER BY p.name`
      );

      // Traer profesores filtrados (solo para la lista visible cuando hay busqueda q)
      const whereParts = [];
      const params = [];
      if (q) {
        whereParts.push('p.name LIKE ?');
        params.push(`%${q}%`);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const profRows = q
        ? await all(
            `SELECT p.id, p.name, p.photo_url, IFNULL(p.subjects_text,'') AS subjects_text,
                    IFNULL(p.promotion_avg,'') AS promotion_avg,
                    IFNULL(p.approval_pct,'') AS approval_pct
               FROM professors p
               ${where}
              ORDER BY p.name`,
            params
          )
        : allProfRows;

            // ===== Bulk load (evita N+1) =====
      const profesores = [];

      // ✅ FIX: el bulk-load siempre usa TODOS los profesores (allProfRows),
      // así los stats/comments están disponibles para cualquier prof en el modal,
      // incluso cuando la vista está filtrada por busqueda q.
      const profIds = allProfRows.map(p => Number(p.id)).filter(n => Number.isFinite(n));
      const hasIds = profIds.length > 0;

      // Mapas para armar la respuesta final
      const statsByProf = new Map();     // {avg,count, corre,clases,onda,tp_imp,exam_imp,biblio_imp}
      const focusByProf = new Map();     // profId -> {teoria,practica,mixto,total}
      const commentsByProf = new Map();  // profId -> array comments
      const repiteByProf = new Map();    // profId -> {si,no,total}
      const listaByProf = new Map();     // profId -> {si,no,total}

      if (hasIds) {
        const inPlaceholders = profIds.map(() => '?').join(',');

        // 1) Stats + métricas en un solo query
        const statsRows = await all(
          `
          SELECT
            professor_id,
            AVG(rating) AS avg,
            COUNT(*)    AS count,
            AVG(corre)      AS corre,
            AVG(clases)     AS clases,
            AVG(onda)       AS onda,
            AVG(tp_imp)     AS tp_imp,
            AVG(exam_imp)   AS exam_imp,
            AVG(biblio_imp) AS biblio_imp
          FROM reviews
          WHERE professor_id IN (${inPlaceholders})
          GROUP BY professor_id
          `,
          profIds
        );

        for (const r of statsRows) {
          statsByProf.set(Number(r.professor_id), {
            avg: r.avg != null ? Number(r.avg) : 0,
            count: r.count != null ? Number(r.count) : 0,
            corre: r.corre,
            clases: r.clases,
            onda: r.onda,
            tp_imp: r.tp_imp,
            exam_imp: r.exam_imp,
            biblio_imp: r.biblio_imp
          });
        }

        // 2) Focus counts (teoria/practica/mixto) en bulk
        const focusRows = await all(
          `
          SELECT
            professor_id,
            LOWER(TRIM(focus)) AS focus,
            COUNT(*) AS c
          FROM reviews
          WHERE professor_id IN (${inPlaceholders})
            AND TRIM(IFNULL(focus,''))!=''
          GROUP BY professor_id, LOWER(TRIM(focus))
          `,
          profIds
        );

        for (const r of focusRows) {
          const pid = Number(r.professor_id);
          const k = String(r.focus || '').toLowerCase();
          const c = Number(r.c || 0);

          if (!focusByProf.has(pid)) focusByProf.set(pid, { teoria: 0, practica: 0, mixto: 0, total: 0 });
          const obj = focusByProf.get(pid);

          // compat: acepta aliases viejos (teo/prac/mix)
          if (k === 'teoria' || k === 'teo') obj.teoria += c;
          else if (k === 'practica' || k === 'prac') obj.practica += c;
          else if (k === 'mixto' || k === 'mix' || k === 'teorico-practico' || k === 'teorico practico' || k === 'teorico_practico') obj.mixto += c;
          obj.total += c;
        }


        // 2.5) Repite exámenes (sí/no) en bulk — usamos el MODO (mayoría)
        // exam_imp: 0=no sé, 1=sí, 2=no
        const repiteRows = await all(
          `
          SELECT
            professor_id,
            exam_imp AS repite,
            COUNT(*) AS c
          FROM reviews
          WHERE professor_id IN (${inPlaceholders})
            AND exam_imp IN (1,2)
          GROUP BY professor_id, exam_imp
          `,
          profIds
        );

        for (const r of repiteRows) {
          const pid = Number(r.professor_id);
          const v = Number(r.repite);
          const c = Number(r.c || 0);
          if (!repiteByProf.has(pid)) repiteByProf.set(pid, { si: 0, no: 0, total: 0 });
          const obj = repiteByProf.get(pid);
          if (v === 1) obj.si += c;
          else if (v === 2) obj.no += c;
          obj.total += c;
        }
                // 2.8) Toma lista (sí/no) en bulk — guardado en reviews.toma_lista (1=sí,2=no)
        const listaRows = await all(
          `
          SELECT
            professor_id,
            toma_lista AS v,
            COUNT(*) AS c
          FROM reviews
          WHERE professor_id IN (${inPlaceholders})
            AND toma_lista IN (1,2)
          GROUP BY professor_id, toma_lista
          `,
          profIds
        );

        for (const r of listaRows) {
          const pid = Number(r.professor_id);
          const v = Number(r.v);
          const c = Number(r.c || 0);
          if (!listaByProf.has(pid)) listaByProf.set(pid, { si: 0, no: 0, total: 0 });
          const obj = listaByProf.get(pid);
          if (v === 1) obj.si += c;
          else if (v === 2) obj.no += c;
          obj.total += c;
        }
        // 3) Últimos comentarios por prof (hasta 20) en un solo query (window function)
        const viewerUserId = user.id || 0;

        const commentsRows = await all(
          `
          WITH ranked AS (
            SELECT
              r.id,
              r.professor_id,
              r.rating AS stars,
              r.mood   AS mood,
              r.comment,
              strftime('%s', r.created_at) AS ts,
              (SELECT COUNT(*) FROM review_votes v WHERE v.review_id=r.id AND v.vote= 1) AS likes,
              (SELECT COUNT(*) FROM review_votes v WHERE v.review_id=r.id AND v.vote=-1) AS dislikes,
              (SELECT vote FROM review_votes v2 WHERE v2.review_id=r.id AND v2.user_id=?) AS my_vote,
              ROW_NUMBER() OVER (PARTITION BY r.professor_id ORDER BY r.created_at DESC) AS rn
            FROM reviews r
            WHERE r.professor_id IN (${inPlaceholders})
              AND r.comment IS NOT NULL
              AND TRIM(r.comment)!=''
          )
          SELECT
            id, professor_id, stars, mood, comment, ts, likes, dislikes, my_vote
          FROM ranked
          WHERE rn <= 20
          ORDER BY professor_id, rn
          `,
          [viewerUserId, ...profIds]
        );

        for (const row of commentsRows) {
          const pid = Number(row.professor_id);
          if (!commentsByProf.has(pid)) commentsByProf.set(pid, []);
          commentsByProf.get(pid).push({
            id: row.id,
            stars: row.stars,
            mood: row.mood,
            comment: row.comment,
            ts: row.ts,
            likes: row.likes,
            dislikes: row.dislikes,
            my_vote: row.my_vote == null ? 0 : Number(row.my_vote)
          });
        }
      }

      // Helper para construir el objeto de un profesor a partir de una fila DB
      function buildProfObj(p) {
        const pid = Number(p.id);
        const s = statsByProf.get(pid) || { avg: 0, count: 0 };
        const fc = focusByProf.get(pid) || { teoria: 0, practica: 0, mixto: 0, total: 0 };
        const lc = listaByProf.get(pid) || { si: 0, no: 0, total: 0 };
        const lastComments = commentsByProf.get(pid) || [];
        return {
          id: pid,
          name: p.name,
          photo_url: p.photo_url || '',
          subjects_text: p.subjects_text || '',
          promotion_avg: (p.promotion_avg ?? ''),
          approval_pct: (p.approval_pct ?? ''),
          lista_si: Number(lc.si || 0),
          lista_no: Number(lc.no || 0),
          avg: Number(s.avg || 0),
          count: Number(s.count || 0),
          metrics: {
            corre: s.corre != null ? Math.round(Number(s.corre)) : null,
            clases: s.clases != null ? Math.round(Number(s.clases)) : null,
            onda: s.onda != null ? Math.round(Number(s.onda)) : null,
            tp_imp: s.tp_imp != null ? Math.round(Number(s.tp_imp)) : null,
            exam_imp: s.exam_imp != null ? Math.round(Number(s.exam_imp)) : null,
            biblio_imp: s.biblio_imp != null ? Math.round(Number(s.biblio_imp)) : null
          },
          focusCounts: fc,
          focusDominant: (() => {
            const t = Number(fc.teoria || 0), pr = Number(fc.practica || 0), mx = Number(fc.mixto || 0);
            const max = Math.max(t, pr, mx);
            if (max <= 0) return '';
            const winners = [t === max ? 'teoria' : null, pr === max ? 'practica' : null, mx === max ? 'mixto' : null].filter(Boolean);
            return winners.length === 1 ? winners[0] : 'mixto';
          })(),
          repiteCounts: repiteByProf.get(pid) || { si: 0, no: 0, total: 0 },
          repiteDominant: (() => {
            const rc = repiteByProf.get(pid) || { si: 0, no: 0 };
            if (Number(rc.si) > Number(rc.no)) return 1;
            if (Number(rc.no) > Number(rc.si)) return 2;
            return 0;
          })(),
          ratings: lastComments
        };
      }

      // ✅ FIX: construir TODOS los profesores (para PROFESSORS_ALL en el modal)
      const profesoresAll = allProfRows.map(buildProfObj);

      // Armar array final filtrado con el mismo formato que tu EJS espera
      for (const p of profRows) {
        profesores.push(buildProfObj(p));
      }


      // Top del mes (últimos 30 días)
      let topMes = [];
      {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const rows = await all(
          `
          SELECT
            p.id,
            p.name,
            p.photo_url,
            AVG(r.rating)        AS monthAvg,
            COUNT(r.id)          AS monthCount
          FROM professors p
          LEFT JOIN reviews r
            ON r.professor_id = p.id
           AND DATE(r.created_at) >= ?
          GROUP BY p.id
          HAVING monthCount > 0
          ORDER BY monthAvg DESC,
                  monthCount DESC,
                  p.name ASC
          LIMIT 5
          `,
          [cutoffStr]
        );

        topMes = rows.map((x) => ({
          id: x.id,
          nombre: x.name,
          avatar:
            x.photo_url && String(x.photo_url).trim()
              ? x.photo_url
              : `https://ui-avatars.com/api/?name=${encodeURIComponent(x.name)}`,
          monthAvg: Number(x.monthAvg || 0),
          monthCount: Number(x.monthCount || 0)
        }));
      }

      // Compatibilidad con vistas antiguas (paginador)
      const starsRaw = (req.query.stars ?? '').toString().trim();
      const stars = starsRaw ? parseInt(starsRaw, 10) || '' : '';
      const page = Math.max(1, parseInt((req.query.page ?? '1').toString(), 10) || 1);
      const total = Array.isArray(profesores) ? profesores.length : 0;
      const totalPages = 1;

      return res.render('profesores', {
        title: 'Profesores',
        carrera: user.career,
        plan: user.plan,
        materias,
        q,
        stars,
        page,
        totalPages,
        total,
        profesores,       // lista filtrada (para la vista agrupada por materia)
        profesoresAll,    // ✅ FIX: lista completa para PROFESSORS_ALL en el JS del modal
        topMes: topMes || [],
        isAdmin: user.role === 'admin'
      });
    } catch (err) {
      console.error('GET /app/profesores error:', err);
      return res.status(500).send('Error cargando profesores');
    }
  });

    // =========================
    // Crear profesor (acepta varios nombres de campos del form)
    // =========================
    router.post('/profesores', express.urlencoded({ extended: true }), express.json(), ensureAdmin, async (req, res) => {
    try {


      const user = safeUser(req);
      const b = req.body || {};
      const mode = String(b.admin_mode || 'single').trim().toLowerCase();

      const careerRaw = String(b.career ?? '').trim();
      const planRaw = (b.plan ?? '').toString();
      const career = normalizeCareer(careerRaw || user.career || '');
      const plan = parseInt(planRaw, 10) || (Number(user.plan) || 0);

      // ✅ MODO BULK POR MATERIA (1 solo POST)
      if (mode === 'materia') {
        const materia = String(b.bulk_subject || b.materia || '').trim();
        const raw = String(b.names_bulk || '').trim();
        const names = raw.split(/[,;\n]/).map(s => String(s || '').trim()).filter(Boolean);

        if (!materia) return res.status(400).send('Falta materia');
        if (!names.length) return res.status(400).send('Faltan nombres');

        for (const nm of names) {
          await run(
            `INSERT OR IGNORE INTO professors (name, photo_url, career, plan, subjects_text)
            VALUES (?,?,?,?,?)`,
            [nm, '', career || null, plan || null, materia]
          );
        }

        return res.redirect('/app/profesores');
      }

      // ✅ MODO SINGLE
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).send('Falta nombre');

      const subjects_text = String(b.subjects_text || '').trim();
      const photo_url = String(b.photo_url || '').trim();

      await run(
        `INSERT OR IGNORE INTO professors (name, photo_url, career, plan, subjects_text)
        VALUES (?,?,?,?,?)`,
        [name, photo_url || '', career || null, plan || null, subjects_text || '']
      );

      return res.redirect('/app/profesores');
    } catch (err) {
      console.error('POST /app/profesores', err);
      return res.status(500).send('Error creando profesor');
    }
  });
    // =========================
  // Editar profesor (PUT) — admin
  // =========================
  router.put('/profesores/:id', express.urlencoded({ extended: true }), express.json(), ensureAdmin, async (req, res) => {
    try {


      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');

      const b = req.body || {};

      const name = String(b.name ?? b.nombre ?? '').trim();
      const photo_url = String(b.photo_url ?? b.avatar ?? b.photo ?? '').trim();
      const subjects_text = String(b.subjects_text ?? b.materias ?? b.materia ?? '').trim();

      // ✅ Promoción / Aprobación (solo admin)
      const promotion_avg = String(b.promotion_avg ?? b.promo_avg ?? b.promedio_promocion ?? b.promocion_avg ?? b.promocion ?? '').trim();
      let approval_pct = (b.approval_pct ?? b.aprobacion_pct ?? b.approval ?? b.aprobacion ?? '').toString().trim();
      approval_pct = approval_pct === '' ? '' : String(Math.max(0, Math.min(100, parseInt(approval_pct, 10) || 0)));

      if (!name) return res.status(400).send('Falta nombre');

      let name_norm = name;
      try {
        name_norm = String(name)
          .trim()
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, ' ');
      } catch (_) {
        name_norm = String(name).trim().toLowerCase().replace(/\s+/g, ' ');
      }

      await run(
        `UPDATE professors
         SET name=?, name_norm=?, photo_url=?, subjects_text=?, promotion_avg=?, approval_pct=?
         WHERE id=?`,
        [name, name_norm, photo_url || '', subjects_text || '', promotion_avg || '', approval_pct || '', id]
      );

      const wantsJson =
        req.xhr ||
        (req.get('accept') && req.get('accept').includes('application/json')) ||
        (req.is && req.is('application/json'));

      if (wantsJson) return res.json({ ok: true });
      return res.redirect('/app/profesores');
    } catch (err) {
      console.error('PUT /app/profesores/:id error:', err);
      return res.status(500).send('Error guardando profesor');
    }
  });

  // =========================
  // Eliminar profesor (POST legacy)
  // =========================
  router.post('/profesores/:id/delete', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');

      // Borrar reviews asociadas primero (por si hay FK en el futuro)
      try {
        await run(`DELETE FROM reviews WHERE professor_id=?`, [id]);
      } catch (_) {}

      await run(`DELETE FROM professors WHERE id=?`, [id]);
      return res.redirect('/app/profesores');
    } catch (err) {
      console.error('POST /app/profesores/:id/delete error:', err);
      return res.status(500).send('Error eliminando profesor');
    }
  });

  // =========================
  // Eliminar profesor (DELETE) — compatible con method-override ?_method=DELETE
  // =========================
  router.delete('/profesores/:id', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');

      try {
        await run(`DELETE FROM reviews WHERE professor_id=?`, [id]);
      } catch (_) {}

      await run(`DELETE FROM professors WHERE id=?`, [id]);

      const wantsJson =
        req.xhr ||
        (req.get('accept') && req.get('accept').includes('application/json')) ||
        (req.is && req.is('application/json'));
      if (wantsJson) return res.json({ ok: true });

      return res.redirect('/app/profesores');
    } catch (err) {
      console.error('DELETE /app/profesores/:id error:', err);
      return res.status(500).send('Error eliminando profesor');
    }
  });

  // =========================
  // Crear/Reemplazar review (1 por usuario por profesor) — soporta JSON (modal) o form
  // =========================
  router.post('/profesores/:id/review', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const user = safeUser(req);

      const wantsJson =
        req.xhr ||
        (req.get('accept') && req.get('accept').includes('application/json')) ||
        (req.is && req.is('application/json'));

      if (!user || !user.id) {
        if (wantsJson) return res.status(401).json({ ok: false, error: 'No autenticado' });
        return res.redirect('/app/profesores');
      }

      const pid = parseInt(req.params.id, 10);
      if (Number.isNaN(pid)) {
        if (wantsJson) return res.status(400).json({ ok: false, error: 'ID inválido' });
        return res.status(400).send('ID inválido');
      }

      let rating = parseInt(req.body.stars || req.body.rating, 10);
      rating = Math.max(1, Math.min(5, rating || 0));

      const commentRaw = (req.body.comment ?? '').toString();
      const comment = commentRaw.trim() ? commentRaw.trim() : null;

      // ✅ mood/emoji (1..5)
      let mood = req.body.mood ?? req.body.emoji ?? req.body.mood_value ?? req.body.moodEmoji;
      mood = mood == null || mood === '' ? null : Math.max(1, Math.min(5, parseInt(mood, 10) || 0)) || null;

      // sub-scores (1..10)
      const corre = Math.max(1, Math.min(10, parseInt(req.body.corre ?? '0', 10) || 0));
      const clases = Math.max(1, Math.min(10, parseInt(req.body.clases ?? '0', 10) || 0));
      const onda = Math.max(1, Math.min(10, parseInt(req.body.onda ?? '0', 10) || 0));

      // extras
      // tp_imp/biblio_imp se mantienen numéricos (tu UI suele mandar 1..3)
      const tp_imp = Math.max(1, Math.min(10, parseInt(req.body.tp_imp ?? req.body.group_imp ?? '0', 10) || 0));
      const biblio_imp = Math.max(1, Math.min(10, parseInt(req.body.biblio_imp ?? req.body.biblio_level ?? '0', 10) || 0));

      // ✅ repite exámenes: 0 = no sé, 1 = sí, 2 = no
            // ✅ repite exámenes: 0 = no sé, 1 = sí, 2 = no
      let exam_imp = parseInt((req.body.exam_imp ?? req.body.repite ?? req.body.repeats_exam ?? req.body.repeatsExam ?? '0').toString(), 10) || 0;
      exam_imp = [0, 1, 2].includes(exam_imp) ? exam_imp : 0;

      // ✅ toma lista: 0 = no sé, 1 = sí, 2 = no
      let toma_lista = parseInt((req.body.toma_lista ?? req.body.lista ?? req.body.tomaLista ?? '0').toString(), 10) || 0;
      toma_lista = [0, 1, 2].includes(toma_lista) ? toma_lista : 0;

      // ✅ se enfoca en: normalizamos cualquier alias a {teoria|practica|mixto}

      // ✅ se enfoca en: normalizamos cualquier alias a {teoria|practica|mixto}
      let focusRaw = String(req.body.focus ?? req.body.enfoque ?? req.body.focus_type ?? req.body.focusType ?? '').trim().toLowerCase();
      try { focusRaw = focusRaw.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch {}

      let focus = '';
      if (['teoria', 'teo'].includes(focusRaw)) focus = 'teoria';
      else if (['practica', 'prac'].includes(focusRaw)) focus = 'practica';
      else if (['mixto', 'mix', 'teorico-practico', 'teorico practico', 'teorico_practico', 'teorico-practico'].includes(focusRaw)) focus = 'mixto';


      await insertReviewSafely(pid, user.id, {
        rating,
        comment,
        mood,
        corre: corre || null,
        clases: clases || null,
        onda: onda || null,
        tp_imp: tp_imp || null,
        exam_imp: exam_imp || null,
        biblio_imp: biblio_imp || null,
        focus,
        toma_lista: toma_lista || null
      });

      const stats = await get(`SELECT AVG(rating) AS avg, COUNT(*) AS count FROM reviews WHERE professor_id=?`, [pid]);

      if (wantsJson) return res.json({ ok: true, avg: stats?.avg || 0, count: stats?.count || 0 });
      return res.redirect('/app/profesores');
    } catch (err) {
      console.error('POST /app/profesores/:id/review error:', err);

      const wantsJson =
        req.xhr ||
        (req.get('accept') && req.get('accept').includes('application/json')) ||
        (req.is && req.is('application/json'));

      if (wantsJson) return res.status(500).json({ ok: false, error: 'Error creando reseña' });
      return res.status(500).send('Error creando reseña');
    }
  });

  // =========================
  // API alternativa para el modal (PUT /api/profesores/:id/rate)
  // =========================
  router.put('/api/profesores/:id/rate', express.json(), async (req, res) => {
    try {
      const user = safeUser(req);
      if (!user || !user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });

      const pid = parseInt(req.params.id, 10);
      if (Number.isNaN(pid)) return res.status(400).json({ ok: false, error: 'ID inválido' });

      let rating = parseInt(req.body.stars || req.body.rating, 10);
      rating = Math.max(1, Math.min(5, rating || 0));

      const commentRaw = (req.body.comment ?? '').toString();
      const comment = commentRaw.trim() ? commentRaw.trim() : null;

      // ✅ mood/emoji (1..5)
      let mood = req.body.mood ?? req.body.emoji ?? req.body.mood_value ?? req.body.moodEmoji;
      mood = mood == null || mood === '' ? null : Math.max(1, Math.min(5, parseInt(mood, 10) || 0)) || null;

      const corre = Math.max(1, Math.min(10, parseInt(req.body.corre ?? '0', 10) || 0));
      const clases = Math.max(1, Math.min(10, parseInt(req.body.clases ?? '0', 10) || 0));
      const onda = Math.max(1, Math.min(10, parseInt(req.body.onda ?? '0', 10) || 0));

      // tp_imp/biblio_imp se mantienen numéricos (tu UI suele mandar 1..3)
      const tp_imp = Math.max(1, Math.min(10, parseInt(req.body.tp_imp ?? req.body.group_imp ?? '0', 10) || 0));
      const biblio_imp = Math.max(1, Math.min(10, parseInt(req.body.biblio_imp ?? req.body.biblio_level ?? '0', 10) || 0));

      // ✅ repite exámenes: 0 = no sé, 1 = sí, 2 = no
            // ✅ repite exámenes: 0 = no sé, 1 = sí, 2 = no
      let exam_imp = parseInt((req.body.exam_imp ?? req.body.repite ?? req.body.repeats_exam ?? req.body.repeatsExam ?? '0').toString(), 10) || 0;
      exam_imp = [0, 1, 2].includes(exam_imp) ? exam_imp : 0;

      // ✅ toma lista: 0 = no sé, 1 = sí, 2 = no
      let toma_lista = parseInt((req.body.toma_lista ?? req.body.lista ?? req.body.tomaLista ?? '0').toString(), 10) || 0;
      toma_lista = [0, 1, 2].includes(toma_lista) ? toma_lista : 0;

      // ✅ se enfoca en: normalizamos cualquier alias a {teoria|practica|mixto}

      // ✅ se enfoca en: normalizamos cualquier alias a {teoria|practica|mixto}
      let focusRaw = String(req.body.focus ?? req.body.enfoque ?? req.body.focus_type ?? req.body.focusType ?? '').trim().toLowerCase();
      try { focusRaw = focusRaw.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch {}

      let focus = '';
      if (['teoria', 'teo'].includes(focusRaw)) focus = 'teoria';
      else if (['practica', 'prac'].includes(focusRaw)) focus = 'practica';
      else if (['mixto', 'mix', 'teorico-practico', 'teorico practico', 'teorico_practico', 'teorico-practico'].includes(focusRaw)) focus = 'mixto';


      await insertReviewSafely(pid, user.id, {
        rating,
        comment,
        mood,
        corre: corre || null,
        clases: clases || null,
        onda: onda || null,
        tp_imp: tp_imp || null,
        exam_imp: exam_imp || null,
        biblio_imp: biblio_imp || null,
        focus,
        toma_lista: toma_lista || null
      });

      const stats = await get(`SELECT AVG(rating) AS avg, COUNT(*) AS count FROM reviews WHERE professor_id=?`, [pid]);
      return res.json({ ok: true, avg: stats?.avg || 0, count: stats?.count || 0 });
    } catch (err) {
      console.error('PUT /api/profesores/:id/rate error:', err);
      return res.status(500).json({ ok: false, error: 'Error creando reseña' });
    }
  });

  // =========================
  // API Puntos de Juegos
  // =========================
  router.get('/api/juegos/puntos', async (req, res) => {
    try {
      const user = safeUser(req);

if (user.role === 'guest') {
  const pts = Number((req.session && req.session.guestGamePoints) || 0);
  return res.json({ ok:true, points: pts });
}

if (!user.id) return res.status(401).json({ ok:false, error:'No autenticado' });

      let row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
      if (!row) {
        await run(`INSERT OR IGNORE INTO game_scores (user_id, points) VALUES (?, 0)`, [user.id]);
        row = { points: 0 };
      }

      return res.json({ ok: true, points: Number(row.points || 0) });
    } catch (e) {
      console.error('GET /api/juegos/puntos', e);
      return res.status(500).json({ ok: false, error: 'Error leyendo puntos' });
    }
  });

  router.post('/api/juegos/puntos/add', express.json(), async (req, res) => {
  try {
    const user = safeUser(req);
    const delta = Math.max(0, Number((req.body && req.body.delta) || 0));

    if (user.role === 'guest') {
      const prev = Number((req.session && req.session.guestGamePoints) || 0);
      const next = prev + delta;
      if (req.session) req.session.guestGamePoints = next;
      return res.json({ ok:true, points: next });
    }

    if (!user.id) return res.status(401).json({ ok:false, error:'No autenticado' });

    await run(
      `
      INSERT INTO game_scores (user_id, points)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        points = game_scores.points + excluded.points,
        updated_at = CURRENT_TIMESTAMP
      `,
      [user.id, delta]
    );

    const row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
    return res.json({ ok: true, points: Number(row && row.points || 0) });
  } catch (e) {
    console.error('POST /api/juegos/puntos/add', e);
    return res.status(500).json({ ok: false, error: 'Error actualizando puntos' });
  }
});

  router.post('/api/juegos/puntos/set', express.json(), async (req, res) => {
  try {
    const user = safeUser(req);
    const points = Math.max(0, Number((req.body && req.body.points) || 0));

    if (user.role === 'guest') {
      if (req.session) req.session.guestGamePoints = points;
      return res.json({ ok:true, points });
    }

    if (!user.id) return res.status(401).json({ ok:false, error:'No autenticado' });

    await run(
      `
      INSERT INTO game_scores (user_id, points)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        points = excluded.points,
        updated_at = CURRENT_TIMESTAMP
      `,
      [user.id, points]
    );

    return res.json({ ok: true, points });
  } catch (e) {
    console.error('POST /api/juegos/puntos/set', e);
    return res.status(500).json({ ok: false, error: 'Error seteando puntos' });
  }
});

  // =========================
  // Definiciones / Temas — buscar en TXT (R2) por materia
  // =========================
  router.get('/materias/:id/definiciones/search', async (req, res) => {
    try {
      if (req.user && req.user.role === 'guest') {
        return res.status(403).json({ ok:false, error:'Para acceder a Definiciones necesitás crear una cuenta gratis.' });
      }

      const subjectId = parseInt(req.params.id, 10);
      if (Number.isNaN(subjectId)) return res.status(400).json({ ok:false, error:'ID inválido' });

      const modeRaw = String(req.query.mode || 'definicion').toLowerCase();
      const qRaw = String(req.query.q || '').trim();
      const qNorm = normKey(qRaw);

      const subjectKey = await getSubjectKeyById(subjectId);
      const parsed = await loadDefsForSubjectKey(subjectKey);
      const defsArr = Array.from(parsed.defs.values());
      const topicsArr = parsed.topics || [];

      const uniq = (arr) => Array.from(new Set(arr));
 
      // Si no hay query, devolvemos vacío
      if (!qNorm){
        return res.json({ ok:true, mode: modeRaw, q: qRaw, result: null });
      }

      // Helpers para encontrar "mejor match"
      const bestDef = () => {
        if (parsed.defs.has(qNorm)) return parsed.defs.get(qNorm);
        return defsArr.find(d => (d.titleNorm || normKey(d.title)).includes(qNorm))
            || defsArr.find(d => (d.fullTextNorm || normKey(d.title + '\n' + d.body)).includes(qNorm))
            || null;
      };

      const bestTopic = () => {
        const exact = topicsArr.find(t => t.titleNorm === qNorm);
        if (exact) return exact;
        return topicsArr.find(t => (t.titleNorm || normKey(t.title)).includes(qNorm))
            || topicsArr.find(t => (t.fullTextNorm || normKey(t.title + '\n' + t.body)).includes(qNorm))
            || null;
      };

      // Primario según modo (pero si no existe, cae al otro)
      let primary = null;
      let primaryType = null;

      if (modeRaw === 'tema') {
        primary = bestTopic() || bestDef();
        primaryType = primary && primary.body !== undefined && primary.title && (primary.related !== undefined || primary.fullTextNorm) && !parsed.defs.has(primary.titleNorm || normKey(primary.title))
          ? 'tema'
          : (primary ? 'definicion' : null);
        // Si vino de bestTopic es tema, si vino de bestDef es definicion
        if (primary && topicsArr.includes(primary)) primaryType = 'tema';
        if (primary && defsArr.includes(primary)) primaryType = 'definicion';
      } else {
        primary = bestDef() || bestTopic();
        if (primary && defsArr.includes(primary)) primaryType = 'definicion';
        if (primary && topicsArr.includes(primary)) primaryType = 'tema';
      }

      if (!primary){
        return res.json({
          ok:true,
          mode: modeRaw,
          q: qRaw,
          result: {
            primary: null,
            relatedTopics: [],
            relatedDefinitions: [],
            mentionedInTopics: [],
            mentionedInDefinitions: [],
          }
        });
      }

      const primaryTitleNorm =
        primaryType === 'tema'
          ? (primary.titleNorm || normKey(primary.title))
          : (primary.titleNorm || normKey(primary.title));

      const primaryTextNorm =
        primaryType === 'tema'
          ? (primary.fullTextNorm || normKey(primary.title + '\n' + (primary.body || '')))
          : (primary.fullTextNorm || normKey(primary.title + '\n' + (primary.body || '')));

      // ✅ RELACIONADOS: si el título del otro aparece dentro del texto del primario
      const relatedTopics = uniq(
        topicsArr
          .filter(t => (t.titleNorm || normKey(t.title)) !== primaryTitleNorm)
          .filter(t => primaryTextNorm.includes(t.titleNorm || normKey(t.title)))
          .map(t => t.title)
      ).slice(0, 30);

      const relatedDefinitions = uniq(
        defsArr
          .filter(d => (d.titleNorm || normKey(d.title)) !== primaryTitleNorm)
          .filter(d => primaryTextNorm.includes(d.titleNorm || normKey(d.title)))
          .map(d => d.title)
      ).slice(0, 30);

      // ✅ MENCIONADO EN OTROS: el primario aparece mencionado en otros items
      const mentionedInTopics = uniq(
        topicsArr
          .filter(t => (t.titleNorm || normKey(t.title)) !== primaryTitleNorm)
          .filter(t => (t.fullTextNorm || normKey(t.title + '\n' + (t.body || ''))).includes(primaryTitleNorm))
          .map(t => t.title)
      ).slice(0, 30);

      const mentionedInDefinitions = uniq(
        defsArr
          .filter(d => (d.titleNorm || normKey(d.title)) !== primaryTitleNorm)
          .filter(d => (d.fullTextNorm || normKey(d.title + '\n' + (d.body || ''))).includes(primaryTitleNorm))
          .map(d => d.title)
      ).slice(0, 30);

      return res.json({
        ok: true,
        mode: primaryType,
        q: qRaw,
        result: {
          primary: primaryType === 'tema'
            ? { type:'tema', title: primary.title, body: primary.body }
            : { type:'definicion', title: primary.title, body: primary.body },
          relatedTopics,
          relatedDefinitions,
          mentionedInTopics,
          mentionedInDefinitions
        }
      });
    } catch (err) {
      console.error('GET /app/materias/:id/definiciones/search error:', err);
      return res.status(500).json({ ok:false, error:'Error buscando' });
    }
  });

  // =========================
  // Admin: ver contenido TXT de un documento "definiciones"
  // =========================
  router.get('/materias/:id/definiciones/doc/:docId/text', ensureAdmin, async (req, res) => {
    try {
      const subjectId = parseInt(req.params.id, 10);
      const docId = parseInt(req.params.docId, 10);
      if (Number.isNaN(subjectId) || Number.isNaN(docId)) return res.status(400).send('ID inválido');

      const subjectKey = await getSubjectKeyById(subjectId);

            const doc = await get(
        `SELECT d.id, d.title, d.filename, d.mimetype
           FROM documents d
          WHERE d.id=?
            AND d.category='definiciones'
            AND COALESCE(NULLIF(d.subject_key,''), '')=?`,
        [docId, subjectKey]
      );
      if (!doc) return res.status(404).send('No encontrado');

      if (!hasR2()) return res.status(500).send('R2 no configurado');

      const txt = await r2GetText(doc.filename);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(txt);
    } catch (err) {
      console.error('GET doc text error:', err);
      return res.status(500).send('Error leyendo TXT');
    }
  });

  // =========================
  // Admin: eliminar TXT (DB + R2) de "definiciones"
  // =========================
  router.post('/materias/:id/definiciones/doc/:docId/delete', ensureAdmin, async (req, res) => {
    try {
      const subjectId = parseInt(req.params.id, 10);
      const docId = parseInt(req.params.docId, 10);
      if (Number.isNaN(subjectId) || Number.isNaN(docId)) return res.status(400).json({ ok:false, error:'ID inválido' });

      const subjectKey = await getSubjectKeyById(subjectId);

            const doc = await get(
        `SELECT d.id, d.title, d.filename, d.mimetype
           FROM documents d
          WHERE d.id=?
            AND d.category='definiciones'
            AND COALESCE(NULLIF(d.subject_key,''), '')=?`,
        [docId, subjectKey]
      );
      if (!doc) return res.status(404).json({ ok:false, error:'No encontrado' });

      await run(`DELETE FROM documents WHERE id=?`, [docId]);
      __defsCache.delete(subjectKey);

      if (doc.filename && String(doc.filename).startsWith('docs/')) {
        await r2Delete(doc.filename);
      }

      // Si viene desde un <form> HTML, redirigimos; si es fetch/XHR devolvemos JSON.
      const wantsJson = (req.get('accept') || '').includes('application/json') || req.xhr;
      if (wantsJson) return res.json({ ok:true });
      return res.redirect(`/app/materias/${subjectId}?category=definiciones`);
    } catch (err) {
      console.error('POST delete txt error:', err);
      return res.status(500).json({ ok:false, error:'Error eliminando' });
    }
  });

  return router;
};
