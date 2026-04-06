// routes/preguntas.js — DB version (usa SQLite subjects)
// - Materias y Planes salen de la base de datos real (tabla subjects)
// - SSR prellena selects y /meta expone datos por AJAX
// - Guarda .txt/.docx en /preguntas/<materia>-<plan>.txt
// - También persiste en Turso (questions_bank) para que se vea en Koyeb/Render

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { all, get, run } = require('../models/db');
const { PREG_DIR, normalizeName, parseTxt } = require('../lib/questions');

/* -------------------- Auth simple -------------------- */
function ensureAdmin(req, res, next){
  try{
    const u = req.user || (req.session && req.session.user);
    if (u && (u.isAdmin || u.role === 'admin')) return next();
  } catch(e){}
  return res.status(403).send('Solo administrador');
}

/* -------------------- Carga desde DB -------------------- */
async function loadMetaDesdeDB(){
  // Traemos todas las combinaciones existentes para construir:
  // - materias: lista única de names
  // - planesGlobal: lista única de plan
  // - planesByMateria: { name: [planes...] }
  const rows = await all(`SELECT name, plan FROM subjects`);
  const materiasSet = new Set();
  const planesSet   = new Set();
  const map = new Map(); // name -> Set(planes)

  for (const r of rows){
    const name = String(r.name || '').trim();
    const plan = parseInt(r.plan, 10) || 0;
    if (!name) continue;
    materiasSet.add(name);
    planesSet.add(plan);
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(plan);
  }

  const materias = Array.from(materiasSet).sort((a,b)=>a.localeCompare(b,'es'));
  const planesGlobal = Array.from(planesSet).sort((a,b)=> (a-b));
  const planesByMateria = {};
  for (const [k,set] of map.entries()){
    planesByMateria[k] = Array.from(set).sort((a,b)=> (a-b));
  }
  return { materias, planesGlobal, planesByMateria };
}

/* -------------------- Upload config -------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(txt|docx)$/i.test(file.originalname || '');
    if (!ok) return cb(new Error('Formato no permitido. Usá .txt o .docx'));
    cb(null, true);
  }
});

async function extractText(file){
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.txt')) return file.buffer.toString('utf8');
  if (name.endsWith('.docx')){
    try{
      const unzipper = require('unzipper');
      return await new Promise((resolve, reject) => {
        const tmp = require('stream').Readable.from(file.buffer);
        tmp.pipe(unzipper.Parse())
          .on('entry', function (entry) {
            const fileName = entry.path;
            if (fileName === 'word/document.xml'){
              const bufs = [];
              entry.on('data', d => bufs.push(d));
              entry.on('end', () => {
                const xml = Buffer.concat(bufs).toString('utf8');
                const text = xml.replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n').trim();
                resolve(text);
              });
            } else entry.autodrain();
          })
          .on('error', reject);
      });
    } catch(e){
      console.warn('Para .docx instalá: npm i unzipper');
      return '';
    }
  }
  return '';
}

/* -------------------- Router -------------------- */
module.exports = () => {
  const router = express.Router();

  // SSR prellenado desde DB
  router.get('/upload', ensureAdmin, async (req, res) => {
    const meta = await loadMetaDesdeDB();
    res.render('preguntas-upload', {
      title: 'Cargar preguntas',
      materias: meta.materias,
      planes: meta.planesGlobal,
      user: req.user || (req.session && req.session.user) || null
    });
  });

  // Meta AJAX
  router.get('/meta', ensureAdmin, async (req, res) => {
    const meta = await loadMetaDesdeDB();
    res.json({ ok:true, ...meta });
  });

  // Guardar archivo
  router.post('/upload', ensureAdmin, upload.single('archivo'), async (req, res) => {
    try{
      const materia = String(req.body.materia || '').trim();
      const plan    = String(req.body.plan    || '').trim();
      if (!materia || !plan) return res.status(400).send('Materia y Plan son obligatorios');
      if (!req.file) return res.status(400).send('Falta el archivo');

      let raw = await extractText(req.file);
      raw = String(raw || '').trim();
      if (!raw) return res.status(400).send('No se pudo leer el archivo (subí .txt o instala "unzipper" para .docx)');

      const parsed = parseTxt(raw);
      if (!parsed.length) return res.status(400).send('No se detectaron preguntas. Verificá el formato.');

      // Guardado local (opcional, útil como backup en tu PC)
      const fname = normalizeName(materia) + '-' + normalizeName(plan) + '.txt';
      const dest  = path.join(PREG_DIR, fname);
      try{
        fs.writeFileSync(dest, raw, 'utf8');
      } catch(e){
        // En Koyeb/Render el filesystem puede ser read-only o efímero: no rompemos por esto
        console.warn('No se pudo escribir en disco /preguntas (ok en servidores):', e?.message || e);
      }

      // ✅ Airbag: asegurar tabla aunque init no haya corrido o estés apuntando a una DB nueva
      await run(`
        CREATE TABLE IF NOT EXISTS questions_bank (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_key TEXT,
          career TEXT,
          subject_name TEXT NOT NULL,
          plan TEXT NOT NULL DEFAULT '',
          raw_text TEXT NOT NULL,
          questions_json TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now')),
          created_by INTEGER,
          UNIQUE(canonical_key, career)
        )
      `);

      await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_bank_canonical_career ON questions_bank(canonical_key, career)`);

            const defaultCanonical = normalizeName(materia).replace(/-/g, '_');

      const subjectRows = await all(
        `SELECT DISTINCT
            COALESCE(NULLIF(TRIM(canonical_key), ''), ?) AS canonical_key,
            COALESCE(NULLIF(TRIM(career), ''), '')       AS career
           FROM subjects
          WHERE LOWER(TRIM(name))=LOWER(TRIM(?))`,
        [defaultCanonical, materia]
      );

      const seenTargets = new Set();
      const targets = [];

      for (const r of (subjectRows || [])){
        const ck  = String((r && r.canonical_key) || '').trim() || defaultCanonical;
        const car = String((r && r.career) || '').trim();
        const key = `${ck}@@${car.toLowerCase()}`;
        if (seenTargets.has(key)) continue;
        seenTargets.add(key);
        targets.push({ canonical_key: ck, career: car });
      }

      if (!targets.length){
        targets.push({ canonical_key: defaultCanonical, career: '' });
      }

      // ✅ Persistir en Turso para TODAS las variantes reales de esa materia
      const userId =
        (req.user && req.user.id) ||
        (req.session && req.session.user && req.session.user.id) ||
        null;

      for (const target of targets){
        await run(
          `
          INSERT INTO questions_bank(canonical_key, career, subject_name, plan, raw_text, questions_json, updated_at, created_by)
          VALUES(?,?,?,?,?,?,datetime('now'),?)
          ON CONFLICT(canonical_key, career) DO UPDATE SET
            subject_name   = excluded.subject_name,
            plan           = excluded.plan,
            raw_text       = excluded.raw_text,
            questions_json = excluded.questions_json,
            updated_at     = datetime('now'),
            created_by     = excluded.created_by
          `,
          [
            target.canonical_key,
            target.career,
            materia,
            'ALL',
            raw,
            JSON.stringify(parsed),
            userId
          ]
        );
      }

      res.redirect('/app/preguntas/upload?ok=1&materia=' + encodeURIComponent(materia) + '&plan=' + encodeURIComponent(plan));
    } catch(err){
      console.error('POST /preguntas/upload error:', err);
      res.status(500).send('Error al procesar el archivo');
    }
  });

  return router;
};
