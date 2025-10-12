// routes/pdf.js
const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports = () => {
  const router = express.Router();

  // /pdf?file=/uploads/docs/miarchivo.pdf
  router.get('/', (req, res) => {
    const file = String(req.query.file || '');

    if (!file) return res.status(400).send('Falta parámetro file');
    if (!file.startsWith('/uploads/docs/')) {
      return res.status(400).send('Archivo inválido');
    }

    // Debe existir físicamente bajo /public/uploads/docs/...
    const abs = path.join(__dirname, '..', 'public', file);
    if (!fs.existsSync(abs)) {
      return res.status(404).send('Archivo no encontrado');
    }

    // Render del visor sin barra superior
    return res.render('pdfviewer', { file });
  });

  return router;
};
