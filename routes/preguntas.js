
// routes/preguntas.js — DB version (usa SQLite subjects)
// - Materias y Planes salen de la base de datos real (tabla subjects)
// - SSR prellena selects y /meta expone datos por AJAX
// - Guarda .txt/.docx en /preguntas/<materia>-<plan>.txt

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { all } = require('../models/db');
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

      const fname = normalizeName(materia) + '-' + normalizeName(plan) + '.txt';
      const dest  = path.join(PREG_DIR, fname);
      fs.writeFileSync(dest, raw, 'utf8');

      res.redirect('/app/preguntas/upload?ok=1&materia=' + encodeURIComponent(materia) + '&plan=' + encodeURIComponent(plan));
    } catch(err){
      console.error('POST /preguntas/upload error:', err);
      res.status(500).send('Error al procesar el archivo');
    }
  });

  return router;
};
