
// routes/autoevaluacion.js — ESTRICTO: solo usa preguntas subidas (sin demos)
const express = require('express');
const { loadQuestions, shuffleInPlace } = require('../lib/questions');

module.exports = () => {
  const router = express.Router();

  // Requiere Materia + Plan (sin fallback)
  router.get('/:materia/:plan', (req, res) => {
    const materia = decodeURIComponent(req.params.materia || '').trim();
    const plan    = decodeURIComponent(req.params.plan || '').trim();

    let qs = loadQuestions(materia, plan);
    qs = shuffleInPlace(qs.slice());

    return res.render('autoevaluacion', {
      title: 'Autoevaluación',
      materia, plan,
      preguntas: qs,
      emptyMessage: qs.length ? null : 'No hay preguntas cargadas para esta Materia y Plan. Subí un archivo en "Cargar Preguntas".',
      user: req.user || (req.session && req.session.user) || null
    });
  });

  // API estricta
  router.get('/api/preguntas/:materia/:plan', (req, res) => {
    const materia = decodeURIComponent(req.params.materia || '').trim();
    const plan    = decodeURIComponent(req.params.plan || '').trim();
    let qs = loadQuestions(materia, plan);
    qs = shuffleInPlace(qs.slice());
    res.json({ ok:true, materia, plan, demo:false, count: qs.length, preguntas: qs });
  });

  return router;
};
