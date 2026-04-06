const express = require('express');

module.exports = () => {
  const router = express.Router();

  router.get('/terminos-y-condiciones-de-uso', (_req, res) => {
    return res.render('legal-terms', {
      title: 'Términos y Condiciones',
      layout: false
    });
  });

  router.get('/politica-de-privacidad-y-proteccion-de-datos', (_req, res) => {
    return res.render('legal-privacy', {
      title: 'Política de Privacidad',
      layout: false
    });
  });

  return router;
};