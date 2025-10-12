const express = require('express');
const router = express.Router();

// --------- Datos en memoria (demo) ----------
const carrera = 'Administración de Empresas';
const plan = 'Plan 7';

// Materias (para chips superiores)
const MATERIAS = [
  'Adm. I', 'Adm. II', 'Economía I', 'Economía II',
  'Finanzas I', 'Finanzas II', 'Marketing', 'Estadística',
  'Contabilidad I', 'Contabilidad II', 'Derecho Empresarial', 'RRHH',
  'Operaciones', 'Comercio Exterior', 'Sistemas de Información', 'Emprendimientos'
];

// 15 profesores de ejemplo (nombre, materia, avatar simple)
const seedProfs = [
  ['Isabel Romero','Adm. I'], ['Jorge Medina','Adm. II'], ['María Soria','Economía I'],
  ['Pablo Vera','Economía II'], ['Laura Godoy','Finanzas I'], ['Andrés Torres','Finanzas II'],
  ['Lucía Pardo','Marketing'], ['Martín Quiroga','Estadística'], ['Sofía Díaz','Contabilidad I'],
  ['Diego Navarro','Contabilidad II'], ['Carla Suárez','Derecho Empresarial'], ['Tomás Rivas','RRHH'],
  ['Nadia Franco','Operaciones'], ['Gonzalo Ibarra','Sistemas de Información'], ['Valeria Pinto','Emprendimientos']
];

function avatarFor(name){
  // Podés reemplazar con tu CDN. Esto usa un placeholder limpio.
  const initials = encodeURIComponent(name.split(' ').map(p=>p[0]).slice(0,2).join(''));
  return `https://ui-avatars.com/api/?name=${initials}&background=EDF2F7&color=1F2937&size=256&rounded=true&bold=true`;
}

let PROFES = seedProfs.map((p, i) => ({
  id: String(i+1),
  nombre: p[0],
  materia: p[1],
  carrera,
  plan,
  avatar: avatarFor(p[0]),
  ratings: [], // {userId, stars (1-5), comment, ts}
}));

// Demo: puntuaciones aleatorias para que el top del mes tenga datos
(function seedRatings(){
  const users = ['u1','u2','u3','u4','u5','u6','u7','u8'];
  const now = Date.now();
  PROFES.forEach((prof, idx) => {
    const n = 2 + (idx % 4);
    for (let i=0;i<n;i++){
      prof.ratings.push({
        userId: users[(idx+i)%users.length],
        stars: 3 + ((idx+i)%3), // 3..5
        comment: ['Excelente','Muy claro','Genial','Capa/o','Top','Recomendable'][ (idx+i)%6 ],
        ts: now - (1000*60*60*24*(i + (idx%6))) // dentro de ~últimos días
      });
    }
  });
})();

// Helpers
function averageStars(ratings){
  if (!ratings.length) return 0;
  return ratings.reduce((a,r)=>a+r.stars,0)/ratings.length;
}
function last30Days(r){ return (Date.now()-r.ts) <= (30*24*60*60*1000); }

// ===== Auth mínima para admin (ajustá a tu app real) =====
function ensureAdmin(req, res, next){
  try {
    const u = req.user || {};
    if (u.isAdmin || u.role === 'admin') return next();
    if (req.session && req.session.isAdmin === true) return next();
    return res.status(403).send('Solo admin');
  } catch(e){
    return res.status(403).send('Solo admin');
  }
}

// Middleware: obtener userId (para prueba si no hay auth real)
router.use((req,res,next)=>{
  if (req.session && !req.session.demoUserId) {
    req.session.demoUserId = 'guest-' + Math.random().toString(36).slice(2,10);
  }
  next();
});

// GET /profes  (página)
router.get('/', (req,res)=>{
  const q = (req.query.q || '').trim().toLowerCase();
  const userId = (req.user && (req.user.id || req.user._id)) || (req.session && req.session.demoUserId) || 'guest';

  // Filtro por carrera/plan (para este caso fijo) y búsqueda
  let listado = PROFES.filter(p => p.carrera === carrera && p.plan === plan);
  if (q) {
    listado = listado.filter(p =>
      p.nombre.toLowerCase().includes(q) || (p.materia || '').toLowerCase().includes(q)
    );
  }

  // Top 5 del mes
  const topMes = [...PROFES]
    .map(p => ({
      ...p,
      monthRatings: p.ratings.filter(last30Days),
      monthAvg: averageStars(p.ratings.filter(last30Days))
    }))
    .sort((a,b) => (b.monthAvg - a.monthAvg) || (b.monthRatings.length - a.monthRatings.length))
    .slice(0,5);

  res.render('profesores', {
    carrera, plan,
    materias: MATERIAS,
    profesores: listado,
    topMes,
    q,
    userId
  });
});

// ========== RATING (dos aliases para compatibilidad) ==========

// POST /profes/:id/rate  (enviar/actualizar calificación)
router.post('/:id/rate', express.json(), (req,res)=>{
  const prof = PROFES.find(p => p.id === String(req.params.id));
  if (!prof) return res.status(404).json({ok:false, error:'Profesor no encontrado'});

  const userId = (req.user && (req.user.id || req.user._id)) || (req.session && req.session.demoUserId) || 'guest';
  let { stars, comment } = req.body || {};
  stars = Math.max(1, Math.min(5, parseInt(stars,10) || 0));
  comment = (comment || '').toString().slice(0, 300);

  // Reemplazar si ya existía
  prof.ratings = prof.ratings.filter(r => r.userId !== userId);
  prof.ratings.push({ userId, stars, comment, ts: Date.now() });

  return res.json({
    ok: true,
    avg: averageStars(prof.ratings),
    count: prof.ratings.length
  });
});

// PUT /api/profesores/:id/rate  (alias compatible con la vista)
router.put('/api/profesores/:id/rate', express.json(), (req,res)=>{
  const prof = PROFES.find(p => p.id === String(req.params.id));
  if (!prof) return res.status(404).json({ok:false, error:'Profesor no encontrado'});

  const userId = (req.user && (req.user.id || req.user._id)) || (req.session && req.session.demoUserId) || 'guest';
  let { stars, comment } = req.body || {};
  stars = Math.max(0, Math.min(5, parseInt(stars,10) || 0)); // permite 0 si tu UI lo necesita
  comment = (comment || '').toString().slice(0, 300);

  // Reemplazar si ya existía
  prof.ratings = prof.ratings.filter(r => r.userId !== userId);
  prof.ratings.push({ userId, stars, comment, ts: Date.now() });

  return res.json({
    ok: true,
    avg: averageStars(prof.ratings),
    count: prof.ratings.length
  });
});

// ========== ADMIN: crear / eliminar profesores ==========

// Crear profesor (admin) — POST /api/profesores
router.post('/api/profesores', ensureAdmin, express.urlencoded({ extended:true }), express.json(), (req,res)=>{
  try{
    const body = req.body || {};
    // aceptar ambos: name/nombre, photo_url/avatar, materia opcional
    const id = (body.id && String(body.id)) || String(Date.now());
    const nombre = String(body.nombre || body.name || '').trim();
    if (!nombre) return res.status(400).send('Falta nombre/nombre');
    if (PROFES.some(p => p.id === id)) return res.status(409).send('El id ya existe');

    const materia = body.materia ? String(body.materia) : undefined;
    const avatar = body.avatar || body.photo_url || avatarFor(nombre);

    const nuevo = {
      id,
      nombre,
      materia,
      carrera,
      plan,
      avatar,
      ratings: []
    };
    PROFES.push(nuevo);
    return res.status(201).json({ ok:true, id, profesor: nuevo });
  }catch(e){
    console.error('POST /api/profesores', e);
    return res.status(500).send('Error creando profesor');
  }
});

// Eliminar profesor (admin) — DELETE /api/profesores/:id
router.delete('/api/profesores/:id', ensureAdmin, (req,res)=>{
  try{
    const { id } = req.params;
    const idx = PROFES.findIndex(p => p.id === String(id));
    if (idx === -1) return res.status(404).send('No existe');
    PROFES.splice(idx, 1);
    return res.status(204).end();
  }catch(e){
    console.error('DELETE /api/profesores/:id', e);
    return res.status(500).send('Error eliminando profesor');
  }
});

module.exports = router;