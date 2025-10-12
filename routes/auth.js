// routes/auth.js
const express = require('express');
const bcrypt  = require('bcrypt');
const { run, get, all } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');

// util de verificación para saber si está activa
const verificationUtil = require('./verify').util;

/**
 * Migración: quitar CHECK plan IN (7,8) de la tabla users si existe.
 * Recrea la tabla sin ese CHECK, copia los datos y renombra.
 */
async function ensureUsersPlanRelaxed() {
  try {
    const row = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`);
    if (!row || !row.sql) return;

    const sql = String(row.sql);
    const hasCheck = /CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/i.test(sql);
    if (!hasCheck) return; // nada que hacer

    const newCreate = sql
      .replace(/CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/ig, '')
      .replace(/CREATE\s+TABLE\s+("?users"?)/i, 'CREATE TABLE users_v2');

    await run('BEGIN');
    try {
      await run(newCreate);
      await run(`INSERT INTO users_v2 SELECT * FROM users`);
      await run(`DROP TABLE users`);
      await run(`ALTER TABLE users_v2 RENAME TO users`);
      await run('COMMIT');
      console.log('[migración] users: CHECK plan IN (7,8) removido');
    } catch (e) {
      await run('ROLLBACK');
      console.error('[migración] users fallida:', e);
      throw e;
    }
  } catch (e) {
    console.warn('No se pudo verificar/migrar users:', e?.message);
  }
}

module.exports = ({ passport }) => {
  const router = express.Router();

  // Ejecutar migración para relajar el CHECK del plan en users
  (async () => { try { await ensureUsersPlanRelaxed(); } catch (_) {} })();

  // ===== Helpers =====
  function normStr(s){ return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

  // Devuelve: { careerOptions, planOptions, plansByCareer }
  async function getCareerPlanOptions() {
    // Carreras desde subjects/users (normalizadas)
    const careers = new Set();
    // Planes totales (unión) y por carrera
    const plansSet         = new Set();
    const plansByCareerMap = new Map();

    try {
      const sC = await all(`SELECT DISTINCT career FROM subjects WHERE career IS NOT NULL AND TRIM(career)<>''`);
      (sC || []).forEach(r => {
        const c = r && r.career ? normalizeCareer(r.career) : '';
        if (c) careers.add(c);
      });
    } catch (_) {}

    // Si no hay en subjects, caemos a users
    if (careers.size === 0) {
      try {
        const uC = await all(`SELECT DISTINCT career FROM users WHERE career IS NOT NULL AND TRIM(career)<>''`);
        (uC || []).forEach(r => {
          const c = r && r.career ? normalizeCareer(r.career) : '';
          if (c) careers.add(c);
        });
      } catch (_) {}
    }

    // Fallbacks si DB está vacía
    if (careers.size === 0) [
      'Lic. en Administración de Empresas',
      'Contabilidad',
      'Lic. en Economía',
      'Comercio Internacional',
      'Marketing',
      'Recursos Humanos',
      'Sistemas / GTI'
    ].forEach(c => careers.add(c));

    // Planes por carrera (desde subjects)
    try {
      const rows = await all(
        `SELECT career, plan
           FROM subjects
          WHERE career IS NOT NULL AND TRIM(career)<>'' AND plan IS NOT NULL`
      );
      (rows || []).forEach(r => {
        const c = normalizeCareer(r.career || '');
        const p = Number(r.plan);
        if (!c || !Number.isFinite(p)) return;
        plansSet.add(p);
        const arr = plansByCareerMap.get(c) || [];
        if (!arr.includes(p)) arr.push(p);
        plansByCareerMap.set(c, arr);
      });
    } catch (_) {}

    // Si no hay nada en subjects, armamos set de planes desde users (solo a modo informativo)
    if (plansSet.size === 0) {
      try {
        const uP = await all(`SELECT DISTINCT plan FROM users WHERE plan IS NOT NULL`);
        (uP || []).forEach(r => {
          const p = Number(r.plan);
          if (Number.isFinite(p)) plansSet.add(p);
        });
      } catch (_) {}
    }

    // Fallback de planes si sigue vacío
    if (plansSet.size === 0) [2008, 2016, 2021, 2022, 2023].forEach(p => plansSet.add(p));

    const careerOptions = [...careers].sort((a,b)=>a.localeCompare(b,'es'));
    const planOptions   = [...plansSet].sort((a,b)=>a-b);

    // normalizar mapa a objeto con arrays ordenados
    const plansByCareer = {};
    for (const c of careerOptions) {
      const arr = plansByCareerMap.get(c) || [];
      plansByCareer[c] = arr.sort((a,b)=>a-b);
    }

    return { careerOptions, planOptions, plansByCareer };
  }

  // Verifica si existe al menos un subject para esa combinación
  async function comboExists(career, plan) {
    const row = await get(
      `SELECT 1 AS ok FROM subjects WHERE LOWER(career)=LOWER(?) AND plan=? LIMIT 1`,
      [normalizeCareer(career), Number(plan)]
    );
    return !!row;
  }

  // ===== Endpoints auxiliares para selects dependientes =====

  // GET /auth/plans?career=Lic.%20en%20Econom%C3%ADa
  router.get('/plans', async (req, res) => {
    try {
      const career = normalizeCareer(String(req.query.career || '').trim());
      if (!career) return res.json({ ok:true, career:'', plans: [] });

      const rows = await all(
        `SELECT DISTINCT plan FROM subjects WHERE LOWER(career)=LOWER(?) AND plan IS NOT NULL ORDER BY plan`,
        [career]
      );
      const plans = (rows || []).map(r => Number(r.plan)).filter(n => Number.isFinite(n));
      return res.json({ ok:true, career, plans });
    } catch (e) {
      console.error('GET /auth/plans error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo obtener planes' });
    }
  });

  // GET /auth/options → carreras y mapa carrera→planes
  router.get('/options', async (_req, res) => {
    try {
      const { careerOptions, plansByCareer } = await getCareerPlanOptions();
      return res.json({ ok:true, careers: careerOptions, plansByCareer });
    } catch (e) {
      console.error('GET /auth/options error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo obtener opciones' });
    }
  });

  // --- Login ---
  router.get('/login', async (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.redirect('/app/materias');
    }
    res.locals.hideTabbar = true;
    res.render('login', { title: 'Login' });
  });

  router.post('/login', (req, res, next) => {
    const { email, password, remember } = req.body;

    passport.authenticate('local', (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        res.locals.hideTabbar = true;
        return res.status(401).render('login', {
          title: 'Login',
          error: info?.message || 'Credenciales inválidas',
          email,
          remember: !!remember
        });
      }
      req.logIn(user, (err2) => {
        if (err2) return next(err2);

        if (remember) {
          req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 7; // 7 días
        } else {
          req.session.cookie.expires = false;
          req.session.cookie.maxAge = null;
        }

        return res.redirect('/app/materias');
      });
    })(req, res, next);
  });

  // --- Registro ---
  router.get('/register', async (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.redirect('/app/materias');
    }
    res.locals.hideTabbar = true;
    const { careerOptions, planOptions } = await getCareerPlanOptions();
    res.render('register', { title: 'Registro', form: {}, careerOptions, planOptions });
  });

  router.post('/register', async (req, res, next) => {
    const { careerOptions, planOptions } = await getCareerPlanOptions();
    try {
      const { name, surname, email: rawEmail, password, career, plan } = req.body;

      const email = (rawEmail || '').trim().toLowerCase();
      const careerNorm = typeof normalizeCareer === 'function' ? normalizeCareer(career) : (career || '');
      const planNum = parseInt(plan, 10);

      const existing = await get(`SELECT id FROM users WHERE email = ?`, [email]);
      if (existing) {
        res.locals.hideTabbar = true;
        return res.render('register', {
          title: 'Registrarse',
          error: 'Ese mail ya existe, probá iniciar sesión con esas credenciales.',
          form: { name, surname, email: '', career: careerNorm, plan },
          careerOptions, planOptions
        });
      }

      // Validación fuerte: carrera/plan debe existir en subjects
      if (!careerNorm || !Number.isFinite(planNum) || !(await comboExists(careerNorm, planNum))) {
        res.locals.hideTabbar = true;
        return res.status(400).render('register', {
          title: 'Registrarse',
          error: `El plan ${plan} no está disponible para la carrera "${careerNorm}".`,
          form: { name, surname, email: email, career: careerNorm, plan },
          careerOptions, planOptions
        });
      }

      // ¿users tiene columna surname?
      let hasSurname = false;
      try {
        const cols = await get(`SELECT 1 FROM pragma_table_info('users') WHERE name='surname'`);
        hasSurname = !!cols;
      } catch (_) { hasSurname = false; }

      const hash = await bcrypt.hash(password, 10);

      if (hasSurname) {
        await run(
          `INSERT INTO users (name, surname, email, pass_hash, career, plan) VALUES (?, ?, ?, ?, ?, ?)`,
          [name, surname, email, hash, careerNorm, planNum]
        );
      } else {
        await run(
          `INSERT INTO users (name, email, pass_hash, career, plan) VALUES (?, ?, ?, ?, ?)`,
          [name, email, hash, careerNorm, planNum]
        );
      }

      const newUser = await get(`SELECT id, name, email, role, career, plan FROM users WHERE email = ?`, [email]);
      req.login(newUser, (err) => {
        if (err) return next(err);

        if (!verificationUtil.getEnabled()) {
          const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
          const now = Date.now();
          req.session.verifyAllowedUntil = now + THIRTY_DAYS;
          res.cookie('cw_allowed_until', now + THIRTY_DAYS, {
            maxAge: THIRTY_DAYS,
            httpOnly: false,
            sameSite: 'lax',
            path: '/'
          });
        }

        return res.redirect('/app/materias');
      });

    } catch (err) {
      console.error('POST /register error', err);
      res.locals.hideTabbar = true;
      return res.render('register', {
        title: 'Registrarse',
        error: 'Ocurrió un error al crear la cuenta. Intentá nuevamente.',
        form: {
          name: (req.body.name || ''),
          surname: (req.body.surname || ''),
          email: '',
          career: (req.body.career || ''),
          plan: (req.body.plan || '')
        },
        careerOptions, planOptions
      });
    }
  });

  // ===== Recuperar contraseña =====
  router.get('/forgot', async (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.redirect('/app/materias');
    }
    res.locals.hideTabbar = true;
    const { careerOptions, planOptions } = await getCareerPlanOptions();
    res.render('forgot', { error: null, title: 'Olvidé mi contraseña', form:{}, careerOptions, planOptions });
  });

  router.post('/forgot', async (req, res) => {
    const { careerOptions, planOptions } = await getCareerPlanOptions();
    try {
      const name   = normStr(req.body.name);
      const email  = normStr(req.body.email);
      const phone  = normStr(req.body.phone);
      const career = normalizeCareer(req.body.career || '');
      const plan   = String(req.body.plan || '').trim();

      if (!name || !email || !career || !plan) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot', {
          error: 'Faltan datos obligatorios', title: 'Olvidé mi contraseña',
          form: req.body, careerOptions, planOptions
        });
      }

      const user = await get(`SELECT * FROM users WHERE lower(email)=lower(?)`, [email]);
      if (!user) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot', {
          error: 'Los datos no coinciden con nuestros registros',
          title: 'Olvidé mi contraseña', form: req.body, careerOptions, planOptions
        });
      }

      const dbName   = normStr(user.name);
      const dbPhone  = ('phone' in user) ? normStr(user.phone) : '';
      const dbCareer = normalizeCareer(user.career || '');
      const dbPlan   = String(user.plan || '').trim();

      const ok =
        dbName === name &&
        dbCareer === career &&
        dbPlan === plan &&
        (!dbPhone || dbPhone === phone);

      if (!ok) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot', {
          error: 'Los datos no coinciden con nuestros registros',
          title: 'Olvidé mi contraseña', form: req.body, careerOptions, planOptions
        });
      }

      req.session.pwResetUid = user.id;
      return res.redirect('/forgot/reset');
    } catch (e) {
      console.error('POST /forgot error:', e);
      res.locals.hideTabbar = true;
      return res.status(500).render('forgot', {
        error: 'No se pudo procesar la solicitud',
        title: 'Olvidé mi contraseña', form: req.body, careerOptions, planOptions
      });
    }
  });

  router.get('/forgot/reset', (req, res) => {
    if (!req.session.pwResetUid) return res.redirect('/forgot');
    res.locals.hideTabbar = true;
    res.render('forgot-reset', { error: null, title: 'Elegí tu nueva contraseña' });
  });

  router.post('/forgot/reset', async (req, res) => {
    try {
      const uid   = req.session.pwResetUid;
      if (!uid) return res.redirect('/forgot');

      const p1 = String(req.body.pass1 || '');
      const p2 = String(req.body.pass2 || '');
      if (p1.length < 6) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot-reset', { error: 'La contraseña debe tener al menos 6 caracteres', title: 'Elegí tu nueva contraseña' });
      }
      if (p1 !== p2) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot-reset', { error: 'Las contraseñas no coinciden', title: 'Elegí tu nueva contraseña' });
      }

      const hash = await bcrypt.hash(p1, 10);
      await run(`UPDATE users SET pass_hash=? WHERE id=?`, [hash, uid]);

      delete req.session.pwResetUid;
      if (req.isAuthenticated && req.isAuthenticated()) {
        try { req.logout(()=>{}); } catch (_) {}
      }
      return res.redirect('/login?reset=ok');
    } catch (e) {
      console.error('POST /forgot/reset error:', e);
      res.locals.hideTabbar = true;
      return res.status(500).render('forgot-reset', { error: 'No se pudo actualizar la contraseña', title: 'Elegí tu nueva contraseña' });
    }
  });

  // --- Logout ---
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

  router.get('/logout', (req, res) => doLogout(req, res));
  router.post('/logout', (req, res) => doLogout(req, res));

  return router;
};