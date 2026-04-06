const express = require('express');
const router = express.Router();

// REQUIRE tu capa de datos (DAO/ORM):
// Supongo un modelo simple con métodos getById, upsertRating(userId, profId, data)
const Profesores = require('../services/profesores.service');

// Middleware para requerir sesión/usuario
function requireUser(req,res,next){
  // ajusta según tu auth: aquí asumo req.user.id
  if(!req.user || !req.user.id){
    return res.status(401).send('Necesitás iniciar sesión para calificar.');
  }
  next();
}

/**
 * PUT /api/profesores/:id/rate
 * Body: { stars (0-5), comment (string), corre (1-10), clases (1-10), onda (1-10), overwrite: true }
 * Efecto: guarda o REEMPLAZA (upsert) la calificación del usuario actual para ese profesor.
 */
router.put('/:id/rate', requireUser, async (req,res)=>{
  try{
    const profId = String(req.params.id);
    const userId = String(req.user.id);

    const stars = Math.max(0, Math.min(5, parseInt(req.body.stars,10) || 0));
    const corre = Math.max(1, Math.min(10, parseInt(req.body.corre,10) || 1));
    const clases= Math.max(1, Math.min(10, parseInt(req.body.clases,10) || 1));
    const onda  = Math.max(1, Math.min(10, parseInt(req.body.onda,10) || 1));
    const comment = (req.body.comment||'').trim();

    // upsert por (profId,userId): borra la previa y deja la nueva
    await Profesores.upsertRating(userId, profId, {
      stars, comment, corre, clases, onda, ts: Date.now()
    });

    // opcional: recalcular promedios del prof
    await Profesores.recalcAverages(profId);

    res.json({ok:true});
  }catch(err){
    console.error(err);
    res.status(500).send('Error al guardar la calificación');
  }
});

module.exports = router;