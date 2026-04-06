// routes/auth.js
const express = require('express');
const bcrypt  = require('bcrypt');
const { run, get } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');
const { sendWelcomeVerificationEmail, sendPasswordResetCodeEmail } = require('../services/emailService');
const { sendWelcomeEmail } = require('../services/mailer');
const { isDisposableEmail } = require('../utils/disposable-email-domains');

// util de verificación para saber si está activa


/**
 * Migración: quitar CHECK plan IN (7,8) de la tabla users si existe.
 * En libSQL/Turso (HTTP/hrana), NO usamos BEGIN/COMMIT porque puede fallar (stateless).
 * Hacemos best-effort sin transacción.
 */
async function ensureUsersPlanRelaxed() {
  try {
    const row = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`);
    if (!row || !row.sql) return;

    const sql = String(row.sql);
    const hasCheck = /CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/i.test(sql);
    if (!hasCheck) return;

    // Si ya existe users_v2, limpiamos para evitar conflictos
    try { await run(`DROP TABLE IF EXISTS users_v2`); } catch (_) {}

    const newCreate = sql
      .replace(/CHECK\s*\(\s*plan\s+IN\s*\(\s*7\s*,\s*8\s*\)\s*\)/ig, '')
      .replace(/CREATE\s+TABLE\s+("?users"?)/i, 'CREATE TABLE users_v2');

    try {
      await run(newCreate);
      await run(`INSERT INTO users_v2 SELECT * FROM users`);
      await run(`DROP TABLE users`);
      await run(`ALTER TABLE users_v2 RENAME TO users`);
      console.log('[migración] users: CHECK plan IN (7,8) removido');
    } catch (e) {
      // cleanup best-effort
      try { await run(`DROP TABLE IF EXISTS users_v2`); } catch (_) {}
      console.warn('[migración] users no se pudo completar:', e?.message || e);
    }
  } catch (e) {
    console.warn('No se pudo verificar/migrar users:', e?.message);
  }
}

module.exports = ({ passport }) => {
  const router = express.Router();

  // Ejecutar migración para relajar el CHECK del plan en users
  (async () => { try { await ensureUsersPlanRelaxed(); } catch (_) {} })();
    const googleAuthEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const microsoftAuthEnabled = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

  router.use((req, res, next) => {
    res.locals.googleAuthEnabled = googleAuthEnabled;
    res.locals.microsoftAuthEnabled = microsoftAuthEnabled;
    next();
  });
  // ===== Helpers =====
  function normStr(s){ return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
    function isBlockedEmailAddress(email = '') {
    const value = String(email || '').trim().toLowerCase();
    if (!value) return false;

    return (
      value.includes('@bloquear') ||
      value.endsWith('@duoley.com') ||
      value.endsWith('.duoley.com')
    );
  }

  // ✅ Fuente ÚNICA de verdad (NO depende de DB)
  const CAREERS = [
    'Lic. en Administración de Empresas',
    'Contabilidad',
    'Lic. en Economía'
  ];

  const PLANS_BY_CAREER = {
    'Lic. en Administración de Empresas': [6, 7, 8],
    'Contabilidad': [6, 7],
    'Lic. en Economía': [6, 7]
  };

  function safeNormalizeCareer(input) {
    const c = typeof normalizeCareer === 'function' ? normalizeCareer(input || '') : String(input || '');
    if (CAREERS.includes(c)) return c;

    const lc = String(input || '').toLowerCase();
    if (lc.includes('admin')) return 'Lic. en Administración de Empresas';
    if (lc.includes('cont')) return 'Contabilidad';
    if (lc.includes('econo')) return 'Lic. en Economía';
    return '';
  }

  async function getCareerPlanOptions() {
    const careerOptions = CAREERS.slice();

    const union = new Set();
    Object.values(PLANS_BY_CAREER).forEach(arr => arr.forEach(p => union.add(p)));
    const planOptions = Array.from(union).sort((a,b)=>a-b);

    const plansByCareer = {};
    careerOptions.forEach(c => {
      plansByCareer[c] = (PLANS_BY_CAREER[c] || []).slice().sort((a,b)=>a-b);
    });

    return { careerOptions, planOptions, plansByCareer };
  }

    function generateVerificationCode() {
    return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
  }
    const GOOGLE_LEGAL_SESSION_KEY = 'google_oauth_legal_accepted_at';
    const GOOGLE_LEGAL_ORIGIN_SESSION_KEY = 'google_oauth_legal_origin';
    const GOOGLE_LEGAL_TTL_MS = 10 * 60 * 1000;

    function rememberGoogleLegalAcceptance(req, origin = '/login') {
      if (!req.session) return;
      req.session[GOOGLE_LEGAL_SESSION_KEY] = Date.now();
      req.session[GOOGLE_LEGAL_ORIGIN_SESSION_KEY] = origin === '/register' ? '/register' : '/login';
    }

    function hasFreshGoogleLegalAcceptance(req) {
      const raw = Number(req.session?.[GOOGLE_LEGAL_SESSION_KEY] || 0);
      return Number.isFinite(raw) && raw > 0 && (Date.now() - raw) <= GOOGLE_LEGAL_TTL_MS;
    }

    function getGoogleLegalOrigin(req) {
      const origin = String(req.session?.[GOOGLE_LEGAL_ORIGIN_SESSION_KEY] || '').trim();
      return origin === '/register' ? '/register' : '/login';
    }

    function clearGoogleLegalAcceptance(req) {
      if (!req.session) return;
      delete req.session[GOOGLE_LEGAL_SESSION_KEY];
      delete req.session[GOOGLE_LEGAL_ORIGIN_SESSION_KEY];
    }
  function finishPassportLogin(req, res, next, user, { remember = false, redirectTo = '/app/materias' } = {}) {
    try {
      if (req.session && req.session.user && req.session.user.role === 'guest') {
        delete req.session.user;
      }
    } catch (_) {}

    return req.logIn(user, async (err2) => {
      if (err2) return next(err2);

      try {
        const flag = await get(
          `SELECT multi_device_logout_notice FROM users WHERE id=?`,
          [user.id]
        );
        if (flag && Number(flag.multi_device_logout_notice) === 1) {
          req.session.multiDeviceNotice = 1;
          await run(
            `UPDATE users SET multi_device_logout_notice=0 WHERE id=?`,
            [user.id]
          );
        }
      } catch (_) {}

      if (remember) {
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        req.session.cookie.maxAge = THIRTY_DAYS_MS;
        req.session.cookie.originalMaxAge = THIRTY_DAYS_MS;
        req.session.cookie.expires = new Date(Date.now() + THIRTY_DAYS_MS);
      } else {
        req.session.cookie.expires = false;
        req.session.cookie.maxAge = null;
        req.session.cookie.originalMaxAge = null;
      }

      return req.session.save(() => res.redirect(redirectTo));
    });
  }
  // ===== Endpoints auxiliares para selects dependientes =====
  router.get('/plans', async (req, res) => {
    try {
      const career = safeNormalizeCareer(String(req.query.career || '').trim());
      if (!career) return res.json({ ok:true, career:'', plans: [] });
      return res.json({ ok:true, career, plans: (PLANS_BY_CAREER[career] || []).slice() });
    } catch (e) {
      console.error('GET /auth/plans error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo obtener planes' });
    }
  });

  router.get('/options', async (_req, res) => {
    try {
      const { careerOptions, plansByCareer } = await getCareerPlanOptions();
      return res.json({ ok:true, careers: careerOptions, plansByCareer });
    } catch (e) {
      console.error('GET /auth/options error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo obtener opciones' });
    }
  });

  // --- Invitado ---
  router.post('/guest', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const careerNorm = safeNormalizeCareer(String(req.body?.career || '').trim());
      if (!careerNorm) return res.redirect('/login');

      const allowedPlans = (PLANS_BY_CAREER[careerNorm] || []);
      let planNum = parseInt(String(req.body?.plan || '0'), 10);
      if (!Number.isFinite(planNum) || !allowedPlans.includes(planNum)) {
        planNum = allowedPlans[0] || 6;
      }
      const guestLegalAcceptedAt = new Date().toISOString();

      // ✅ Setear sesión como invitado
      req.session.user = {
        id: 0,
        name: 'Invitado',
        surname: '',
        email: '',
        role: 'guest',
        career: careerNorm,
        plan: planNum,
        avatarUrl: '',
        instagram_username: '',
        terms_accepted_at: guestLegalAcceptedAt,
        privacy_accepted_at: guestLegalAcceptedAt
      };

      // ✅ Sesión normal (se borra al cerrar el navegador)
      req.session.cookie.expires = false;
      req.session.cookie.maxAge = null;

      return req.session.save(() => res.redirect('/app/materias'));
    } catch (e) {
      console.error('POST /guest error:', e);
      return res.redirect('/login');
    }
  });

    // --- Completar carrera + plan para cuentas sociales ---
  router.get('/complete-career-plan', async (req, res) => {
    try {
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        return res.redirect('/login');
      }
      if (req.user && req.user.role === 'guest') {
        return res.redirect('/login');
      }

      const dbUser = await get(
        `SELECT id, name, email, career, plan, career_plan_completed FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
      );
      if (!dbUser) {
        return res.redirect('/login');
      }

      const currentCareer = safeNormalizeCareer(String(dbUser.career || '').trim());
      const allowedPlans = PLANS_BY_CAREER[currentCareer] || [];
      const currentPlanNum = parseInt(String(dbUser.plan || '0'), 10);
      const currentPlan = allowedPlans.includes(currentPlanNum) ? String(currentPlanNum) : '';

      if (Number(dbUser.career_plan_completed || 0) === 1 && currentCareer && currentPlan) {
        return res.redirect('/app/materias');
      }

      res.locals.hideTabbar = true;

      const { careerOptions, planOptions, plansByCareer } = await getCareerPlanOptions();

      return res.render('complete-career-plan', {
        title: 'Elegí tu carrera y plan',
        userName: String(dbUser.name || 'Hola'),
        form: {
          career: currentCareer,
          plan: currentPlan
        },
        careerOptions,
        planOptions,
        plansByCareer
      });
    } catch (e) {
      console.error('GET /complete-career-plan error:', e);
      return res.redirect('/login');
    }
  });

  router.post('/complete-career-plan', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        return res.redirect('/login');
      }
      if (req.user && req.user.role === 'guest') {
        return res.redirect('/login');
      }

      const { careerOptions, planOptions, plansByCareer } = await getCareerPlanOptions();

      const careerNorm = safeNormalizeCareer(String(req.body?.career || '').trim());
      const allowedPlans = PLANS_BY_CAREER[careerNorm] || [];
      let planNum = parseInt(String(req.body?.plan || '0'), 10);

      if (!careerNorm || !allowedPlans.length) {
        res.locals.hideTabbar = true;
        return res.status(400).render('complete-career-plan', {
          title: 'Elegí tu carrera y plan',
          userName: String(req.user?.name || 'Hola'),
          error: 'Elegí una carrera válida.',
          form: {
            career: '',
            plan: ''
          },
          careerOptions,
          planOptions,
          plansByCareer
        });
      }

      if (!Number.isFinite(planNum) || !allowedPlans.includes(planNum)) {
        res.locals.hideTabbar = true;
        return res.status(400).render('complete-career-plan', {
          title: 'Elegí tu carrera y plan',
          userName: String(req.user?.name || 'Hola'),
          error: 'Elegí un plan válido para esa carrera.',
          form: {
            career: careerNorm,
            plan: ''
          },
          careerOptions,
          planOptions,
          plansByCareer
        });
      }

      await run(
        `UPDATE users
            SET career = ?,
                plan = ?,
                career_plan_completed = 1
          WHERE id = ?`,
        [careerNorm, planNum, req.user.id]
      );

      // sincronizar req.user + sesión actual
      if (req.user) {
        req.user.career = careerNorm;
        req.user.plan = planNum;
        req.user.career_plan_completed = 1;
      }

      if (req.session) {
        req.session.user = req.session.user || {};
        req.session.user.career = careerNorm;
        req.session.user.plan = planNum;
        req.session.user.career_plan_completed = 1;

        if (req.session.passport && req.session.passport.user) {
          req.session.passport.user.career = careerNorm;
          req.session.passport.user.plan = planNum;
          req.session.passport.user.career_plan_completed = 1;
        }
      }

      return req.session.save(() => res.redirect('/app/materias'));
    } catch (e) {
      console.error('POST /complete-career-plan error:', e);
      return res.redirect('/complete-career-plan');
    }
  });

  // --- Login ---
  router.get('/login', async (req, res) => {
    try {
      if (req.isAuthenticated && req.isAuthenticated()) {
        const dbUser = await get(
          `SELECT is_verified FROM users WHERE id = ? LIMIT 1`,
          [req.user.id]
        );
        return res.redirect(Number(dbUser?.is_verified || 0) === 1 ? '/app/materias' : '/verificar');
      }
    } catch (e) {
      console.error('GET /login redirect check error:', e);
    }

    res.locals.hideTabbar = true;

    const googleLegalRequired = String(req.query.google_legal || '').trim() === '1';

    return res.render('login', {
      title: 'Login',
      ...(googleLegalRequired ? {
        error: 'Antes de continuar con Google, aceptá los Términos y Condiciones y la Política de Privacidad.'
      } : {})
    });
  });

  router.post('/login', (req, res, next) => {
    let { email, password, remember } = req.body;
    email = String(email || '').trim().toLowerCase();
    req.body.email = email;

    // ✅ Si venías como invitado, limpiamos la marca antes de autenticar
    try {
      if (req.session && req.session.user && req.session.user.role === 'guest') {
        delete req.session.user;
      }
    } catch (_) {}

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
      
      const rememberRaw = String(remember || '').toLowerCase();
      const wantsRemember =
        rememberRaw === '1' ||
        rememberRaw === 'true' ||
        rememberRaw === 'on' ||
        rememberRaw === 'yes';

      const redirectTo = Number(user.is_verified || 0) === 1 ? '/app/materias' : '/verificar';
      return finishPassportLogin(req, res, next, user, { remember: wantsRemember, redirectTo });
    })(req, res, next);
  });
  router.get('/auth/google', (req, res, next) => {
    if (!googleAuthEnabled) {
      res.locals.hideTabbar = true;
      return res.status(503).render('login', {
        title: 'Login',
        error: 'Google no está configurado todavía en el servidor.'
      });
    }

    const acceptLegal = String(req.query.accept_legal || '').trim() === '1';
    const referer = String(req.get('referer') || '');
    const origin = referer.includes('/register') ? '/register' : '/login';

    if (!acceptLegal) {
      clearGoogleLegalAcceptance(req);
      return res.redirect(`${origin}?google_legal=1`);
    }

    rememberGoogleLegalAcceptance(req, origin);

    if (req.session && typeof req.session.save === 'function') {
      return req.session.save(() => {
        return passport.authenticate('google', {
          scope: ['profile', 'email'],
          prompt: 'select_account'
        })(req, res, next);
      });
    }

    return passport.authenticate('google', {
      scope: ['profile', 'email'],
      prompt: 'select_account'
    })(req, res, next);
  });

  router.get('/auth/google/callback', (req, res, next) => {
    if (!googleAuthEnabled) {
      res.locals.hideTabbar = true;
      return res.redirect('/login');
    }

    if (!hasFreshGoogleLegalAcceptance(req)) {
      const backTo = getGoogleLegalOrigin(req);
      clearGoogleLegalAcceptance(req);
      return res.redirect(`${backTo}?google_legal=1`);
    }

    return passport.authenticate('google', async (err, user, info) => {
      if (err) {
        clearGoogleLegalAcceptance(req);
        console.error('Google OAuth callback error:', err);
        res.locals.hideTabbar = true;
        return res.status(401).render('login', {
          title: 'Login',
          error: err?.message || 'No se pudo iniciar sesión con Google.'
        });
      }

      if (!user) {
        clearGoogleLegalAcceptance(req);
        res.locals.hideTabbar = true;
        return res.status(401).render('login', {
          title: 'Login',
          error: info?.message || 'No se pudo iniciar sesión con Google.'
        });
      }

      try {
        await run(
          `UPDATE users
              SET terms_accepted_at = datetime('now'),
                  privacy_accepted_at = datetime('now')
            WHERE id = ?`,
          [user.id]
        );
      } catch (legalErr) {
        console.error('Google OAuth legal acceptance update error:', legalErr);
      }

      clearGoogleLegalAcceptance(req);
      return finishPassportLogin(req, res, next, user);
    })(req, res, next);
  });

  router.get('/auth/microsoft', (req, res, next) => {
    if (!microsoftAuthEnabled) {
      res.locals.hideTabbar = true;
      return res.status(503).render('login', {
        title: 'Login',
        error: 'Microsoft no está configurado todavía en el servidor.'
      });
    }
    return passport.authenticate('microsoft', {
      prompt: 'select_account',
      scope: ['openid', 'profile', 'email', 'user.read']
    })(req, res, next);
  });

  router.get('/auth/microsoft/callback', (req, res, next) => {
    if (!microsoftAuthEnabled) {
      res.locals.hideTabbar = true;
      return res.redirect('/login');
    }
    return passport.authenticate('microsoft', (err, user, info) => {
      if (err) {
        console.error('Microsoft OAuth callback error:', err);
        res.locals.hideTabbar = true;
        return res.status(401).render('login', {
          title: 'Login',
          error: err?.message || 'No se pudo iniciar sesión con Microsoft.'
        });
      }
      if (!user) {
        res.locals.hideTabbar = true;
        return res.status(401).render('login', {
          title: 'Login',
          error: info?.message || 'No se pudo iniciar sesión con Microsoft.'
        });
      }
      return finishPassportLogin(req, res, next, user);
    })(req, res, next);
  });

  // --- Registro ---
  router.get('/register', async (req, res) => {
    try {
      if (req.isAuthenticated && req.isAuthenticated()) {
        const dbUser = await get(
          `SELECT is_verified FROM users WHERE id = ? LIMIT 1`,
          [req.user.id]
        );
        return res.redirect(Number(dbUser?.is_verified || 0) === 1 ? '/app/materias' : '/verificar');
      }

      res.locals.hideTabbar = true;

      const { careerOptions, planOptions } = await getCareerPlanOptions();
      const googleLegalRequired = String(req.query.google_legal || '').trim() === '1';

      return res.render('register', {
        title: 'Registro',
        form: {},
        careerOptions,
        planOptions,
        verifyEnabled: false,
        ...(googleLegalRequired ? {
          error: 'Antes de continuar con Google, aceptá los Términos y Condiciones y la Política de Privacidad.'
        } : {})
      });
    } catch (e) {
      console.error('GET /register error:', e);
      res.locals.hideTabbar = true;
      return res.render('register', {
        title: 'Registro',
        form: {},
        careerOptions: CAREERS.slice(),
        planOptions: [6, 7, 8],
        verifyEnabled: false,
        error: 'No se pudo cargar el registro. Probá de nuevo.'
      });
    }
  });

    router.post('/register', async (req, res, next) => {
    const { careerOptions, planOptions } = await getCareerPlanOptions();

    try {
      const {
        name,
        surname,
        email: rawEmail,
        password,
        password_repeat,
        phone,
        career,
        plan,
        accept_legal
      } = req.body;

      const email = String(rawEmail || '').trim().toLowerCase();
      const userName = String(name || '').trim().replace(/\s+/g, ' ');
      const careerNorm = safeNormalizeCareer(career);

      const allowedPlans = (PLANS_BY_CAREER[careerNorm] || []);
      let planNum = parseInt(plan, 10);
      if (!Number.isFinite(planNum) || !allowedPlans.includes(planNum)) {
        planNum = allowedPlans[0] || 6;
      }
      const acceptLegal = String(accept_legal || '').trim() === '1';

if (!acceptLegal) {
  res.locals.hideTabbar = true;
  return res.status(400).render('register', {
    title: 'Registrarse',
    error: 'Debés aceptar los Términos y Condiciones y las Políticas de Privacidad.',
    form: { name: userName, surname, email, phone, career: careerNorm, plan: String(planNum), accept_legal: '' },
    careerOptions,
    planOptions,
    verifyEnabled: false
  });
}

      if (!userName || !email || !password || !careerNorm) {
        res.locals.hideTabbar = true;
        return res.status(400).render('register', {
          title: 'Registrarse',
          error: 'Completá nombre de usuario, email, contraseña y carrera.',
          form: { name: userName, surname, email, phone, career: careerNorm, plan: String(planNum) },
          careerOptions,
          planOptions,
          verifyEnabled: false
        });
      }

      if (typeof password_repeat !== 'undefined' && String(password_repeat) !== String(password)) {
        res.locals.hideTabbar = true;
        return res.status(400).render('register', {
          title: 'Registrarse',
          error: 'Las contraseñas no coinciden.',
          form: { name: userName, surname, email, phone, career: careerNorm, plan: String(planNum) },
          careerOptions,
          planOptions,
          verifyEnabled: false
        });
      }

      if (isBlockedEmailAddress(email)) {
        res.locals.hideTabbar = true;
        return res.status(400).render('register', {
          title: 'Registrarse',
          error: 'No se permiten emails con dominios bloqueados. Usá otro email.',
          form: { name: userName, surname, email: '', phone, career: careerNorm, plan: String(planNum) },
          careerOptions,
          planOptions,
          verifyEnabled: false
        });
      }

      const existingUserName = await get(
        `SELECT id FROM users WHERE lower(trim(name)) = ? LIMIT 1`,
        [userName.toLowerCase()]
      );

      if (existingUserName) {
        res.locals.hideTabbar = true;
        return res.status(400).render('register', {
          title: 'Registrarse',
          error: 'Ese nombre de usuario ya existe. Elegí otro.',
          form: { name: '', surname, email, phone, career: careerNorm, plan: String(planNum) },
          careerOptions,
          planOptions,
          verifyEnabled: false
        });
      }

      const existing = await get(
        `SELECT id, is_verified FROM users WHERE email = ?`,
        [email]
      );

      if (existing) {
        res.locals.hideTabbar = true;
        return res.status(400).render('register', {
          title: 'Registrarse',
          error: Number(existing.is_verified || 0) === 1
            ? 'Ese mail ya existe, probá iniciar sesión con esas credenciales.'
            : 'Ese mail ya está registrado pero todavía no está verificado. Iniciá sesión y completá la verificación.',
          form: { name, surname, email: '', phone, career: careerNorm, plan: String(planNum) },
          careerOptions,
          planOptions,
          verifyEnabled: false
        });
      }

      let hasSurname = false;
      let hasPhone = false;

      try { hasSurname = !!(await get(`SELECT 1 FROM pragma_table_info('users') WHERE name='surname'`)); } catch (_) {}
      try { hasPhone   = !!(await get(`SELECT 1 FROM pragma_table_info('users') WHERE name='phone'`)); } catch (_) {}

      const hash = await bcrypt.hash(password, 10);
      const verificationCode = generateVerificationCode();

      if (hasSurname && hasPhone) {
        await run(
        `INSERT INTO users (name, surname, email, pass_hash, career, plan, phone, verification_code, is_verified, terms_accepted_at, privacy_accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
        [userName, surname || '', email, hash, careerNorm, planNum, String(phone || ''), verificationCode]
      );
      } else if (hasSurname && !hasPhone) {
        await run(
        `INSERT INTO users (name, surname, email, pass_hash, career, plan, verification_code, is_verified, terms_accepted_at, privacy_accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
        [userName, surname || '', email, hash, careerNorm, planNum, verificationCode]
      );
      } else if (!hasSurname && hasPhone) {
        await run(
          `INSERT INTO users (name, email, pass_hash, career, plan, phone, verification_code, is_verified, terms_accepted_at, privacy_accepted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
          [userName, email, hash, careerNorm, planNum, String(phone || ''), verificationCode]
        );
      } else {
        await run(
          `INSERT INTO users (name, email, pass_hash, career, plan, verification_code, is_verified, terms_accepted_at, privacy_accepted_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`,
          [userName, email, hash, careerNorm, planNum, verificationCode]
        );
      }

      const newUser = await get(
        `SELECT id, name, email, role, career, plan, avatarUrl, instagram_username, is_verified
           FROM users
          WHERE email = ?`,
        [email]
      );

      try {
        await sendWelcomeVerificationEmail({
          toEmail: email,
          toName: userName,
          code: verificationCode
        });
      } catch (mailErr) {
        console.error('Brevo send verification email error:', {
          message: mailErr?.message,
          name: mailErr?.name,
          statusCode: mailErr?.statusCode,
          body: mailErr?.body,
          rawResponse: mailErr?.rawResponse?.body
        });
        try { await run(`DELETE FROM users WHERE email = ?`, [email]); } catch (_) {}

        res.locals.hideTabbar = true;
        return res.status(500).render('register', {
          title: 'Registrarse',
          error: 'No se pudo enviar el email de verificación. Probá nuevamente.',
          form: { name, surname, email: '', phone, career: careerNorm, plan: String(planNum) },
          careerOptions,
          planOptions,
          verifyEnabled: false
        });
      }

      (async () => {
        try {
          await sendWelcomeEmail(email, userName);
        } catch (mailErr) {
          console.error('Resend send welcome email error (manual register):', {
            email,
            message: mailErr?.message,
            name: mailErr?.name,
            cause: mailErr?.cause,
            error: mailErr?.error
          });
        }
      })();

      req.login(newUser, (err) => {
        if (err) return next(err);

        if (req.user) req.user.is_verified = 0;

        if (req.session) {
          req.session.user = req.session.user || {};
          req.session.user.is_verified = 0;

          if (req.session.passport && req.session.passport.user) {
            req.session.passport.user.is_verified = 0;
          }
        }

        return req.session.save(() => res.redirect('/verificar?sent=1'));
      });

    } catch (err) {
      console.error('POST /register error', err);
      res.locals.hideTabbar = true;
      return res.status(500).render('register', {
        title: 'Registrarse',
        error: 'Ocurrió un error al crear la cuenta. Intentá nuevamente.',
        form: {
          name: String(req.body?.name || '').trim().replace(/\s+/g, ' '),
          surname: (req.body?.surname || ''),
          email: '',
          phone: (req.body?.phone || ''),
          career: safeNormalizeCareer(req.body?.career || ''),
          plan: String(parseInt(req.body?.plan, 10) || '')
        },
        careerOptions,
        planOptions,
        verifyEnabled: false
      });
    }
  });

    // ===== Verificación de email =====
  // ===== Verificación de email =====
  router.get('/verificar', async (req, res) => {
    try {
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        return res.redirect('/login');
      }

      if (req.user && req.user.role === 'guest') {
        return res.redirect('/login');
      }

      const user = await get(
        `SELECT id, email, is_verified FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
      );

      if (!user) {
        return res.redirect('/login');
      }

      if (Number(user.is_verified || 0) === 1) {
        return res.redirect('/app/materias');
      }

      res.locals.hideTabbar = true;
      return res.render('verificar', {
        title: 'Verificar email',
        email: String(user.email || ''),
        sent: String(req.query.sent || '') === '1',
        resent: String(req.query.resent || '') === '1',
        error: null
      });
    } catch (e) {
      console.error('GET /verificar error:', e);
      return res.redirect('/login');
    }
  });

  router.post('/verificar', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        return res.redirect('/login');
      }

      if (req.user && req.user.role === 'guest') {
        return res.redirect('/login');
      }

      const user = await get(
        `SELECT id, email, verification_code, is_verified FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
      );

      if (!user) {
        return res.redirect('/login');
      }

      if (Number(user.is_verified || 0) === 1) {
        return res.redirect('/app/materias');
      }

      const code = String(req.body?.code || '').trim().replace(/\D/g, '').slice(0, 6);

      if (!code || code.length !== 6) {
        res.locals.hideTabbar = true;
        return res.status(400).render('verificar', {
          title: 'Verificar email',
          email: String(user.email || ''),
          sent: false,
          resent: false,
          error: 'Ingresá un código válido de 6 dígitos.'
        });
      }

      if (String(user.verification_code || '') !== code) {
        res.locals.hideTabbar = true;
        return res.status(400).render('verificar', {
          title: 'Verificar email',
          email: String(user.email || ''),
          sent: false,
          resent: false,
          error: 'El código ingresado no es correcto.'
        });
      }

      await run(
        `UPDATE users SET is_verified = 1, verification_code = NULL WHERE id = ?`,
        [user.id]
      );

      if (req.user) req.user.is_verified = 1;

      if (req.session) {
        req.session.user = req.session.user || {};
        req.session.user.is_verified = 1;

        if (req.session.passport && req.session.passport.user) {
          req.session.passport.user.is_verified = 1;
        }
      }

      return req.session.save(() => res.redirect('/app/materias'));
    } catch (e) {
      console.error('POST /verificar error:', e);

      let email = '';
      try {
        const user = await get(`SELECT email FROM users WHERE id = ? LIMIT 1`, [req.user.id]);
        email = String(user?.email || '');
      } catch (_) {}

      res.locals.hideTabbar = true;
      return res.status(500).render('verificar', {
        title: 'Verificar email',
        email,
        sent: false,
        resent: false,
        error: 'No se pudo verificar el email. Probá nuevamente.'
      });
    }
  });

  router.post('/verificar/reenviar', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        return res.redirect('/login');
      }

      if (req.user && req.user.role === 'guest') {
        return res.redirect('/login');
      }

      const user = await get(
        `SELECT id, name, email, is_verified FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
      );

      if (!user) {
        return res.redirect('/login');
      }

      if (Number(user.is_verified || 0) === 1) {
        return res.redirect('/app/materias');
      }

      if (isDisposableEmail(String(user.email || ''))) {
        res.locals.hideTabbar = true;
        return res.status(400).render('verificar', {
          title: 'Verificar email',
          email: String(user.email || ''),
          sent: false,
          resent: false,
          error: 'No se permiten emails temporales o desechables. Creá la cuenta con un email real.'
        });
      }

      const verificationCode = generateVerificationCode();

      await run(
        `UPDATE users SET verification_code = ?, is_verified = 0 WHERE id = ?`,
        [verificationCode, user.id]
      );

      await sendWelcomeVerificationEmail({
        toEmail: String(user.email || '').trim(),
        toName: String(user.name || 'Hola'),
        code: verificationCode
      });

      return res.redirect('/verificar?resent=1');
    } catch (e) {
      console.error('POST /verificar/reenviar error:', e);

      let email = '';
      try {
        const user = await get(`SELECT email FROM users WHERE id = ? LIMIT 1`, [req.user.id]);
        email = String(user?.email || '');
      } catch (_) {}

      res.locals.hideTabbar = true;
      return res.status(500).render('verificar', {
        title: 'Verificar email',
        email,
        sent: false,
        resent: false,
        error: 'No se pudo reenviar el código. Probá nuevamente.'
      });
    }
  });

  router.post('/verificar/cancelar', express.urlencoded({ extended: true }), async (req, res) => {
    try {
      if (!(req.isAuthenticated && req.isAuthenticated())) {
        return res.redirect('/register');
      }

      if (req.user && req.user.role === 'guest') {
        return res.redirect('/register');
      }

      const user = await get(
        `SELECT id, is_verified FROM users WHERE id = ? LIMIT 1`,
        [req.user.id]
      );

      if (!user) {
        return res.redirect('/register');
      }

      if (Number(user.is_verified || 0) === 1) {
        return res.redirect('/app/materias');
      }

      await run(
        `DELETE FROM users WHERE id = ? AND COALESCE(is_verified, 0) = 0`,
        [user.id]
      );

      return req.logout((logoutErr) => {
        if (logoutErr) {
          console.error('POST /verificar/cancelar logout error:', logoutErr);
          return res.redirect('/register');
        }

        if (req.session) {
          return req.session.destroy(() => {
            res.clearCookie('connect.sid');
            return res.redirect('/register');
          });
        }

        res.clearCookie('connect.sid');
        return res.redirect('/register');
      });
    } catch (e) {
      console.error('POST /verificar/cancelar error:', e);
      return res.redirect('/verificar');
    }
  });

  // ===== Recuperar contraseña =====
  router.get('/forgot', async (req, res) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return res.redirect('/app/materias');
    }

    try {
      if (req.session) {
        delete req.session.pwResetUid;
        delete req.session.pwResetCode;
        delete req.session.pwResetEmail;
      }
    } catch (_) {}

    res.locals.hideTabbar = true;
    const { careerOptions, planOptions } = await getCareerPlanOptions();
    return res.render('forgot', {
      error: null,
      title: 'Olvidé mi contraseña',
      form: {},
      careerOptions,
      planOptions
    });
  });

  router.post('/forgot', async (req, res) => {
    const { careerOptions, planOptions } = await getCareerPlanOptions();

    try {
      const email = normStr(req.body.email);
      const career = safeNormalizeCareer(req.body.career || '');
      const allowedPlans = PLANS_BY_CAREER[career] || [];
      const planNum = parseInt(String(req.body.plan || '0'), 10);

      const form = {
        email: String(req.body.email || '').trim(),
        career,
        plan: String(req.body.plan || '').trim()
      };

      if (!email || !career || !allowedPlans.includes(planNum)) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot', {
          error: 'Completá email, carrera y plan correctamente.',
          title: 'Olvidé mi contraseña',
          form,
          careerOptions,
          planOptions
        });
      }

      const user = await get(
        `SELECT id, name, email, career, plan FROM users WHERE lower(email)=lower(?) LIMIT 1`,
        [email]
      );

      if (!user) {
        console.log('[FORGOT] usuario no encontrado para email:', email);

        res.locals.hideTabbar = true;
        return res.status(400).render('forgot', {
          error: 'Los datos no coinciden con nuestros registros.',
          title: 'Olvidé mi contraseña',
          form,
          careerOptions,
          planOptions
        });
      }

      const dbCareer = safeNormalizeCareer(user.career || '');
      const dbPlanNum = parseInt(String(user.plan || '0'), 10);

      console.log('[FORGOT] comparación', {
        emailIngresado: email,
        emailDB: String(user.email || '').trim().toLowerCase(),
        careerIngresada: career,
        careerDB: dbCareer,
        planIngresado: planNum,
        planDB: dbPlanNum
      });

      if (dbCareer !== career || dbPlanNum !== planNum) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot', {
          error: 'Los datos no coinciden con nuestros registros.',
          title: 'Olvidé mi contraseña',
          form,
          careerOptions,
          planOptions
        });
      }

      const resetCode = generateVerificationCode();

      await sendPasswordResetCodeEmail({
        toEmail: String(user.email || '').trim(),
        toName: String(user.name || 'Hola'),
        code: resetCode
      });

      req.session.pwResetUid = user.id;
      req.session.pwResetCode = resetCode;
      req.session.pwResetEmail = String(user.email || '').trim().toLowerCase();

      return req.session.save(() => res.redirect('/forgot/reset?sent=1'));
    } catch (e) {
      console.error('POST /forgot error:', e);
      res.locals.hideTabbar = true;
      return res.status(500).render('forgot', {
        error: 'No se pudo enviar el código de verificación.',
        title: 'Olvidé mi contraseña',
        form: {
          email: String(req.body.email || '').trim(),
          career: safeNormalizeCareer(req.body.career || ''),
          plan: String(req.body.plan || '').trim()
        },
        careerOptions,
        planOptions
      });
    }
  });

  router.get('/forgot/reset', (req, res) => {
    if (!req.session.pwResetUid || !req.session.pwResetCode || !req.session.pwResetEmail) {
      return res.redirect('/forgot');
    }

    res.locals.hideTabbar = true;
    return res.render('forgot-reset', {
      error: null,
      title: 'Verificá tu código y actualizá tus datos',
      sent: String(req.query.sent || '') === '1',
      targetEmail: String(req.session.pwResetEmail || ''),
      form: {}
    });
  });

  router.post('/forgot/reset', async (req, res, next) => {
    try {
      const uid = req.session.pwResetUid;
      const sessionCode = String(req.session.pwResetCode || '');
      const currentEmail = String(req.session.pwResetEmail || '').trim().toLowerCase();

      if (!uid || !sessionCode || !currentEmail) {
        return res.redirect('/forgot');
      }

      const enteredCode = String(req.body.code || '').trim().replace(/\D/g, '').slice(0, 6);
      const newEmail = String(req.body.email || '').trim().toLowerCase();
      const p1 = String(req.body.pass1 || '');
      const p2 = String(req.body.pass2 || '');

      const form = {
        code: enteredCode,
        email: newEmail
      };

      if (!enteredCode || enteredCode.length !== 6) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot-reset', {
          error: 'Ingresá el código de 6 dígitos que te enviamos por email.',
          title: 'Verificá tu código y actualizá tus datos',
          sent: false,
          targetEmail: currentEmail,
          form
        });
      }

      if (enteredCode !== sessionCode) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot-reset', {
          error: 'El código ingresado no es correcto.',
          title: 'Verificá tu código y actualizá tus datos',
          sent: false,
          targetEmail: currentEmail,
          form
        });
      }

      const wantsEmailChange = !!newEmail && newEmail !== currentEmail;
      const wantsPasswordChange = !!p1 || !!p2;

      if (!wantsEmailChange && !wantsPasswordChange) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot-reset', {
          error: 'Ingresá un nuevo email, una nueva contraseña o ambos.',
          title: 'Verificá tu código y actualizá tus datos',
          sent: false,
          targetEmail: currentEmail,
          form
        });
      }

      if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        res.locals.hideTabbar = true;
        return res.status(400).render('forgot-reset', {
          error: 'Ingresá un email válido.',
          title: 'Verificá tu código y actualizá tus datos',
          sent: false,
          targetEmail: currentEmail,
          form
        });
      }

      if (wantsEmailChange) {
        const existing = await get(
          `SELECT id FROM users WHERE lower(email)=lower(?) AND id <> ? LIMIT 1`,
          [newEmail, uid]
        );

        if (existing) {
          res.locals.hideTabbar = true;
          return res.status(400).render('forgot-reset', {
            error: 'Ese email ya está siendo usado por otra cuenta.',
            title: 'Verificá tu código y actualizá tus datos',
            sent: false,
            targetEmail: currentEmail,
            form
          });
        }
      }

      if (wantsPasswordChange) {
        if (p1.length < 6) {
          res.locals.hideTabbar = true;
          return res.status(400).render('forgot-reset', {
            error: 'La nueva contraseña debe tener al menos 6 caracteres.',
            title: 'Verificá tu código y actualizá tus datos',
            sent: false,
            targetEmail: currentEmail,
            form
          });
        }

        if (p1 !== p2) {
          res.locals.hideTabbar = true;
          return res.status(400).render('forgot-reset', {
            error: 'Las contraseñas no coinciden.',
            title: 'Verificá tu código y actualizá tus datos',
            sent: false,
            targetEmail: currentEmail,
            form
          });
        }
      }

      const sets = [];
      const params = [];

      if (wantsEmailChange) {
        sets.push('email = ?');
        params.push(newEmail);
      }

      if (wantsPasswordChange) {
        const hash = await bcrypt.hash(p1, 10);
        sets.push('pass_hash = ?');
        params.push(hash);
      }

      params.push(uid);

      await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

      const updatedUser = await get(`SELECT * FROM users WHERE id = ? LIMIT 1`, [uid]);

      delete req.session.pwResetUid;
      delete req.session.pwResetCode;
      delete req.session.pwResetEmail;

      const redirectTo = Number(updatedUser?.is_verified || 0) === 1 ? '/app/materias' : '/verificar';
      return finishPassportLogin(req, res, next, updatedUser, { remember: false, redirectTo });
    } catch (e) {
      console.error('POST /forgot/reset error:', e);
      res.locals.hideTabbar = true;
      return res.status(500).render('forgot-reset', {
        error: 'No se pudieron guardar los cambios.',
        title: 'Verificá tu código y actualizá tus datos',
        sent: false,
        targetEmail: String(req.session?.pwResetEmail || ''),
        form: {
          code: String(req.body.code || '').trim().replace(/\D/g, '').slice(0, 6),
          email: String(req.body.email || '').trim().toLowerCase()
        }
      });
    }
  });

  // --- Logout ---
    // --- Logout ---
  async function doLogout(req, res) {
    const redirectTo = '/login';

    const sessionCookieName = process.env.SESSION_COOKIE_NAME || 'facultad.sid';
    const clearOpts = { path: '/' };
    if (process.env.SESSION_COOKIE_DOMAIN) clearOpts.domain = process.env.SESSION_COOKIE_DOMAIN;

    // ✅ limpiar el vínculo sid -> device (si existe la tabla)
    try {
      if (req.sessionID) {
        await run(`DELETE FROM device_sessions WHERE sid=?`, [String(req.sessionID)]);
      }
    } catch (_) {}

    const finish = () => {
      try { res.clearCookie(sessionCookieName, clearOpts); } catch (_) {}
      return res.redirect(redirectTo);
    };

    const destroySession = () => {
      if (req.session) {
        req.session.destroy(() => finish());
      } else {
        finish();
      }
    };

    if (typeof req.logout === 'function') {
      req.logout(() => destroySession());
    } else {
      destroySession();
    }
  }

  router.get('/logout', (req, res) => doLogout(req, res));
  router.post('/logout', (req, res) => doLogout(req, res));
  return router;
};
