// routes/upload.js
const express = require('express');
const path = require('path');
const multer = require('multer');
const { run, get } = require('../models/db');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ===== Helpers ENV / Strings =====
function normStr(v) {
  return String(v ?? '').trim();
}
function badEnv(v) {
  const s = normStr(v);
  if (!s) return true;
  // placeholders típicos que te dejan el sistema roto
  if (/PEGAR_/i.test(s)) return true;
  if (/pegar_/i.test(s)) return true;
  if (/<accountid>/i.test(s)) return true;
  if (/example\.com/i.test(s)) return true;
  return false;
}
function stripTrailingSlash(u) {
  return normStr(u).replace(/\/+$/, '');
}

// ===== R2 env =====
const R2_ENDPOINT = normStr(process.env.R2_ENDPOINT); // ej: https://<accountid>.r2.cloudflarestorage.com
const R2_BUCKET = normStr(process.env.R2_BUCKET);
const R2_PUBLIC_BASE = stripTrailingSlash(process.env.R2_PUBLIC_BASE); // ej: https://pub-xxxxx.r2.dev (o tu dominio)
const R2_ACCESS_KEY_ID = normStr(process.env.R2_ACCESS_KEY_ID);
const R2_SECRET_ACCESS_KEY = normStr(process.env.R2_SECRET_ACCESS_KEY);

// ===== R2 (S3 compatible) client =====
// Nota: lo creamos igual, pero validamos antes de usarlo.
const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  // Recomendado para endpoints S3-compatibles (ayuda a evitar problemas raros de hostname)
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function missingR2EnvList() {
  const miss = [];
  if (badEnv(R2_ENDPOINT)) miss.push('R2_ENDPOINT');
  if (badEnv(R2_BUCKET)) miss.push('R2_BUCKET');
  if (badEnv(R2_PUBLIC_BASE)) miss.push('R2_PUBLIC_BASE');
  if (badEnv(R2_ACCESS_KEY_ID)) miss.push('R2_ACCESS_KEY_ID');
  if (badEnv(R2_SECRET_ACCESS_KEY)) miss.push('R2_SECRET_ACCESS_KEY');
  return miss;
}

const missAtBoot = missingR2EnvList();
if (missAtBoot.length) {
  console.warn(
    `[upload] ⚠️ Storage (R2) no configurado. Falta o placeholder: ${missAtBoot.join(', ')}`
  );
}

// ===== Límite de tamaño (ej. 100 MB) =====
const MAX_MB = 100;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

// ===== Helpers archivos =====
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
function canonKey(v){
  let s = String(v ?? '').trim().toLowerCase();
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
  s = s.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return s;
}
function nowKey(prefix, originalname) {
  const safe = safeName(originalname);
  const ext = extFromName(safe);
  const rand = Math.random().toString(16).slice(2);
  // Si "safe" ya termina con ext, no lo repetimos
  const withExt = ext && !safe.endsWith(ext) ? `${safe}${ext}` : safe;
  const p = String(prefix || 'docs').replace(/^\/+/, '').replace(/\/+$/, '');
  return `${p}/${Date.now()}-${rand}-${withExt}`;
}

async function putToR2({ key, buffer, mimetype, filename }) {
  // Validación final antes de intentar subir (evita ENOTFOUND confuso)
  const miss = missingR2EnvList();
  if (miss.length) {
    const err = new Error(`Storage (R2) no configurado. Falta/placeholder: ${miss.join(', ')}`);
    err.code = 'R2_ENV_MISSING';
    throw err;
  }

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype || 'application/octet-stream',
      // útil para que el navegador abra/descargue con nombre
      ContentDisposition: filename
        ? `inline; filename="${safeName(filename)}"`
        : undefined,
    })
  );

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
      { name: 'files', maxCount: 20 }, // categorías normales
      { name: 'file_completo', maxCount: 1 }, // resúmenes
      { name: 'file_mediano', maxCount: 1 },
      { name: 'file_facil', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const subject_id = parseInt(req.body.subject_id, 10);
        const category = String(req.body.category || '').toLowerCase();

        const ALLOWED = new Set([
          'parciales',
          'finales',
          'trabajos',
          'bibliografia',
          'resumenes',
          'clases',
          'definiciones',
        ]);
        if (!ALLOWED.has(category)) return res.status(400).send('Categoría inválida');
        if (!subject_id) return res.status(400).send('subject_id inválido');

                const subjRow = await get(
          `SELECT
             COALESCE(NULLIF(canonical_key,''), '') AS ck,
             COALESCE(NULLIF(subject_name,''), NULLIF(name,'')) AS nm
           FROM subjects
           WHERE id=?`,
          [subject_id]
        );

        const subject_key = canonKey((subjRow?.ck || subjRow?.nm || '').trim());

                const rawSubcategory = normStr(req.body.subcategory);

        let subToStore = rawSubcategory;

        if (category === 'trabajos') {
          subToStore = normStr(rawSubcategory).toLowerCase();
          const OK = new Set(['tps', 'resoluciones']);
          if (!subToStore) return res.status(400).send('Falta subcategoría (TPs / Resoluciones)');
          if (!OK.has(subToStore)) return res.status(400).send('Subcategoría inválida (solo TPs o Resoluciones)');
        }

        if (category === 'clases') {
          if (!rawSubcategory) return res.status(400).send('Falta subsección de Clases');
          subToStore = rawSubcategory; // guardamos tal cual
        }

        const safeSlug = (s) =>
          normStr(s)
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-_]/g, '')
            .slice(0, 60);

        const subSlug = safeSlug(rawSubcategory);
        const basePrefix = `docs/${category}`;
        const prefix = subSlug ? `${basePrefix}/${subSlug}` : basePrefix;


        // Validación R2 env (con mensaje útil)
        const miss = missingR2EnvList();
        if (miss.length) {
          return res
            .status(500)
            .send(`Storage (R2) no configurado. Falta/placeholder: ${miss.join(', ')}`);
        }

        // Cacheamos columnas una sola vez por request (evita muchos PRAGMA)
          const cols = {
            level: await hasColumn('level'),
            group_uid: await hasColumn('group_uid'),
            url: await hasColumn('url'),
            subcategory: await hasColumn('subcategory'),
            subject_key: await hasColumn('subject_key'),
          };


        const insertDoc = async ({ file, title, level, group_uid, subcategory, prefix }) => {
          if (!file) return;

          const original = file.originalname || 'archivo';
          const ttl = title || original;

          // Subir a R2
          const key = nowKey(prefix || 'docs', original);
          const url = await putToR2({
            key,
            buffer: file.buffer,
            mimetype: file.mimetype,
            filename: original,
          });

          // Compatibilidad con esquemas viejos:
          // - filename: guardo el "key" (antes era "/uploads/docs/...")
          // - url: guardo la URL pública (si la columna existe)
          let colsArr = [
            'subject_id',
            'title',
            'category',
            'filename',
            'mimetype',
            'size',
            'created_at',
          ];

          let qms = ['?', '?', '?', '?', '?', '?', "datetime('now')"];

          const args = [
            subject_id,
            ttl,
            category,
            key,
            file.mimetype || 'application/octet-stream',
            Number(file.size || 0),
          ];

          if (cols.subject_key) {
            colsArr.push('subject_key');
            qms.push('?');
            args.push(subject_key);
          }

          if (cols.url) {
            colsArr.push('url');
            qms.push('?');
            args.push(url);
          }

          if (cols.level && level) {
            colsArr.push('level');
            qms.push('?');
            args.push(level);
          }

          if (cols.group_uid && group_uid) {
            colsArr.push('group_uid');
            qms.push('?');
            args.push(group_uid);
          }

          if (cols.subcategory && (category === 'trabajos' || category === 'clases')) {
            colsArr.push('subcategory');
            qms.push('?');
            args.push(subcategory || '');
          }

          const sql = `INSERT INTO documents (${colsArr.join(', ')}) VALUES (${qms.join(', ')})`;
          await run(sql, args);
        };

        // ===== Caso: RESÚMENES =====
        if (category === 'resumenes') {
          const fC = (req.files['file_completo'] || [])[0];
          const fM = (req.files['file_mediano'] || [])[0];
          const fF = (req.files['file_facil'] || [])[0];
          const temps = [fC, fM, fF];

          if (!fC || !fM || !fF) {
            return res
              .status(400)
              .send('Debés subir las 3 versiones: Completo, Mediano y Fácil.');
          }

          const maxBytes = MAX_MB * 1024 * 1024;
          for (const f of temps) {
            if (!isPDF(f)) {
              return res
                .status(400)
                .send(`Solo se permiten PDF en Resúmenes. Archivo inválido: ${f.originalname}`);
            }
            if (tooBig(f, maxBytes)) {
              return res
                .status(400)
                .send(`Archivo demasiado grande: ${f.originalname} (máximo ${MAX_MB} MB)`);
            }
          }

          const group_uid = cols.group_uid
            ? `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            : null;

          await insertDoc({ file: fC, level: 'completo', group_uid, prefix: 'docs/resumenes' });
          await insertDoc({ file: fM, level: 'mediano', group_uid, prefix: 'docs/resumenes' });
          await insertDoc({ file: fF, level: 'facil', group_uid, prefix: 'docs/resumenes' });

          return res.redirect(`/app/materias/${subject_id}?category=resumenes&level=completo`);
        }

        // ===== Resto de categorías =====
        const list = req.files['files'] || [];
        if (!list.length) return res.status(400).send('No se envió archivo');

        const maxBytes = MAX_MB * 1024 * 1024;
        for (const f of list) {
          // ✅ Definiciones: solo .txt (para parsear y buscar)
          // ✅ Resto: los tipos usuales
          const name = String(f.originalname || '');
          const okExt = category === 'definiciones'
            ? /\.(txt)$/i.test(name)
            : /\.(pdf|doc|docx|ppt|pptx|png|jpg|jpeg)$/i.test(name);

          if (!okExt) {
            return res.status(400).send(`Tipo de archivo no permitido: ${f.originalname}`);
          }
          if (tooBig(f, maxBytes)) {
            return res
              .status(400)
              .send(`Archivo demasiado grande: ${f.originalname} (máximo ${MAX_MB} MB)`);
          }
          await insertDoc({ file: f, prefix, subcategory: subToStore });
        }

        let red = `/app/materias/${subject_id}?category=${encodeURIComponent(category)}`;
          if (rawSubcategory && (category === 'trabajos' || category === 'clases')) {
            red += `&subcategory=${encodeURIComponent(rawSubcategory)}`;
          }
          return res.redirect(red);

      } catch (err) {
        console.error('❌ Upload error:', err);

        // Mensaje más claro si el problema es de env R2
        if (err && err.code === 'R2_ENV_MISSING') {
          return res.status(500).send(String(err.message || 'Storage (R2) no configurado.'));
        }

        return res.status(500).send('Error subiendo archivo');
      }
    }
  );

  return router;
};