// server.js
require('dotenv').config();

const express         = require('express');
const path            = require('path');
const fs              = require('fs');
const fsp             = require('fs/promises'); // para borrado seguro
const session         = require('express-session');
const LibsqlSessionStore = require('./lib/libsqlSessionStore');
const passport        = require('passport');
const LocalStrategy   = require('passport-local').Strategy;
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: MicrosoftStrategy } = require('passport-microsoft');
const bcrypt          = require('bcrypt');
const crypto          = require('crypto');
const compression     = require('compression');
const methodOverride  = require('method-override');
const expressLayouts  = require('express-ejs-layouts');
const multer          = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { sendWelcomeEmail } = require('./services/mailer');

// 🔎 DEBUG DB (borrarlo luego)
console.log(
  '[DB]',
  process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || process.env.DATABASE_URL || '(no set)'
);
console.log(
  '[DB TOKEN len]',
  (process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || process.env.DATABASE_AUTH_TOKEN || '').length
);

const { db, all, get, run, init } = require('./models/db'); // ← agregado run
const { loadQuestions, loadQuestionsDb, loadQuestionsAnyPlan, loadQuestionsAnyPlanDb } = require('./lib/questions');

// Util de verificación (toggle, startedAt y consumir códigos)
const verifyUtil      = require('./routes/verify').util;

// 30 días
const GLOBAL_GRACE_MS   = 0;                         // ⏱ Sin gracia global: bloqueo inmediato
const INDIVIDUAL_MS     = 30 * 24 * 60 * 60 * 1000;  // ✅ 30 días luego de ingresar código

const app = express();

function verifyLocalMetricsWritable() {
  try {
    const dbDir = path.resolve(__dirname, 'db');
    const probeFile = path.resolve(dbDir, '.write-test.tmp');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(probeFile, `ok:${Date.now()}`, 'utf8');
    fs.unlinkSync(probeFile);
    console.log('[localMetrics] carpeta db/ con permisos de escritura OK:', dbDir);
  } catch (err) {
    console.error('[localMetrics] ERROR sin permisos de escritura en db/:', err?.message || err);
  }
}

verifyLocalMetricsWritable();

/* =========================
   Layout helpers / flags
   ========================= */
// Ocultar dock (tabbar) en login/register
app.use((req, res, next) => {
  res.locals.hideTabbar = /^\/(login|register|verificar)(\/|$)/.test(req.path);
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

app.use(compression({
  filter: (req, res) => {
    const url = String(req.originalUrl || req.url || '');

    // ❌ Nunca comprimir SSE de grupos
    if (/\/app\/grupos\/\d+\/stream(?:\?|$)/.test(url)) {
      return false;
    }

    return compression.filter(req, res);
  }
}));

app.use('/public', express.static(path.join(__dirname, 'public'), {
  maxAge: ((process.env.NODE_ENV || '').toLowerCase() === 'production') ? '7d' : 0,
  immutable: ((process.env.NODE_ENV || '').toLowerCase() === 'production'),
  etag: true,
  lastModified: true
}));

// OJO: con R2, los docs ya NO están en /public/uploads/docs.
// Dejamos la ruta por compatibilidad (si aún hay assets locales), pero los docs nuevos vienen por URL.
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

/* =========================
   Sesión
   =========================
   IMPORTANTE (hosting): no usar connect-sqlite3 porque depende de archivo local (sessions.sqlite).
   En free hosting el disco puede ser efímero. Para dejarlo simple y funcionando:
   usamos el store por defecto (MemoryStore). Más adelante si querés persistencia real:
   migramos a un store remoto (DB).
*/
app.set('trust proxy', 1);

const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
app.set('view cache', isProd);

// ✅ Store en Turso/libSQL: permite que Koyeb y Render compartan sesiones
const sessionStore = new LibsqlSessionStore({ get, run, ttlMs: SESSION_TTL_MS });

app.use(session({
  name: process.env.SESSION_COOKIE_NAME || 'facultad.sid',
  secret: process.env.SESSION_SECRET || 'supersecreto',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  rolling: false,
  unset: 'destroy',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd ? 'auto' : false,
    maxAge: null

    // ✅ OPCIONAL: si tenés dominio propio en Cloudflare, seteá esto en env
    // ,domain: process.env.SESSION_COOKIE_DOMAIN || undefined
  }
}));

const SOCIAL_ALLOWED_CAREERS = [
  'Lic. en Administración de Empresas',
  'Contabilidad',
  'Lic. en Economía'
];
const SOCIAL_PLANS_BY_CAREER = {
  'Lic. en Administración de Empresas': [6, 7, 8],
  'Contabilidad': [6, 7],
  'Lic. en Economía': [6, 7]
};
const SOCIAL_DEFAULT_CAREER_RAW = String(process.env.SOCIAL_DEFAULT_CAREER || 'Lic. en Administración de Empresas').trim();
const SOCIAL_DEFAULT_CAREER = SOCIAL_ALLOWED_CAREERS.includes(SOCIAL_DEFAULT_CAREER_RAW)
  ? SOCIAL_DEFAULT_CAREER_RAW
  : 'Lic. en Administración de Empresas';
const SOCIAL_DEFAULT_PLAN_RAW = parseInt(String(process.env.SOCIAL_DEFAULT_PLAN || '6'), 10);
const SOCIAL_DEFAULT_PLAN_ALLOWED = SOCIAL_PLANS_BY_CAREER[SOCIAL_DEFAULT_CAREER] || [6];
const SOCIAL_DEFAULT_PLAN = SOCIAL_DEFAULT_PLAN_ALLOWED.includes(SOCIAL_DEFAULT_PLAN_RAW)
  ? SOCIAL_DEFAULT_PLAN_RAW
  : SOCIAL_DEFAULT_PLAN_ALLOWED[0];
const APP_BASE_URL = String(process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`)
  .trim()
  .replace(/\/+$/, '');
const GOOGLE_CALLBACK_URL = String(process.env.GOOGLE_CALLBACK_URL || `${APP_BASE_URL}/auth/google/callback`).trim();
const MICROSOFT_TENANT = String(process.env.MICROSOFT_TENANT_ID || 'common').trim() || 'common';
const MICROSOFT_CALLBACK_URL = String(process.env.MICROSOFT_CALLBACK_URL || `${APP_BASE_URL}/auth/microsoft/callback`).trim();

function buildPassportSessionUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    career: user.career,
    plan: user.plan,
    email: user.email,
    phone: user.phone || '',
    avatarUrl: user.avatarUrl || '',
    instagram_username: user.instagram_username || '',
    is_verified: Number(user.is_verified || 0)
  };
}

const PASSPORT_USER_COLUMNS = `
  id,
  name,
  role,
  career,
  plan,
  email,
  phone,
  avatarUrl,
  instagram_username,
  is_verified,
  terms_accepted_at,
  privacy_accepted_at
`;

function normalizeEmailValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return v.includes('@') ? v : '';
}

function pickGoogleEmail(profile) {
  return normalizeEmailValue(profile?.emails?.[0]?.value);
}

function pickMicrosoftEmail(profile) {
  const candidates = [
    profile?.emails?.[0]?.value,
    profile?._json?.mail,
    profile?._json?.userPrincipalName,
    profile?._json?.preferred_username,
    profile?.username,
    profile?.upn
  ];
  for (const candidate of candidates) {
    const email = normalizeEmailValue(candidate);
    if (email) return email;
  }
  return '';
}

function pickProfilePhoto(profile) {
  return String(profile?.photos?.[0]?.value || profile?._json?.photo || '').trim();
}

function pickDisplayName(profile, fallbackEmail = '') {
  const candidate = String(
    profile?.displayName ||
    profile?.name?.givenName ||
    (fallbackEmail ? fallbackEmail.split('@')[0] : '') ||
    'Usuario'
  ).trim();
  return (candidate || 'Usuario').slice(0, 80);
}

async function upsertSocialUser({ provider, providerId, email, displayName, photoUrl }) {
  const providerCol = provider === 'google' ? 'google_id' : 'microsoft_id';
  const providerLabel = provider === 'google' ? 'Google' : 'Microsoft';
  const providerIdStr = String(providerId || '').trim();
  const emailNorm = normalizeEmailValue(email);
  const cleanName = String(displayName || (emailNorm ? emailNorm.split('@')[0] : 'Usuario')).trim().slice(0, 80) || 'Usuario';
  const cleanPhoto = String(photoUrl || '').trim();

  if (!providerIdStr) {
    throw new Error(`${providerLabel}: no llegó el identificador de la cuenta.`);
  }
  if (!emailNorm) {
    throw new Error(`${providerLabel}: no se pudo obtener un email válido.`);
  }

  const userByProvider = await get(
    `SELECT ${PASSPORT_USER_COLUMNS}
       FROM users
      WHERE ${providerCol} = ?
      LIMIT 1`,
    [providerIdStr]
  );
    if (userByProvider) {
    const sets = [
      `is_verified = 1`,
      `verification_code = NULL`,
      `terms_accepted_at = COALESCE(NULLIF(terms_accepted_at, ''), datetime('now'))`,
      `privacy_accepted_at = COALESCE(NULLIF(privacy_accepted_at, ''), datetime('now'))`
    ];
    const params = [];

    if (cleanPhoto && !String(userByProvider.avatarUrl || '').trim()) {
      sets.push(`avatarUrl = ?`);
      params.push(cleanPhoto);
      userByProvider.avatarUrl = cleanPhoto;
    }

    params.push(userByProvider.id);
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

    userByProvider.is_verified = 1;
    userByProvider.verification_code = null;
    userByProvider.terms_accepted_at = userByProvider.terms_accepted_at || new Date().toISOString();
    userByProvider.privacy_accepted_at = userByProvider.privacy_accepted_at || new Date().toISOString();

    return buildPassportSessionUser(userByProvider);
  }

  const userByEmail = await get(
    `SELECT ${PASSPORT_USER_COLUMNS}
       FROM users
      WHERE lower(email) = lower(?)
      LIMIT 1`,
    [emailNorm]
  );
    if (userByEmail) {
    const sets = [
      `${providerCol} = ?`,
      `is_verified = 1`,
      `verification_code = NULL`,
      `terms_accepted_at = COALESCE(NULLIF(terms_accepted_at, ''), datetime('now'))`,
      `privacy_accepted_at = COALESCE(NULLIF(privacy_accepted_at, ''), datetime('now'))`
    ];
    const params = [providerIdStr];

    if (cleanPhoto && !String(userByEmail.avatarUrl || '').trim()) {
      sets.push(`avatarUrl = ?`);
      params.push(cleanPhoto);
    }

    params.push(userByEmail.id);
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

    const linkedUser = await get(
      `SELECT ${PASSPORT_USER_COLUMNS}
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [userByEmail.id]
    );
    return buildPassportSessionUser(linkedUser);
  }

  const placeholderHash = await bcrypt.hash(`oauth:${provider}:${providerIdStr}:${emailNorm}`, 10);

  await run(
    `INSERT INTO users (name, surname, email, pass_hash, role, career, plan, avatarUrl, ${providerCol}, career_plan_completed, verification_code, is_verified, created_at)
    VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, 0, NULL, 1, datetime('now'))`,
    [
      cleanName,
      '',
      emailNorm,
      placeholderHash,
      SOCIAL_DEFAULT_CAREER,
      SOCIAL_DEFAULT_PLAN,
      cleanPhoto,
      providerIdStr
    ]
  );

  const createdUser = await get(
    `SELECT ${PASSPORT_USER_COLUMNS}
       FROM users
      WHERE lower(email) = lower(?)
      LIMIT 1`,
    [emailNorm]
  );

  try {
    await sendWelcomeEmail(emailNorm, createdUser?.name || cleanName);
  } catch (mailErr) {
    console.error('Resend send welcome email error (social register):', {
      provider,
      email: emailNorm,
      message: mailErr?.message,
      name: mailErr?.name,
      cause: mailErr?.cause,
      error: mailErr?.error
    });
  }

  return buildPassportSessionUser(createdUser);
}
/* =========================
   Passport (Local)
   ========================= */
passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const emailNorm = String(email || '').trim().toLowerCase();
    const user = await get(
      `SELECT id, name, role, career, plan, email, avatarUrl, instagram_username, is_verified, pass_hash
        , phone
         FROM users
        WHERE email = ?
        LIMIT 1`,
      [emailNorm]
    );
    if (!user) return done(null, false, { message: 'Credenciales inválidas' });
    const ok = await bcrypt.compare(password, user.pass_hash);
    if (!ok) return done(null, false, { message: 'Credenciales inválidas' });
    return done(null, {
      id: user.id,
      name: user.name,
      role: user.role,
      career: user.career,
      plan: user.plan,
      email: user.email,
      phone: user.phone || '',
      avatarUrl: user.avatarUrl || '',
      instagram_username: user.instagram_username || '',
      is_verified: Number(user.is_verified || 0)
    });
  } catch (e) { return done(e); }
}));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = pickGoogleEmail(profile);
      const user = await upsertSocialUser({
        provider: 'google',
        providerId: profile?.id,
        email,
        displayName: pickDisplayName(profile, email),
        photoUrl: pickProfilePhoto(profile)
      });
      return done(null, user);
    } catch (e) {
      return done(e);
    }
  }));
} else {
  console.warn('[auth] Google OAuth deshabilitado: falta GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET');
}

if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
  passport.use(new MicrosoftStrategy({
    clientID: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    callbackURL: MICROSOFT_CALLBACK_URL,
    scope: ['openid', 'profile', 'email', 'user.read'],
    tenant: MICROSOFT_TENANT,
    authorizationURL: `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/authorize`,
    tokenURL: `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`,
    graphApiVersion: 'v1.0',
    addUPNAsEmail: true
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = pickMicrosoftEmail(profile);
      const user = await upsertSocialUser({
        provider: 'microsoft',
        providerId: profile?.id,
        email,
        displayName: pickDisplayName(profile, email),
        photoUrl: pickProfilePhoto(profile)
      });
      return done(null, user);
    } catch (e) {
      return done(e);
    }
  }));
} else {
  console.warn('[auth] Microsoft OAuth deshabilitado: falta MICROSOFT_CLIENT_ID o MICROSOFT_CLIENT_SECRET');
}

passport.serializeUser((user, done) => done(null, {
  id: user.id,
  name: user.name,
  role: user.role,
  career: user.career,
  plan: user.plan,
  email: user.email,
  phone: user.phone || '',
  avatarUrl: user.avatarUrl || '',
  instagram_username: user.instagram_username || ''
}));
passport.deserializeUser(async (sessionUser, done) => {
  try {
    done(null, sessionUser || null);
  } catch (e) {
    done(e);
  }
});
app.use(passport.initialize());
app.use(passport.session());
/* =========================
   Seguridad: máximo 2 dispositivos por cuenta
   (usa Turso: tables sessions + device_sessions)
   ========================= */
const DEVICE_COOKIE_NAME = process.env.DEVICE_COOKIE_NAME || 'facultad.dev';
const DEVICE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;
const DEVICE_CHECK_INTERVAL_MS = 20 * 60 * 1000;        // 20 min
const DEVICE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 horas

function parseCookieHeader(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || '');
  raw.split(';').forEach((p) => {
    const idx = p.indexOf('=');
    if (idx === -1) return;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

async function enforceMaxTwoDevices(req, res, next) {
  try {
    if (!req.user || !req.sessionID) return next();

    const now = Date.now();
    const lastCheck = Number((req.session && req.session.deviceCheckAt) || 0);
    if (lastCheck && (now - lastCheck) < DEVICE_CHECK_INTERVAL_MS) return next();
    if (req.session) req.session.deviceCheckAt = now;

    const cookies = parseCookieHeader(req.headers.cookie);
    let deviceId = cookies[DEVICE_COOKIE_NAME];

    if (!deviceId) {
      deviceId = uuidv4();
      res.cookie(DEVICE_COOKIE_NAME, deviceId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: (process.env.NODE_ENV || '').toLowerCase() === 'production',
        maxAge: DEVICE_COOKIE_MAX_AGE,
        domain: process.env.SESSION_COOKIE_DOM || undefined
      });
    }

    if (req.session) req.session.deviceId = String(deviceId);

    const userId = Number(req.user.id);

    // 1) upsert device_sessions
    await run(
      `
      INSERT INTO device_sessions (user_id, device_id, sid, created_at, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET
        sid=excluded.sid,
        updated_at=excluded.updated_at
      `,
      [userId, String(deviceId), String(req.sessionID), now, now]
    );

    // 2) limpiar mapeos huérfanos (sesión ya no existe) cada varias horas
    const lastCleanup = Number((req.session && req.session.deviceCleanupAt) || 0);
    if (!lastCleanup || (now - lastCleanup) >= DEVICE_CLEANUP_INTERVAL_MS) {
      await run(
        `
        DELETE FROM device_sessions
        WHERE user_id=?
          AND sid NOT IN (SELECT sid FROM sessions)
        `,
        [userId]
      );
      if (req.session) req.session.deviceCleanupAt = now;
    }

    // 3) contar dispositivos activos (sesiones vigentes)
    const activeCountRow = await get(
      `
      SELECT COUNT(DISTINCT ds.device_id) AS qty
      FROM device_sessions ds
      JOIN sessions s ON s.sid = ds.sid
      WHERE ds.user_id = ?
        AND (s.expire IS NULL OR s.expire > ?)
      `,
      [userId, now]
    );

    if (Number((activeCountRow && activeCountRow.qty) || 0) > 2) {
      
      // cerrar TODAS las sesiones
      const sidRows = await all(
        `SELECT sid FROM device_sessions WHERE user_id=?`,
        [userId]
      );
      const sids = (sidRows || []).map(r => String(r.sid || '')).filter(Boolean);

      if (sids.length) {
        const ph = sids.map(() => '?').join(',');
        await run(`DELETE FROM sessions WHERE sid IN (${ph})`, sids);
      }

      await run(`DELETE FROM device_sessions WHERE user_id=?`, [userId]);

      await run(
        `UPDATE users SET multi_device_logout_notice=1, multi_device_logout_at=? WHERE id=?`,
        [now, userId]
      );

      return req.logout(() => {
        return req.session.destroy(() => res.redirect('/login'));
      });
    }

    return next();
  } catch (e) {
    console.error('enforceMaxTwoDevices error:', e);
    return next();
  }
}

app.use(enforceMaxTwoDevices);

// Título por defecto + role
// Título por defecto + role + aviso seguridad (1 vez)
app.use((req, res, next) => {
  if (typeof res.locals.title === 'undefined') res.locals.title = 'Facultad';
  res.locals.userRole = (req.user && req.user.role) || null;

  res.locals.multiDeviceNotice = !!(req.session && req.session.multiDeviceNotice);

  if (req.session && req.session.multiDeviceNotice) {
    delete req.session.multiDeviceNotice;
    try { req.session.save(() => {}); } catch (_) {}
  }

  next();
});

/* =========================
   Helpers auth
   ========================= */
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  // ✅ Invitado: sesión “guest” (sin Passport)
  if (req.session && req.session.user && req.session.user.role === 'guest') return next();
  res.redirect('/login');
}

function guestGate(sectionLabel) {
  return (req, res, next) => {
    const u = (req.user || (req.session && req.session.user) || null);
    if (u && u.role === 'guest') {
      return res.status(200).render('guest-locked', {
        title: 'Acceso restringido',
        section: sectionLabel
      });
    }
    return next();
  };
}
function ensureAdmin(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user.role === 'admin') return next();
  return res.status(403).send('Solo el administrador puede realizar esta acción');
}

/* =========================
   Normalizador de career (autofix)
   ========================= */
const { normalizeCareer } = require('./utils/careers');
const CAREER_PLAN_RULES = {
  'Lic. en Administración de Empresas': [6, 7, 8],
  'Contabilidad': [6, 7],
  'Lic. en Economía': [6, 7]
};

function hasValidCareerPlan(userLike) {
  const career = normalizeCareer(String(userLike?.career || '').trim());
  const allowedPlans = CAREER_PLAN_RULES[career] || [];
  const planNum = parseInt(String(userLike?.plan || '0'), 10);
  return !!career && allowedPlans.includes(planNum);
}
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
  // ✅ Si es invitado, usamos la sesión como fuente de verdad
  if (!req.user && req.session && req.session.user && req.session.user.role === 'guest') {
    req.user = req.session.user;
  }

  // fallback si por alguna razón req.user no está, pero la sesión sí
  res.locals.user = req.user || (req.session && req.session.user) || null;
  res.locals.isGuest = !!(res.locals.user && res.locals.user.role === 'guest');

  if (req.user && req.user.role !== 'guest') {
    req.session.user = req.session.user || {};
    for (const k of ['id','name','email','role','career','plan','avatarUrl','instagram_username','is_verified']) {
      if (req.user[k] !== undefined) req.session.user[k] = req.user[k];
    }
  }
  next();
});

app.use(async (req, res, next) => {
  try {
    if (!req.user || req.user.role === 'guest' || !req.user.id) return next();

    // solo forzamos verificación al entrar a /app
    if (!req.path.startsWith('/app')) return next();

    const dbUser = await get(
      `SELECT is_verified FROM users WHERE id = ? LIMIT 1`,
      [req.user.id]
    );

    const isVerified = Number(dbUser?.is_verified || 0) === 1 ? 1 : 0;

    req.user.is_verified = isVerified;

    if (req.session) {
      req.session.user = req.session.user || {};
      req.session.user.is_verified = isVerified;

      if (req.session.passport && req.session.passport.user) {
        req.session.passport.user.is_verified = isVerified;
      }
    }

    if (!isVerified) {
      return res.redirect('/verificar');
    }

    return next();
  } catch (e) {
    console.error('email verification middleware error:', e);
    return next();
  }
});

app.use(async (req, res, next) => {
  try {
    if (!req.user || req.user.role === 'guest' || !req.user.id) return next();

    // Solo obligamos onboarding dentro de /app
    if (!req.path.startsWith('/app')) return next();

    const dbUser = await get(
      `SELECT career, plan, career_plan_completed FROM users WHERE id = ? LIMIT 1`,
      [req.user.id]
    );
    if (!dbUser) return next();

    const isComplete =
      Number(dbUser.career_plan_completed || 0) === 1 &&
      hasValidCareerPlan(dbUser);

    // sincronizamos user + sesión con DB
    req.user.career = dbUser.career || '';
    req.user.plan = Number(dbUser.plan || 0);
    req.user.career_plan_completed = isComplete ? 1 : 0;

    if (req.session) {
      req.session.user = req.session.user || {};
      req.session.user.career = req.user.career;
      req.session.user.plan = req.user.plan;
      req.session.user.career_plan_completed = req.user.career_plan_completed;

      if (req.session.passport && req.session.passport.user) {
        req.session.passport.user.career = req.user.career;
        req.session.passport.user.plan = req.user.plan;
        req.session.passport.user.career_plan_completed = req.user.career_plan_completed;
      }
    }

    if (!isComplete) {
      return res.redirect('/complete-career-plan');
    }

    return next();
  } catch (e) {
    console.error('career/plan onboarding middleware error:', e);
    return next();
  }
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
const analyticsRoutes     = require('./routes/analytics');
const perfilRoutes = require('./routes/perfil');
const verifyRoutes        = require('./routes/verify'); // Panel admin /verify
const estudioRoutes       = require('./routes/estudio');
const legalRoutes         = require('./routes/legal');
const { ensureLocalMetricsSchema } = require('./lib/localMetricsDb');
const { v4: uuidv4 } = require('uuid');

ensureLocalMetricsSchema().catch((err) => {
  console.error('[localMetrics] init failed:', err?.message || err);
});

app.use(authRoutes({ passport }));
app.use(legalRoutes());
app.use('/api/analytics', analyticsRoutes());
app.get('/api/tutorial/should', (_req, res) => {
  return res.json({ show: false });
});

// ✅ RUTAS ESPECÍFICAS PRIMERO (para que no las "pise" /app)
app.use('/app/perfil', ensureAuth, guestGate('Perfil'), perfilRoutes);
app.use('/estudio', ensureAuth, guestGate('Estudio'), estudioRoutes);
app.use('/app/grupos', ensureAuth, guestGate('Grupos'), groupsRoutes());
app.use('/app/preguntas', ensureAuth, guestGate('Autoevaluación'), require('./routes/preguntas')());

// 🔧 Correlativas se define como "/correlativas" dentro del router y se monta bajo "/app"
app.use('/app', ensureAuth, correlativasRoute);

// Resto de secciones dentro de /app
app.use('/app', ensureAuth, notificationsRoutes({ ensureAdmin }));
app.use('/app', ensureAuth, appRoutes({ ensureAdmin }));

// Admin / uploads / pdf
app.use('/admin',    ensureAdmin, adminRoutes());
app.use('/upload',   ensureAdmin, uploadRoutes());
app.use('/pdf-view', pdfRoutes());

// Panel de verificación (solo admin)
app.use('/verify', ensureAdmin, verifyRoutes()); // Admin-onlyç


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
      const planQ = String(req.query.plan || '').trim(); // ✅ opcional
      const usePlan = !!planQ && planQ !== '0' && planQ.toLowerCase() !== 'null' && planQ.toLowerCase() !== 'undefined';

      if (!subjectId) return res.status(400).json({ error: 'Falta subject_id' });

      const subj = await get(`SELECT name, canonical_key, career FROM subjects WHERE id=?`, [subjectId]);
      if (!subj || !subj.name) return res.json([]);

      // ✅ Si viene plan => mismo criterio que Autoevaluación (materia + plan)
      // ✅ Si NO viene plan => combina todos los planes (como antes)
      let rawQs = [];
      if (usePlan) {
        rawQs = await loadQuestionsDb(subj.name, planQ);
        if (!Array.isArray(rawQs) || rawQs.length === 0) {
          rawQs = loadQuestions(subj.name, planQ);
        }
      } else {
        rawQs = await loadQuestionsAnyPlanDb(subj.name);
        if (!Array.isArray(rawQs) || rawQs.length === 0) {
          rawQs = loadQuestionsAnyPlan(subj.name);
        }
      }

      if (!Array.isArray(rawQs) || rawQs.length === 0) return res.json([]);

      // Mezclar y recortar
      const pool = rawQs.slice().sort(() => Math.random() - 0.5).slice(0, limit);

      // Adaptar formato a { text, options, answer:index } y desordenar opciones
      const payload = pool.map(q => {
        const options = Array.isArray(q.choices) ? q.choices.slice() : [];
        const originalCorrectIdx = options.findIndex(opt => String(opt) === String(q.correct));

        const shuffled = options.map((opt, i) => ({ opt, i })).sort(() => Math.random() - 0.5);
        const newOptions = shuffled.map(x => x.opt);
        let answerIdx = shuffled.findIndex(x => x.i === originalCorrectIdx);

        // ✅ defensa por si viene algo raro
        if (answerIdx < 0) answerIdx = 0;

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
    const startedAt   = verifyUtil.getStartedAt() || 0;
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

/* ==================================================
   Instagram Avatar (público)  GET /instagram-avatar/:username
   ================================================== */
app.get('/instagram-avatar/:username', async (req, res) => {
  try {
    const username = String(req.params.username || '').trim();
    const r = await fetchInstagramAvatar(username);
    res.set('Cache-Control', 'public, max-age=3600');
    return res.json({ username: r.username, avatar: r.avatar });
  } catch (e) {
    const code = e && (e.code || e.name) ? String(e.code || e.name) : 'ERROR';
    const status = Number(e && e.status) || 0;

    if (code === 'INVALID_USERNAME') {
      return res.status(400).json({ error: 'Instagram inválido' });
    }
    if (code === 'NOT_FOUND' || status === 404) {
      return res.status(404).json({ error: 'Usuario inexistente' });
    }
    if (code === 'AbortError' || /timeout/i.test(String(e && e.message || ''))) {
      return res.status(504).json({ error: 'Timeout consultando Instagram' });
    }
    if (code === 'AVATAR_NOT_FOUND') {
      return res.status(502).json({ error: 'No se pudo extraer la foto de perfil' });
    }

    console.error('GET /instagram-avatar/:username error:', e);
    return res.status(502).json({ error: 'No se pudo obtener el avatar' });
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
   Avatar upload (LOCAL por ahora)
   ==================================================
   Nota: En hosting gratuito el disco puede ser efímero.
   Si querés que el avatar sea 100% persistente, lo migramos a R2 igual que documents.
*/
/* ==================================================
   Avatar upload (R2)
   ================================================== */
const R2_PUBLIC_BASE = String(process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '');
const avatarR2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
  }
});

function safeAvatarName(originalname) {
  return String(originalname || 'avatar').replace(/[^\w.\- ()áéíóúñÁÉÍÓÚ]/g, '_');
}

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Solo imágenes'))
});

app.post('/profile/avatar', ensureAuth, (req, res) => {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err || !req.file) {
      console.error(err);
      return res.redirect('back');
    }

    try {
      if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE) {
        console.error('Falta configurar R2 para avatar');
        return res.redirect('back');
      }

      const uid = Number((req.user && req.user.id) || 0);
      const key = `avatars/u${uid || Date.now()}-${Date.now()}-${safeAvatarName(req.file.originalname || 'avatar.jpg')}`;

      await avatarR2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'application/octet-stream',
        CacheControl: 'public, max-age=31536000, immutable'
      }));

      const rel = `${R2_PUBLIC_BASE}/${key}`;

      if (req.user) req.user.avatarUrl = rel;
      if (req.session.user) req.session.user.avatarUrl = rel;

      if (uid) {
        await run(`UPDATE users SET avatarUrl = ? WHERE id = ?`, [rel, uid]);
      }

      res.redirect('back');
    } catch (e) {
      console.error('avatar upload error:', e);
      return res.redirect('back');
    }
  });
});

/* ==================================================
   BORRADO SEGURO DE SUBJECTS
   ==================================================
   Con R2, los documentos ya no están en disco local, por lo que el "unlink" local
   se intenta SOLO si la ruta parece local. Si es una URL o key tipo "docs/..", se ignora.
*/

// helper: intentar borrar un path absoluto, ignorando ENOENT
async function safeUnlink(absPath) {
  try { await fsp.unlink(absPath); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('unlink error:', e.message); }
}

// normaliza rutas almacenadas (relativas) a candidatas absolutas
function candidatesFromRel(rel) {
  const v = String(rel || '').trim();
  if (!v) return [];
  if (/^https?:\/\//i.test(v)) return [];     // URL pública (R2/externo)
  if (!v.includes('/') && !v.includes('\\')) return []; // probablemente key o dato raro

  // si viene tipo "docs/categoria/...." (key R2), no es un archivo local
  if (/^docs\//i.test(v)) return [];

  const clean = v.replace(/^(\.\/|\/)/, '');
  if (!clean) return [];
  return [
    path.resolve(__dirname, clean),
    path.resolve(__dirname, 'public', clean),
  ];
}

// recoge posibles archivos desde el row (flexible con distintos esquemas)
function collectFileRels(doc) {
  const outs = [];
  for (const k of ['file', 'filepath', 'file_path', 'path', 'local_path', 'rel_path', 'filename']) {
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
          else if (typeof it === 'object') outs.push(it.path || it.file || it.rel || it.url || it.filename || '');
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

    // 1) borrar archivos declarados en el propio subject (solo si son locales)
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
