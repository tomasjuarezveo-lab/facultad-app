const express = require('express');
const path = require('path');
const fs = require('fs');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

function norm(v) {
  return String(v ?? '').trim();
}

const R2_ENDPOINT = norm(process.env.R2_ENDPOINT);
const R2_BUCKET = norm(process.env.R2_BUCKET);
const R2_ACCESS_KEY_ID = norm(process.env.R2_ACCESS_KEY_ID);
const R2_SECRET_ACCESS_KEY = norm(process.env.R2_SECRET_ACCESS_KEY);
const R2_PUBLIC_BASE = norm(process.env.R2_PUBLIC_BASE).replace(/\/+$/, '');

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

function extractR2KeyFromUrl(rawUrl) {
  const urlStr = norm(rawUrl);
  if (!urlStr) return '';

  try {
    if (R2_PUBLIC_BASE && urlStr.startsWith(R2_PUBLIC_BASE + '/')) {
      return decodeURIComponent(urlStr.slice(R2_PUBLIC_BASE.length + 1)).replace(/^\/+/, '');
    }

    const parsed = new URL(urlStr);
    return decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '');
  } catch (_) {
    return '';
  }
}

function resolveRequestedKey(req) {
  const directKey = norm(req.query.key);
  if (directKey && !directKey.includes('..')) return directKey.replace(/^\/+/, '');

  const urlKey = extractR2KeyFromUrl(req.query.url);
  if (urlKey && !urlKey.includes('..')) return urlKey;

  return '';
}

module.exports = () => {
  const router = express.Router();

  router.get('/r2', async (req, res) => {
    try {
      const key = resolveRequestedKey(req);
      if (!key) {
        return res.status(400).send('Falta parámetro key/url válido');
      }

      const range = norm(req.headers.range);
      const out = await r2.send(new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ...(range ? { Range: range } : {})
      }));

      const forceDownload = norm(req.query.download) === '1';
      const downloadName = path.basename(key || 'archivo.pdf').replace(/[\r\n"]/g, '_');

      res.status(out.ContentRange ? 206 : 200);
      res.setHeader('Content-Type', out.ContentType || 'application/pdf');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', forceDownload ? 'private, no-store' : 'public, max-age=300');

      if (out.ContentLength != null) {
        res.setHeader('Content-Length', String(out.ContentLength));
      }
      if (out.ContentRange) {
        res.setHeader('Content-Range', String(out.ContentRange));
      }
      if (out.ETag) {
        res.setHeader('ETag', String(out.ETag));
      }
      if (out.LastModified) {
        res.setHeader('Last-Modified', new Date(out.LastModified).toUTCString());
      }

      if (forceDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      } else {
        res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
      }

      if (out.Body && typeof out.Body.pipe === 'function') {
        out.Body.on('error', (streamErr) => {
          console.error('[pdf-view/r2] stream error:', streamErr?.message || streamErr);
          if (!res.headersSent) res.status(502).end('Error leyendo archivo');
          else res.destroy(streamErr);
        });
        return out.Body.pipe(res);
      }

      const chunks = [];
      for await (const chunk of out.Body) chunks.push(Buffer.from(chunk));
      return res.end(Buffer.concat(chunks));
    } catch (err) {
      console.error('[pdf-view/r2] proxy error:', err?.message || err);
      return res.status(404).send('Archivo no encontrado');
    }
  });

  router.get('/', (req, res) => {
    const file = String(req.query.file || '');

    if (!file) return res.status(400).send('Falta parámetro file');
    if (!file.startsWith('/uploads/docs/')) {
      return res.status(400).send('Archivo inválido');
    }

    const abs = path.join(__dirname, '..', 'public', file);
    if (!fs.existsSync(abs)) {
      return res.status(404).send('Archivo no encontrado');
    }

    return res.render('pdfviewer', { file });
  });

  return router;
};
