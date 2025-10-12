// routes/upload.js
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { run, get } = require('../models/db');

const UP_DIR = path.join(__dirname, '..', 'public', 'uploads', 'docs');
fs.mkdirSync(UP_DIR, { recursive: true });

// ===== Configuración de almacenamiento =====
const storage = multer.diskStorage({
  destination: UP_DIR,
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'archivo')
      .replace(/[^\w.\- ()áéíóúñÁÉÍÓÚ]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});

// ===== Límite de tamaño (ej. 100 MB) =====
const MAX_MB = 100;
const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

// ===== Helpers =====
function isPDF(file) {
  if (!file) return false;
  const mt = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '').toLowerCase();
  return mt === 'application/pdf' || name.endsWith('.pdf');
}
function tooBig(file, maxBytes) {
  return file && typeof file.size === 'number' && file.size > maxBytes;
}
function cleanupUploaded(tempFiles) {
  for (const f of tempFiles) {
    if (!f) continue;
    try {
      const abs = path.join(UP_DIR, f.filename);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {}
  }
}

module.exports = () => {
  const router = express.Router();

  async function hasColumn(col) {
    const r = await get(
      `SELECT 1 AS ok FROM pragma_table_info('documents') WHERE name=?`,
      [col]
    );
    return !!r;
  }

  router.post(
    '/',
    upload.fields([
      { name: 'files',         maxCount: 20 }, // categorías normales
      { name: 'file_completo', maxCount: 1 },  // resúmenes
      { name: 'file_mediano',  maxCount: 1 },
      { name: 'file_facil',    maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const subject_id = parseInt(req.body.subject_id, 10);
        const category   = String(req.body.category || '').toLowerCase();

        const ALLOWED = new Set([
          'parciales',
          'finales',
          'trabajos',
          'bibliografia',
          'resumenes',
          'clases',
        ]);
        if (!ALLOWED.has(category)) return res.status(400).send('Categoría inválida');
        if (!subject_id) return res.status(400).send('subject_id inválido');

        const hasLevel = await hasColumn('level');
        const hasGroup = await hasColumn('group_uid');

        const insertDoc = async ({ file, title, level, group_uid }) => {
          if (!file) return;
          const rel = `/uploads/docs/${file.filename}`;
          const ttl = title || file.originalname;

          let cols = [
            'subject_id',
            'title',
            'category',
            'filename',
            'mimetype',
            'size',
            'created_at',
          ];
          let qms  = ['?','?','?','?','?','?',"datetime('now')"];
          const args = [subject_id, ttl, category, rel, file.mimetype, file.size];

          if (hasLevel && level) { cols.push('level'); qms.push('?'); args.push(level); }
          if (hasGroup && group_uid) { cols.push('group_uid'); qms.push('?'); args.push(group_uid); }

          const sql = `INSERT INTO documents (${cols.join(', ')}) VALUES (${qms.join(', ')})`;
          await run(sql, args);
        };

        // ===== Caso: RESÚMENES =====
        if (category === 'resumenes') {
          const fC = (req.files['file_completo']||[])[0];
          const fM = (req.files['file_mediano'] ||[])[0];
          const fF = (req.files['file_facil']   ||[])[0];
          const temps = [fC, fM, fF];

          if (!fC || !fM || !fF) {
            cleanupUploaded(temps);
            return res.status(400).send('Debés subir las 3 versiones: Completo, Mediano y Fácil.');
          }

          const maxBytes = MAX_MB * 1024 * 1024;
          for (const f of temps) {
            if (!isPDF(f)) {
              cleanupUploaded(temps);
              return res.status(400).send(`Solo se permiten PDF en Resúmenes. Archivo inválido: ${f.originalname}`);
            }
            if (tooBig(f, maxBytes)) {
              cleanupUploaded(temps);
              return res.status(400).send(`Archivo demasiado grande: ${f.originalname} (máximo ${MAX_MB} MB)`);
            }
          }

          const group_uid = hasGroup ? `g-${Date.now()}-${Math.random().toString(36).slice(2,8)}` : null;

          await insertDoc({ file:fC, level:'completo', group_uid });
          await insertDoc({ file:fM, level:'mediano',  group_uid });
          await insertDoc({ file:fF, level:'facil',    group_uid });

          return res.redirect(`/app/materias/${subject_id}?category=resumenes&level=completo`);
        }

        // ===== Resto de categorías =====
        const list = req.files['files'] || [];
        if (!list.length) return res.status(400).send('No se envió archivo');

        const maxBytes = MAX_MB * 1024 * 1024;
        for (const f of list) {
          const okExt = /\.(pdf|doc|docx|ppt|pptx|png|jpg|jpeg)$/i.test(f.originalname || '');
          if (!okExt) {
            cleanupUploaded(list);
            return res.status(400).send(`Tipo de archivo no permitido: ${f.originalname}`);
          }
          if (tooBig(f, maxBytes)) {
            cleanupUploaded(list);
            return res.status(400).send(`Archivo demasiado grande: ${f.originalname} (máximo ${MAX_MB} MB)`);
          }
          await insertDoc({ file: f });
        }
        res.redirect(`/app/materias/${subject_id}?category=${encodeURIComponent(category)}`);
      } catch (err) {
        console.error('❌ Upload error:', err);
        res.status(500).send('Error subiendo archivo');
      }
    }
  );

  return router;
};
