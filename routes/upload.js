// routes/upload.js
const express = require('express');
const path    = require('path');
const multer  = require('multer');
const { run, get } = require('../models/db');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ===== R2 (S3 compatible) =====
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT, // ej: https://<accountid>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE; // ej: https://pub-xxxxx.r2.dev  (o tu dominio)

if (!R2_BUCKET || !R2_PUBLIC_BASE || !process.env.R2_ENDPOINT) {
  console.warn('[upload] ⚠️ Faltan variables de entorno R2_* (R2_BUCKET / R2_PUBLIC_BASE / R2_ENDPOINT).');
}

// ===== Límite de tamaño (ej. 100 MB) =====
const MAX_MB = 100;
const upload = multer({
  storage: multer.memoryStorage(),
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
function safeName(originalname) {
  return String(originalname || 'archivo').replace(/[^\w.\- ()áéíóúñÁÉÍÓÚ]/g, '_');
}
function extFromName(name) {
  const e = path.extname(String(name || '')).toLowerCase();
  return e && e.length <= 10 ? e : '';
}
function nowKey(prefix, originalname) {
  const safe = safeName(originalname);
  const ext = extFromName(safe);
  const rand = Math.random().toString(16).slice(2);
  return `${prefix}/${Date.now()}-${rand}-${safe}${ext && safe.endsWith(ext) ? '' : ext}`;
}

async function putToR2({ key, buffer, mimetype }) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
  }));
  return `${R2_PUBLIC_BASE}/${key}`;
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

        // Validación R2 env
        if (!R2_BUCKET || !R2_PUBLIC_BASE || !process.env.R2_ENDPOINT) {
          return res.status(500).send('Faltan variables de entorno de storage (R2).');
        }

        const hasLevel = await hasColumn('level');
        const hasGroup = await hasColumn('group_uid');

        const insertDoc = async ({ file, title, level, group_uid, prefix }) => {
          if (!file) return;

          const original = file.originalname || 'archivo';
          const ttl = title || original;

          // Subir a R2
          const key = nowKey(prefix || 'docs', original);
          const url = await putToR2({ key, buffer: file.buffer, mimetype: file.mimetype });

          // Intento mantener compatibilidad con esquemas viejos:
          // - filename: guardo el "key" (antes era "/uploads/docs/...")
          // - url: guardo la URL pública (si la columna existe)
          // - mimetype/size: idem
          // - created_at: datetime('now')
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
          const args = [subject_id, ttl, category, key, file.mimetype, file.size];

          // Columnas opcionales si existen en tu DB
          const hasUrl = await hasColumn('url');
          if (hasUrl) { cols.push('url'); qms.push('?'); args.push(url); }

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
            return res.status(400).send('Debés subir las 3 versiones: Completo, Mediano y Fácil.');
          }

          const maxBytes = MAX_MB * 1024 * 1024;
          for (const f of temps) {
            if (!isPDF(f)) {
              return res.status(400).send(`Solo se permiten PDF en Resúmenes. Archivo inválido: ${f.originalname}`);
            }
            if (tooBig(f, maxBytes)) {
              return res.status(400).send(`Archivo demasiado grande: ${f.originalname} (máximo ${MAX_MB} MB)`);
            }
          }

          const group_uid = hasGroup ? `g-${Date.now()}-${Math.random().toString(36).slice(2,8)}` : null;

          await insertDoc({ file: fC, level: 'completo', group_uid, prefix: 'docs/resumenes' });
          await insertDoc({ file: fM, level: 'mediano',  group_uid, prefix: 'docs/resumenes' });
          await insertDoc({ file: fF, level: 'facil',    group_uid, prefix: 'docs/resumenes' });

          return res.redirect(`/app/materias/${subject_id}?category=resumenes&level=completo`);
        }

        // ===== Resto de categorías =====
        const list = req.files['files'] || [];
        if (!list.length) return res.status(400).send('No se envió archivo');

        const maxBytes = MAX_MB * 1024 * 1024;
        for (const f of list) {
          const okExt = /\.(pdf|doc|docx|ppt|pptx|png|jpg|jpeg)$/i.test(f.originalname || '');
          if (!okExt) {
            return res.status(400).send(`Tipo de archivo no permitido: ${f.originalname}`);
          }
          if (tooBig(f, maxBytes)) {
            return res.status(400).send(`Archivo demasiado grande: ${f.originalname} (máximo ${MAX_MB} MB)`);
          }
          await insertDoc({ file: f, prefix: `docs/${category}` });
        }

        return res.redirect(`/app/materias/${subject_id}?category=${encodeURIComponent(category)}`);
      } catch (err) {
        console.error('❌ Upload error:', err);
        return res.status(500).send('Error subiendo archivo');
      }
    }
  );

  return router;
};