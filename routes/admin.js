// routes/admin.js
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const fsp     = require('fs/promises');
const bcrypt  = require('bcrypt');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB
const { all, get, run } = require('../models/db');
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

/* ========= Correlativas: helpers (con migración v2) ========= */
async function ensureCorrelativesTable(){
  // Chequear si la tabla existe y si tiene la columna subject_id
  const info = await all(`PRAGMA table_info(correlatives)`);
  const hasTable = Array.isArray(info) && info.length > 0;
  const hasSubjectId = hasTable && info.some(c => String(c.name) === 'subject_id');

  if (!hasTable){
    // Crear nueva tabla v2
    await run(`
      CREATE TABLE IF NOT EXISTS correlatives (
        subject_id     INTEGER PRIMARY KEY,
        regularizada   TEXT,
        final_aprobado TEXT,
        updated_at     TEXT
      )
    `);
    return;
  }

  if (!hasSubjectId){
    // Migrar de esquema viejo a v2
    await run('BEGIN');
    try{
      // Crear tabla nueva
      await run(`
        CREATE TABLE IF NOT EXISTS correlatives_v2 (
          subject_id     INTEGER PRIMARY KEY,
          regularizada   TEXT,
          final_aprobado TEXT,
          updated_at     TEXT
        )
      `);

      // Intentar detectar columnas del esquema viejo
      // Suposición más común: (subject TEXT, regularizada TEXT, final_aprobado TEXT, updated_at TEXT)
      const oldRows = await all(`SELECT * FROM correlatives`);
      for (const r of oldRows){
        const subjectName =
          (r.subject?.toString?.() ?? r.name?.toString?.() ?? '').trim();
        if (!subjectName) continue;

        const subj = await get(
          `SELECT id FROM subjects WHERE LOWER(name)=LOWER(?)`,
          [subjectName]
        );
        if (!subj || !subj.id) continue;

        await run(
          `INSERT OR REPLACE INTO correlatives_v2 (subject_id, regularizada, final_aprobado, updated_at)
           VALUES (?,?,?,?)`,
          [
            subj.id,
            (r.regularizada ?? ''),
            (r.final_aprobado ?? ''),
            (r.updated_at ?? new Date().toISOString())
          ]
        );
      }

      // Reemplazar tabla
      await run(`DROP TABLE correlatives`);
      await run(`ALTER TABLE correlatives_v2 RENAME TO correlatives`);
      await run('COMMIT');
    }catch(e){
      await run('ROLLBACK');
      throw e;
    }
  }
}

function parseCorrelativasTxt(raw){
  // Devuelve [{ name, career, plan, regList[], finalList[] }]
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const blocks = text.split(/\n{2,}/); // bloques separados por líneas en blanco

  const out = [];
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

      // Primera línea como nombre si no se especifica "Materia:"
      if (i === 0 && !/^materia\s*:/i.test(ln)){
        name = ln;
        continue;
      }

      const mMateria = ln.match(/^materia\s*:\s*(.+)$/i);
      const mCarrera = ln.match(/^carrera\s*:\s*(.+)$/i);
      const mPlan    = ln.match(/^plan\s*:\s*(.+)$/i);
      const mReg     = ln.match(/^regularizada\s*:\s*(.*)$/i);
      const mFin     = ln.match(/^(final\s+aprobado|final)\s*:\s*(.*)$/i);

      if (mMateria) name   = (mMateria[1] || '').trim();
      if (mCarrera) career = (mCarrera[1] || '').trim();
      if (mPlan)    plan   = (mPlan[1] || '').trim();
      if (mReg)     reg    = (mReg[1] || '').trim();
      if (mFin)     fin    = (mFin[2] || mFin[1] || '').toString().replace(/^final\s+aprobado\s*:\s*/i,'').trim();
    }

    if (!name) continue;
    const regList  = reg ? reg.split(/\s*,\s*/).filter(Boolean) : [];
    const finalList= fin ? fin.split(/\s*,\s*/).filter(Boolean) : [];
    out.push({ name, career, plan, regList, finalList });
  }
  return out;
}

async function findSubjectIdByHints({ name, career, plan }){
  // Con carrera/plan si vienen en el archivo, hacemos match exacto;
  // si no, caemos a match por nombre solamente.
  if (career && plan){
    const subj = await get(
      `SELECT id FROM subjects WHERE LOWER(name)=LOWER(?) AND LOWER(career)=LOWER(?) AND CAST(plan AS TEXT)=?`,
      [name, normalizeCareer(career), String(plan)]
    );
    if (subj && subj.id) return subj.id;
  }
  // Fallback: solo nombre
  const s2 = await get(`SELECT id FROM subjects WHERE LOWER(name)=LOWER(?)`, [name]);
  return s2?.id || null;
}

async function upsertCorrelativasFromBlocks(blocks){
  await ensureCorrelativesTable();

  await run('BEGIN');
  try{
    let updated = 0, notFound = [];
    for (const b of blocks){
      const subjectId = await findSubjectIdByHints(b);
      if (!subjectId){ notFound.push(b.name); continue; }

      const regText  = (b.regList || []).join(', ');
      const finText  = (b.finalList || []).join(', ');
      const now      = new Date().toISOString();

      await run(`
        INSERT INTO correlatives (subject_id, regularizada, final_aprobado, updated_at)
        VALUES (?,?,?,?)
        ON CONFLICT(subject_id) DO UPDATE SET
          regularizada=excluded.regularizada,
          final_aprobado=excluded.final_aprobado,
          updated_at=excluded.updated_at
      `, [subjectId, regText, finText, now]);

      updated++;
    }
    await run('COMMIT');
    return { updated, notFound };
  }catch(e){
    await run('ROLLBACK');
    throw e;
  }
}

/* ========= Subjects: migración para relajar CHECK del plan ========= */
/**
 * Algunas bases tienen CHECK: "plan IN (7,8)". Esto rompe si querés crear plan 6, 9, etc.
 * Esta rutina detecta esa restricción en el SQL de creación y recrea la tabla sin el CHECK.
 */
async function ensureSubjectsPlanRelaxed(){
  const row = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='subjects'`);
  if (!row || !row.sql) return;

  const sql = String(row.sql);
  const hasCheck = /CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/i.test(sql);
  if (!hasCheck) return;

  // Crear definición nueva sin el CHECK
  const newCreate = sql
    .replace(/CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/ig, '')
    .replace(/CREATE\s+TABLE\s+("?subjects"?)/i, 'CREATE TABLE subjects_v2');

  await run('BEGIN');
  try{
    await run(newCreate);
    // Copiar datos 1:1
    await run(`INSERT INTO subjects_v2 SELECT * FROM subjects`);
    await run(`DROP TABLE subjects`);
    await run(`ALTER TABLE subjects_v2 RENAME TO subjects`);
    await run('COMMIT');
    console.log('[migración] subjects: CHECK plan IN (7,8) removido');
  }catch(e){
    await run('ROLLBACK');
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
    await run('ROLLBACK');
    console.error('[migración] users: no se pudo relajar CHECK de career:', e?.message);
    throw e;
  }
}

/* ===== finals: asegurar tabla/columnas requeridas ===== */
async function ensureFinalsSchema(){
  // Si no existe, la creamos completa
  const exists = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='finals'`);
  if (!exists) {
    await run(`
      CREATE TABLE IF NOT EXISTS finals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id  INTEGER,
        year        INTEGER,
        modalidad   TEXT,
        libre       TEXT,
        regular     TEXT,
        career      TEXT,
        exam_type   TEXT NOT NULL DEFAULT 'escrito y oral' CHECK (exam_type IN ('escrito','oral','escrito y oral')),
        created_at  TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[migración] finals: tabla creada con exam_type y CHECK');
    return;
  }

  // Si existe, agregamos las columnas que falten
  const cols = await all(`PRAGMA table_info(finals)`);
  const has = (name) => cols.some(c => String(c.name) === String(name));

  if (!has('subject_id')) await run(`ALTER TABLE finals ADD COLUMN subject_id INTEGER`);
  if (!has('year'))       await run(`ALTER TABLE finals ADD COLUMN year INTEGER`);
  if (!has('modalidad'))  await run(`ALTER TABLE finals ADD COLUMN modalidad TEXT`);
  if (!has('libre'))      await run(`ALTER TABLE finals ADD COLUMN libre TEXT`);
  if (!has('regular'))    await run(`ALTER TABLE finals ADD COLUMN regular TEXT`);
  if (!has('career'))     await run(`ALTER TABLE finals ADD COLUMN career TEXT`);
  if (!has('exam_type'))  await run(`ALTER TABLE finals ADD COLUMN exam_type TEXT DEFAULT 'escrito y oral'`);
  if (!has('created_at')) await run(`ALTER TABLE finals ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP`);
}

/* ===== finals: asegurar tabla (legacy helper) ===== */
async function ensureFinalsTable(){
  const info = await all(`PRAGMA table_info(finals)`);
  if (Array.isArray(info) && info.length > 0) return;
  await run(`
    CREATE TABLE IF NOT EXISTS finals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id  INTEGER,
      year        INTEGER,
      modalidad   TEXT,
      libre       TEXT,
      regular     TEXT,
      career      TEXT,
      exam_type   TEXT NOT NULL DEFAULT 'escrito y oral' CHECK (exam_type IN ('escrito','oral','escrito y oral')),
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[migración] finals: tabla creada');
}

/* ========= Router ========= */
module.exports = () => {
  const router = express.Router();

  // Ejecutar migraciones sin bloquear
  (async()=>{ try{ await ensureUsersPhoneColumn(); }catch(_){ /* noop */ } })();
  (async()=>{ try{ await ensureUsersCareerRelaxed(); }catch(_){ /* noop */ } })();
  (async()=>{ try{ await ensureFinalsTable(); }catch(_){ /* noop */ } })();
  (async()=>{ try{ await ensureFinalsSchema(); }catch(_){ /* noop */ } })();

  /* =========================================================
   *        C O R R E L A T I V A S   (UPLOAD .TXT) (ADMIN)
   * ========================================================= */

  // POST /admin/correlativas/upload
  // Espera un input file name="correlativas" con texto en bloques:
  //   Materia X
  //   regularizada: A, B
  //   final aprobado: C
  //
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
      if (!blocks.length){
        return res.status(400).send('Formato vacío o inválido');
      }
      const { updated, notFound } = await upsertCorrelativasFromBlocks(blocks);

      const wantsJson = (req.headers.accept||'').includes('application/json') ||
                        (req.headers['content-type']||'').includes('application/json');
      if (wantsJson){
        return res.json({ ok:true, updated, notFound });
      }
      const q = new URLSearchParams({
        ok:'1',
        updated:String(updated),
        nf:String(notFound.length)
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

  // Crear carrera/plan + materias desde .txt
  router.post('/careers/create', upload.single('subjectsFile'), async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).send('Solo administrador');
      }

      // Asegurar que la tabla subjects NO tenga CHECK plan IN (7,8)
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

      // Parseo de líneas: "Materia X - Año Y" (o "Materia X - Y")
      const lines = txt.replace(/\r\n/g,'\n').split('\n').map(s=>s.trim()).filter(Boolean);

      const parsed = [];
      const rx = /^(.*?)[\s\-–—]+año\s*([1-9]\d*)$/i; // "Materia - Año 3"
      const rx2= /^(.*?)\s*-\s*([1-9]\d*)$/i;         // fallback: "Materia - 3"
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

      // Insertar/actualizar subjects (por nombre+career+plan)
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
      // Si falló por constraint de plan, intentar informar claro
      if (String(e && e.message || '').includes('CHECK constraint failed') && String(e.message).includes('plan IN (7,8)')){
        return res.status(400).send('El esquema de la base restringe el plan a (7,8). Ya agregamos una migración automática para quitarlo, pero falló. Revisá permisos del archivo .sqlite o ejecutá manualmente la migración.');
      }
      console.error('❌ /admin/careers/create error:', e);
      return res.status(500).send('Error creando carrera: ' + (e.message||''));
    }
  });

  // Listar carreras/planes (para la grilla del modal)
  // GET /admin/careers/list  → { ok, items: [{career, plan, subjects}] }
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

  // Borrar una carrera+plan completa (subjects, docs, correlativas, edges)
  // DELETE /admin/careers  body: { career, plan }
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

      // Obtener subjects a borrar
      const subs = await all(
        `SELECT id FROM subjects WHERE LOWER(career)=LOWER(?) AND plan=?`,
        [career, plan]
      );
      if (!subs.length){
        return res.json({ ok:true, deletedSubjects:0, deletedDocs:0, deletedCorr:0, deletedEdges:0 });
      }

      const ids = subs.map(s=>s.id);
      let deletedDocs = 0;

      await run('BEGIN');
      try{
        // Borrar documentos y archivos
        const docs = await all(`SELECT id, filename FROM documents WHERE subject_id IN (${ids.map(()=>'?').join(',')})`, ids);
        for (const d of docs){
          if (d && d.filename){
            try{ await safeUnlinkMany(d.filename); }catch(_){}
          }
        }
        await run(`DELETE FROM documents WHERE subject_id IN (${ids.map(()=>'?').join(',')})`, ids);
        deletedDocs = docs.length;

        // Borrar correlativas y edges asociados
        await run(`DELETE FROM correlatives WHERE subject_id IN (${ids.map(()=>'?').join(',')})`, ids).catch(()=>{});
        await run(`DELETE FROM correlatives_edges WHERE subject_id IN (${ids.map(()=>'?').join(',')}) OR depends_on_id IN (${ids.map(()=>'?').join(',')})`, [...ids, ...ids]).catch(()=>{});

        // Borrar subjects
        await run(`DELETE FROM subjects WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);

        await run('COMMIT');
      }catch(e){
        await run('ROLLBACK');
        throw e;
      }

      return res.json({
        ok:true,
        deletedSubjects: ids.length,
        deletedDocs,
        deletedCorr: 'ok',
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

  // GET /admin/users  → lista JSON con filtro ?q=
  router.get('/users', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const like = `%${q}%`;
      const rows = await all(
        `
        SELECT id, name, email, phone, role, career, plan, created_at
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

  // PUT /admin/users/:id  → actualizar name, email, phone, (new) password, career, plan
  router.put('/users/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok:false, error:'ID inválido' });

      const name    = String(req.body.name    || '').trim();
      const email   = String(req.body.email   || '').trim();
      const phone   = String(req.body.phone   || '').trim();
      const career  = String(req.body.career  || '').trim();
      const plan    = parseInt(req.body.plan, 10) || 0;
      const newPass = String(req.body.password || '').trim();

      if (!name || !email || !career || !plan) {
        return res.status(400).json({ ok:false, error:'Faltan campos' });
      }

      // === VALIDACIÓN: la combinación carrera/plan debe existir en subjects ===
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
        `SELECT id, name, email, phone, role, career, plan, created_at FROM users WHERE id=?`,
        [id]
      );
      return res.json({ ok:true, user: row });
    } catch (e) {
      console.error('PUT /admin/users/:id error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo actualizar el usuario' });
    }
  });

  // DELETE /admin/users/:id  → elimina usuario (bloqueamos borrar admins)
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

  // Crear materia
  router.post('/materias', async (req, res) => {
    try {
      const { name, year, career, plan } = req.body;
      if (!name || !year || !career || !plan) {
        return res.status(400).send('Faltan campos obligatorios');
      }
      await run(
        `INSERT INTO subjects (name, year, career, plan) VALUES (?,?,?,?)`,
        [ String(name).trim(), parseInt(year,10), normalizeCareer(career), parseInt(plan,10) ]
      );
      return res.redirect('/app/materias');
    } catch (err) {
      console.error('❌ Error creando materia:', err);
      return res.status(500).send('Error creando materia');
    }
  });

  // Actualizar materia
  router.post('/subjects/:id/update', async (req, res) => {
    try {
      const { name, year, career, plan } = req.body;
      const subject = await get(`SELECT * FROM subjects WHERE id=?`, [req.params.id]);
      if (!subject) return res.status(404).send('Materia no encontrada');

      const newName   = name   !== undefined ? String(name).trim()     : subject.name;
      const newYear   = year   !== undefined ? parseInt(year,10)       : subject.year;
      const newCareer = career !== undefined ? normalizeCareer(career) : subject.career;
      const newPlan   = plan   !== undefined ? parseInt(plan,10)       : subject.plan;

      await run(`UPDATE subjects SET name=?, year=?, career=?, plan=? WHERE id=?`,
        [newName, newYear, newCareer, newPlan, req.params.id]);

      return res.redirect(req.query.redirect || '/app/materias');
    } catch (err) {
      console.error('❌ Error actualizando materia:', err);
      return res.status(500).send('Error actualizando materia');
    }
  });

  // Eliminar materia + documentos asociados
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

  // Renombrar documento
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

  // Eliminar documento por id (HTML o JSON)
  router.post('/docs/:id/delete', async (req, res) => {
    try {
      const doc = await get(`SELECT id, filename FROM documents WHERE id=?`, [req.params.id]);
      if (doc) {
        if (doc.filename) { try { await safeUnlinkMany(doc.filename); } catch(_){} }
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

  // Compatibilidad: eliminar documento por JSON { id }
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

  // Renombrar grupo de resúmenes
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

  // Eliminar grupo completo
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
   *            F I N A L E S   (ADMIN)
   * ========================================================= */

  // Crear fila de finales (desde el formulario de vistas/finales.ejs)
  // Campos esperados:
  //  - subject_id (number, requerido)
  //  - year (number, opcional/nullable)
  //  - modalidad (text, requerido)
  //  - info_libre (text)
  //  - info_regular (text)
  //  - career (text)
  // NOTA: el form no pide exam_type, así que lo forzamos a un default válido si no viene.
  router.post('/finales', async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).send('Solo administrador');
      }

      const subject_id = parseInt(req.body.subject_id, 10);
      const year       = req.body.year ? parseInt(req.body.year, 10) : null;
      const modalidad  = String(req.body.modalidad || '').trim();         // libre / regular / libre y regular
      const libre      = String(req.body.libre || req.body.info_libre || '').trim();
      const regular    = String(req.body.regular || req.body.info_regular || '').trim();
      const careerRaw  = String(req.body.career || '').trim();
      const career     = careerRaw ? normalizeCareer(careerRaw) : null;

      // exam_type: cumplir con CHECK (escrito, oral, escrito y oral)
      const examTypeRaw = String(req.body.exam_type || '').trim().toLowerCase();
      const allowedExamTypes = new Set(['escrito','oral','escrito y oral']);
      let exam_type = examTypeRaw.replace(/\s+/g,' ').replace('escrito y  oral','escrito y oral');
      if (!allowedExamTypes.has(exam_type)) {
        exam_type = 'escrito y oral';
      }

      if (!subject_id || !modalidad){
        return res.status(400).send('Faltan campos obligatorios (materia y modalidad).');
      }

      await run(
        `INSERT INTO finals (subject_id, year, modalidad, libre, regular, career, exam_type)
         VALUES (?,?,?,?,?,?,?)`,
        [ subject_id, year, modalidad, libre, regular, career, exam_type ]
      );

      return res.redirect('/app/finales');
    }catch(e){
      console.error('❌ /admin/finales (crear) error:', e);
      return res.status(500).send('Error creando final: ' + (e.message || ''));
    }
  });

  // ================= Finales: borrado masivo (solo admin) =================
  // DELETE /admin/finales/batch   { ids: number[] }
  router.delete('/finales/batch', async (req, res) => {
    try{
      if (!req.user || req.user.role !== 'admin'){
        return res.status(403).json({ ok:false, error:'Solo administrador' });
      }
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => parseInt(x,10)).filter(Number.isFinite) : [];
      if (!ids.length){
        return res.status(400).json({ ok:false, error:'Faltan ids' });
      }

      // Si tu tabla 'finals' guarda archivos (filename), borralos del disco
      let removedFiles = 0;
      try{
        const rows = await all(`SELECT id, filename FROM finals WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
        for (const r of rows){
          if (r?.filename){
            try { const ok = await safeUnlinkMany(r.filename); if (ok) removedFiles++; } catch(_){}
          }
        }
      }catch(_){ /* si no existe filename, no pasa nada */ }

      await run(`DELETE FROM finals WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);

      return res.json({ ok:true, deleted: ids.length, removedFiles });
    }catch(e){
      console.error('DELETE /admin/finales/batch error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo eliminar' });
    }
  });
  
  return router;
};