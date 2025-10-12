// server.js
require('dotenv').config();

const express         = require('express');
const path            = require('path');
const fs              = require('fs');
const fsp             = require('fs/promises'); // para borrado seguro
const session         = require('express-session');
const SQLiteStore     = require('connect-sqlite3')(session);
const passport        = require('passport');
const LocalStrategy   = require('passport-local').Strategy;
const bcrypt          = require('bcrypt');
const methodOverride  = require('method-override');
const expressLayouts  = require('express-ejs-layouts');
const multer          = require('multer');
const { db, all, get, run, init } = require('./models/db'); // ← agregado run
const { loadQuestionsAnyPlan } = require('./lib/questions');

// Util de verificación (toggle, startedAt y consumir códigos)
const verifyUtil      = require('./routes/verify').util;

// 30 días
const GLOBAL_GRACE_MS   = 0;                    // ⏱ Sin gracia global: bloqueo inmediato
const INDIVIDUAL_MS     = 30 * 24 * 60 * 60 * 1000; // ✅ 30 días luego de ingresar código


const app = express();

/* =========================
   Layout helpers / flags
   ========================= */
// Ocultar dock (tabbar) en login/register
app.use((req, res, next) => {
  res.locals.hideTabbar = /^\/(login|register)(\/|$)/.test(req.path);
  next();
});
// Marcar páginas principales (para mostrar badge/foto)
app.use((req, res, next) => {
  const mains = new Set([
    '/app/materias',
    '/app/autoevaluaciones',
    '/app/juegos',
    '/app/correlativas',
    '/app/finales',
    '/app/profesores',
    '/app/grupos'
  ]);
  res.locals.isMainPage = mains.has(req.path);
  next();
});
// Clase especial para Correlativas (no scroll, etc.)
app.use((req, res, next) => {
  if (req.path.startsWith('/app/correlativas')) {
    res.locals.bodyClass = (res.locals.bodyClass ? res.locals.bodyClass + ' ' : '') + 'no-scroll-page page-correlativas';
  }
  next();
});

/* =========================
   View engine + estáticos
   ========================= */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use('/public',  express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'))); // uploads dentro de /public

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

/* =========================
   Sesión
   ========================= */
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname) }),
  secret: process.env.SESSION_SECRET || 'supersecreto',
  resave: false,
  saveUninitialized: false,
  cookie: { }
}));

/* =========================
   Passport (Local)
   ========================= */
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const user = await get(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) return done(null, false, { message: 'Credenciales inválidas' });
    const ok = await bcrypt.compare(password, user.pass_hash);
    if (!ok) return done(null, false, { message: 'Credenciales inválidas' });
    return done(null, { id: user.id, name: user.name, role: user.role, career: user.career, plan: user.plan, email: user.email });
  } catch (e) { return done(e); }
}));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await get(`SELECT id, name, email, role, career, plan FROM users WHERE id=?`, [id]);
    done(null, user);
  } catch (e) {
    done(e);
  }
});
app.use(passport.initialize());
app.use(passport.session());

// Título por defecto + role
app.use((req, res, next) => {
  if (typeof res.locals.title === 'undefined') res.locals.title = 'Facultad';
  res.locals.userRole = (req.user && req.user.role) || null;
  next();
});

/* =========================
   Helpers auth
   ========================= */
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.redirect('/login');
}
function ensureAdmin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user.role === 'admin') return next();
  return res.status(403).send('Solo el administrador puede realizar esta acción');
}

/* =========================
   Normalizador de career (autofix)
   ========================= */
// Usamos la utilidad canónica para que "Contador Público" -> "Contabilidad"
// y las variantes de Administración -> "Lic. en Administración de Empresas".
const { normalizeCareer } = require('./utils/careers');

app.use(async (req, res, next) => {
  try {
    if (req.user?.career) {
      const fixed = normalizeCareer(req.user.career);
      if (fixed !== req.user.career) {
        await run(`UPDATE users SET career=? WHERE id=?`, [fixed, req.user.id]);
        req.user.career = fixed;
      }
    }
  } catch (e) {
    console.error('Career normalize error:', e);
  }
  next();
});

// Inyectar user en views
app.use((req, res, next) => {
  res.locals.user = req.user;
  if (req.user) {
    req.session.user = req.session.user || {};
    for (const k of ['id','name','email','role','career','plan','avatarUrl']) {
      if (req.user[k] !== undefined) req.session.user[k] = req.user[k];
    }
  }
  next();
});

/* ==========================================
   Rutas de la aplicación
   ========================================== */
const authRoutes          = require('./routes/auth');
const appRoutes           = require('./routes/app');
const adminRoutes         = require('./routes/admin');
const uploadRoutes        = require('./routes/upload');
const notificationsRoutes = require('./routes/notifications');
const pdfRoutes           = require('./routes/pdf');
const correlativasRoute   = require('./routes/correlativas');
const groupsRoutes        = require('./routes/groups');
const verifyRoutes        = require('./routes/verify'); // Panel admin /verify

app.use(authRoutes({ passport }));

// 🔧 Correlativas se define como "/correlativas" dentro del router y se monta bajo "/app"
//    para que la URL final sea "/app/correlativas" y respete career/plan del usuario o query.
app.use('/app', ensureAuth, correlativasRoute);

// Resto de secciones dentro de /app
app.use('/app', ensureAuth, notificationsRoutes({ ensureAdmin }));
app.use('/app',              ensureAuth,  appRoutes({ ensureAdmin }));

// Admin / uploads / pdf
app.use('/admin',            ensureAdmin, adminRoutes());
app.use('/upload',           ensureAdmin, uploadRoutes());
app.use('/pdf-view',         pdfRoutes());

// Grupos (ruta dedicada)
app.use('/app/grupos',       ensureAuth,  groupsRoutes());

// Panel de verificación (solo admin)
app.use('/verify',           ensureAdmin, verifyRoutes()); // Admin-only

// Logout
function doLogout(req, res) {
  const redirectTo = '/login';
  if (typeof req.logout === 'function') {
    req.logout(function () {
      if (req.session) {
        req.session.destroy(() => {
          res.clearCookie('connect.sid');
          res.redirect(redirectTo);
        });
      } else {
        res.redirect(redirectTo);
      }
    });
  } else {
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect(redirectTo);
      });
    } else {
      res.redirect(redirectTo);
    }
  }
}
app.get('/logout', (req, res) => doLogout(req, res));
app.post('/logout', (req, res) => doLogout(req, res));

/* =========================
   API de quizzes
   ========================= */

app.get('/api/quizzes', async (req, res) => {
  try {
    const subjectId = String(req.query.subject_id || '').trim();
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit || '5', 10)));
    if (!subjectId) return res.status(400).json({ error: 'Falta subject_id' });

    const subj = await get(`SELECT name FROM subjects WHERE id=?`, [subjectId]);
    if (!subj || !subj.name) return res.json([]); // sin demos

    // Carga TODAS las preguntas de esa materia, combinando todos los planes
    const rawQs = loadQuestionsAnyPlan(subj.name);
    if (!Array.isArray(rawQs) || rawQs.length === 0) return res.json([]);

    // Mezclar y recortar
    const pool = rawQs.slice().sort(()=>Math.random() - 0.5).slice(0, limit);

    // Adaptar formato a { text, options, answer:index } y desordenar opciones
    const payload = pool.map(q => {
      const options = Array.isArray(q.choices) ? q.choices.slice() : [];
      const originalCorrectIdx = options.findIndex(opt => String(opt) === String(q.correct));
      const shuffled = options.map((opt, i) => ({ opt, i })).sort(()=>Math.random() - 0.5);
      const newOptions = shuffled.map(x => x.opt);
      const answerIdx = shuffled.findIndex(x => x.i === originalCorrectIdx);
      return { text: q.question || '', options: newOptions, answer: answerIdx };
    });

    res.json(payload);
  } catch (e) {
    console.error('GET /api/quizzes error:', e);
    res.status(500).json({ error: 'No se pudieron cargar las preguntas' });
  }
});

/* =========================
   API Verificación (cliente) - Server authoritative con reloj global
   ========================= */

// Estado de verificación para el cliente
app.get('/api/verify/status', ensureAuth, (req, res) => {
  try {
    const enabled = verifyUtil.getEnabled();
    const isAdmin = (req.user && req.user.role) === 'admin';

    if (!enabled || isAdmin) {
      return res.json({
        enabled: false,
        remainingMs: Number.POSITIVE_INFINITY,
        serverNow: Date.now(),
        allowedUntil: null
      });
    }

    const now = Date.now();

    // Ventana GLOBAL (desde que el admin activó)
    const startedAt  = verifyUtil.getStartedAt() || 0;
    const globalUntil = startedAt ? (startedAt + GLOBAL_GRACE_MS) : 0;

    // Ventana INDIVIDUAL (se setea tras ingresar un código)
    const sessionUntil = Number(req.session.verifyAllowedUntil || 0);

    // Se permite mientras esté dentro de cualquiera de las dos
    const allowedUntil = Math.max(globalUntil, sessionUntil);
    const remaining = Math.max(0, allowedUntil - now);

    res.json({
      enabled: true,
      remainingMs: remaining,
      serverNow: now,
      allowedUntil
    });
  } catch (e) {
    console.error('GET /api/verify/status error:', e);
    res.status(500).json({
      enabled: false,
      remainingMs: 0,
      serverNow: Date.now(),
      allowedUntil: null
    });
  }
});

// Validar + consumir código (un solo uso) y extender ventana INDIVIDUAL
app.post('/api/verify/submit', ensureAuth, express.json(), (req, res) => {
  try {
    const role = (req.user && req.user.role) || 'user';
    if (role === 'admin') {
      return res.json({ ok: true, adminBypass: true, remainingMs: Number.POSITIVE_INFINITY });
    }

    const code = String((req.body && req.body.code) || '').trim();
    if (!code) return res.status(400).json({ ok:false, error:'Falta código' });

    const ok = verifyUtil.validateAndConsumeCode(code);
    if (!ok) return res.status(400).json({ ok:false, error:'Código inválido o ya utilizado' });

    const now = Date.now();
    req.session.verifyAllowedUntil = now + INDIVIDUAL_MS; // +30 días
    return res.json({ ok:true, remainingMs: INDIVIDUAL_MS });

  } catch (e) {
    console.error('POST /api/verify/submit error:', e);
    res.status(500).json({ ok:false, error:'No se pudo validar el código' });
  }
});

/* =========================
   Home
   ========================= */
app.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/app/materias');
  res.redirect('/login');
});

/* ==================================================
   Avatar upload
   ================================================== */
const fs2      = require('fs');
const path2    = require('path');
const multer2  = require('multer');

const AVATAR_DIR = path2.join(__dirname, 'uploads', 'avatars');
try { fs2.mkdirSync(AVATAR_DIR, { recursive: true }); } catch (e) {}

const DATA_DIR  = path2.join(__dirname, 'data');
try { fs2.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const AVATAR_DB = path2.join(DATA_DIR, 'avatars.json');

let avatarMap = {};
try { avatarMap = JSON.parse(fs2.readFileSync(AVATAR_DB, 'utf8')); } catch (e) { avatarMap = {}; }

app.use('/uploads', express.static(path2.join(__dirname, 'uploads')));

app.use((req, res, next) => {
  const email = (req.user && req.user.email) || (req.session.user && req.session.user.email);
  if (email && avatarMap[email]) {
    if (req.user) req.user.avatarUrl = avatarMap[email];
    if (res.locals.user) res.locals.user.avatarUrl = avatarMap[email];
    if (req.session.user) req.session.user.avatarUrl = avatarMap[email];
  }
  next();
});

const storageAvatar = multer2.diskStorage({
  destination: AVATAR_DIR,
  filename: (req, file, cb) => {
    const uid = (req.user && req.user.id) || (req.user && req.user.email?.replace(/[^a-z0-9]/gi, '_')) || Date.now();
    const ext = path2.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `u${uid}-${Date.now()}${ext}`);
  }
});
const uploadAvatar = multer2({
  storage: storageAvatar,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Solo imágenes'))
});

app.post('/profile/avatar', ensureAuth, (req, res) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err || !req.file) {
      console.error(err);
      return res.redirect('back');
    }
    const rel = '/uploads/avatars/' + req.file.filename;
    const em  = (req.user && req.user.email) || (req.session.user && req.session.user.email);
    if (em) {
      avatarMap[em] = rel;
      try { fs2.writeFileSync(AVATAR_DB, JSON.stringify(avatarMap, null, 2)); } catch (e) { console.error(e); }
    }
    if (req.user) req.user.avatarUrl = rel;
    if (req.session.user) req.session.user.avatarUrl = rel;
    res.redirect('back');
  });
});

/* ==================================================
   BORRADO SEGURO DE SUBJECTS (doc + archivos asociados + cascada dinámica)
   ================================================== */

// helper: intentar borrar un path absoluto, ignorando ENOENT
async function safeUnlink(absPath) {
  try { await fsp.unlink(absPath); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('unlink error:', e.message); }
}

// normaliza rutas almacenadas (relativas) a candidatas absolutas
function candidatesFromRel(rel) {
  const clean = String(rel || '').replace(/^(\.\/|\/)/, '');
  if (!clean || /^https?:\/\//i.test(clean)) return [];
  return [
    path.resolve(__dirname, clean),
    path.resolve(__dirname, 'public', clean),
  ];
}

// recoge posibles archivos desde el row de SQLite (flexible con distintos esquemas)
function collectFileRels(doc) {
  const outs = [];
  for (const k of ['file', 'filepath', 'file_path', 'path', 'local_path', 'rel_path']) {
    if (doc[k]) outs.push(doc[k]);
  }
  for (const key of ['files', 'attachments']) {
    const v = doc[key];
    if (!v) continue;
    try {
      const arr = Array.isArray(v) ? v : JSON.parse(v);
      if (Array.isArray(arr)) {
        for (const it of arr) {
          if (!it) continue;
          if (typeof it === 'string') outs.push(it);
          else if (typeof it === 'object') outs.push(it.path || it.file || it.rel || it.url || '');
        }
      }
    } catch (_) {}
  }
  return outs.filter(Boolean);
}

// POST /app/subjects/:id/delete  (para formularios)
app.post('/app/subjects/:id/delete', ensureAdmin, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok:false, error:'ID inválido' });

  try {
    const doc = await get(`SELECT * FROM subjects WHERE id = ?`, [id]);
    if (!doc) return res.status(404).json({ ok:false, error:'No encontrado' });

    // 1) borrar archivos declarados en el propio subject
    const rels = collectFileRels(doc);
    for (const rel of rels) {
      const cands = candidatesFromRel(rel);
      for (const abs of cands) await safeUnlink(abs);
    }

    await run('BEGIN');

    // 2) cascada dinámica: borra filas hijas donde exista columna subject_id/materia_id
    const tables = (await all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`))
      .map(r => r.name);

    const candidatesCols = ['subject_id','subjectId','materia_id','materiaId'];
    for (const t of tables) {
      try {
        const cols = await all(`PRAGMA table_info(${t})`);
        const col = cols.find(c => c.name && candidatesCols.includes(c.name));
        if (col) {
          await run(`DELETE FROM ${t} WHERE ${col.name} = ?`, [id]);
        }
      } catch (e) {
        console.warn(`Skip cascade on table ${t}:`, e.message);
      }
    }

    // 3) borrar subject
    await run(`DELETE FROM subjects WHERE id = ?`, [id]);

    await run('COMMIT');

    if ((req.headers.accept || '').includes('application/json')) {
      return res.json({ ok: true });
    }
    return res.redirect('back');
  } catch (e) {
    try { await run('ROLLBACK'); } catch (_) {}
    console.error('DELETE subject error:', e);
    return res.status(500).json({ ok:false, error: e.message || 'error eliminando' });
  }
});

// DELETE /app/subjects/:id  (para fetch/axios)
app.delete('/app/subjects/:id', ensureAdmin, async (req, res) => {
  // reutiliza el handler de arriba
  req.method = 'POST';
  req.url = `/app/subjects/${req.params.id}/delete`;
  app._router.handle(req, res);
});

/* =========================
   Init DB + Listen
   ========================= */
init().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Servidor en http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌ Error inicializando DB:', err);
  process.exit(1);
});

// Preguntas Admin (subida de archivos Materia+Plan)
app.use('/app/preguntas', require('./routes/preguntas')());