// routes/perfil.js
const express = require('express');
const router = express.Router();
const { run, get, all } = require('../models/db');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { normalizeCareer } = require('../utils/careers');

// Parse body (por si llega JSON o form)
router.use(express.json({ limit: '3mb' }));
router.use(express.urlencoded({ extended: false, limit: '3mb' }));

// Guard simple (no rompe si no tenés middleware compartido)
function requireAuth(req, res, next){
  try{
    if (req.isAuthenticated && req.isAuthenticated()) return next();
  }catch(_){ }
  return res.redirect('/login');
}

// Helper: arma un “id” estable para comparar usuario actual vs perfil visto
function uidOf(u){
  return String((u && (u.id || u._id || u.email)) || '');
}

function toInt(v, fallback = 0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toStr(v, fallback = ''){
  if (v === undefined || v === null) return fallback;
  return String(v);
}
function clampText(s, maxLen){
  const t = toStr(s, '').replace(/\r\n/g, '\n');
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen);
}
function parseCareerCsv(v){
  return String(v || '')
    .split(',')
    .map(s => normalizeCareer(String(s || '').trim()))
    .filter(Boolean);
}
function sanitizeTimeHM(v){
  const s = String(v || '').trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(s) ? s : '';
}

function isYMD(s){
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function clampRangeYMD(a, b){
  const aa = String(a || '').slice(0,10);
  const bb = String(b || '').slice(0,10);
  if (!isYMD(aa) || !isYMD(bb)) return { from: aa, to: bb };
  return (aa <= bb) ? { from: aa, to: bb } : { from: bb, to: aa };
}
function sanitizeRepeat(rep){
  const r = (rep && typeof rep === 'object') ? rep : {};
  const mode = String(r.mode || 'none').toLowerCase();

  if (mode === 'weekly'){
    const dows = Array.isArray(r.dows) ? r.dows.map(Number).filter(n => [0,1,2,3,4,5,6].includes(n)) : [];
    return dows.length ? { mode:'weekly', dows:Array.from(new Set(dows)).sort((a,b)=>a-b), dom:[] } : { mode:'none', dows:[], dom:[] };
  }

  if (mode === 'monthly'){
    const dom = Array.isArray(r.dom) ? r.dom.map(Number).filter(n => n>=1 && n<=31) : [];
    return dom.length ? { mode:'monthly', dows:[], dom:Array.from(new Set(dom)).sort((a,b)=>a-b) } : { mode:'none', dows:[], dom:[] };
  }

  return { mode:'none', dows:[], dom:[] };
}

function parseRepeatJson(s){
  const raw = String(s || '').trim();
  if (!raw) return { mode:'none', dows:[], dom:[] };
  try{
    return sanitizeRepeat(JSON.parse(raw));
  }catch(_){
    return { mode:'none', dows:[], dom:[] };
  }
}

function slugifyUsername(input){
  const s = String(input || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

function wordCount(s){
  const t = toStr(s, '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}
// libsql suele devolver lastInsertRowid como BigInt -> convertir a Number seguro
function pickLastId(rs){
  const raw = (rs && (rs.lastInsertRowid ?? rs.lastID ?? rs.lastId ?? rs.last_insert_rowid)) ?? null;
  try{
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }catch(_){ }
  return 0;
}
function pickCountRow(row){
  if (!row) return 0;
  const v = (row.c ?? row.C ?? row.count ?? row.COUNT ?? row.n ?? row.N);
  return toInt(v, 0);
}

// =========================
// ✅ Perfil schema (auto, sin depender de db.js)
// - users.bio
// - follows
// - profile_posts
// =========================
let __profileSchemaStarted = false;
let __profileSchemaPromise = null;
function ensureProfileSchema(){
  if (__profileSchemaStarted) return __profileSchemaPromise;
  __profileSchemaStarted = true;
  __profileSchemaPromise = (async () => {
    // users.bio
    try{
      await run(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
    }catch(_){ }

    // users.username (para URLs /app/perfil/:username)
    try{
      await run(`ALTER TABLE users ADD COLUMN social_links TEXT DEFAULT ''`);
    }catch(_){ }

    try{ await run(`ALTER TABLE users ADD COLUMN affinity_approved_subject_ids TEXT DEFAULT '[]'`); }catch(_){ }
    try{ await run(`ALTER TABLE users ADD COLUMN affinity_current_subject_ids TEXT DEFAULT '[]'`); }catch(_){ }
    try{ await run(`ALTER TABLE users ADD COLUMN affinity_interests_json TEXT DEFAULT '{}'`); }catch(_){ }
    try{ await run(`ALTER TABLE users ADD COLUMN affinity_completed_at TEXT DEFAULT NULL`); }catch(_){ }

    // username único solo si no está vacío
    try{ await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username <> ''`); }catch(_){ }

    // follows
    try{
      await run(`
        CREATE TABLE IF NOT EXISTS follows (
          follower_id INTEGER NOT NULL,
          following_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(follower_id, following_id),
          FOREIGN KEY(follower_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(following_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
    }catch(_){ }

    try{ await run(`CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id)`); }catch(_){ }
    try{ await run(`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id)`); }catch(_){ }

    // profile_posts
    try{
      await run(`
        CREATE TABLE IF NOT EXISTS profile_posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          author_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          tags_json TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          deleted INTEGER DEFAULT 0,
          FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
    }catch(_){ }

    // profile_posts.tags_json (si venías de esquema viejo)
    try{ await run(`ALTER TABLE profile_posts ADD COLUMN tags_json TEXT DEFAULT ''`); }catch(_){ }

    try{ await run(`CREATE INDEX IF NOT EXISTS idx_profile_posts_author  ON profile_posts(author_id)`); }catch(_){ }
    try{ await run(`CREATE INDEX IF NOT EXISTS idx_profile_posts_created ON profile_posts(created_at)`); }catch(_){ }

    // post_likes
    try{
      await run(`
        CREATE TABLE IF NOT EXISTS post_likes (
          post_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(post_id, user_id),
          FOREIGN KEY(post_id) REFERENCES profile_posts(id) ON DELETE CASCADE,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
    }catch(_){ }
    try{ await run(`CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id)`); }catch(_){ }
    try{ await run(`CREATE INDEX IF NOT EXISTS idx_post_likes_user ON post_likes(user_id)`); }catch(_){ }

    // agenda_events
    try{
      await run(`
        CREATE TABLE IF NOT EXISTS agenda_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_id INTEGER NOT NULL,
          title TEXT DEFAULT '',
          text TEXT DEFAULT '',
          time_hm TEXT DEFAULT '',
          color TEXT DEFAULT '#22c55e',
          repeat_json TEXT DEFAULT '',
          is_global INTEGER DEFAULT 0,
          careers TEXT DEFAULT '',
          from_ymd TEXT NOT NULL,
          to_ymd TEXT NOT NULL,
          important INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          deleted INTEGER DEFAULT 0,
          FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
    }catch(_){ }
    try{ await run(`ALTER TABLE agenda_events ADD COLUMN repeat_json TEXT DEFAULT ''`); }catch(_){ }
    try{ await run(`ALTER TABLE agenda_events ADD COLUMN time_hm TEXT DEFAULT ''`); }catch(_){ }
    try{ await run(`ALTER TABLE agenda_events ADD COLUMN is_global INTEGER DEFAULT 0`); }catch(_){ }
    try{ await run(`ALTER TABLE agenda_events ADD COLUMN careers TEXT DEFAULT ''`); }catch(_){ }
    try{ await run(`ALTER TABLE agenda_events ADD COLUMN source_kind TEXT DEFAULT ''`); }catch(_){ }
    try{ await run(`CREATE INDEX IF NOT EXISTS idx_agenda_owner ON agenda_events(owner_id)`); }catch(_){ }
    try{ await run(`CREATE INDEX IF NOT EXISTS idx_agenda_range ON agenda_events(from_ymd, to_ymd)`); }catch(_){ }
    try{ await run(`CREATE INDEX IF NOT EXISTS idx_agenda_global ON agenda_events(is_global, careers)`); }catch(_){ }

    // Backfill username (una vez): si está vacío, generamos uno estable
    try{
      const missing = await all(`SELECT id, name, username FROM users WHERE COALESCE(username,'') = ''`);
      for (const r of (missing || [])){
        const id = toInt(r.id, 0);
        if (!id) continue;
        const name = toStr(r.name, '').trim();
        const base = slugifyUsername(name) || 'usuario';
        let candidate = base;

        // si existe en otro, usar sufijo -id
        try{
          const ex = await get(`SELECT id FROM users WHERE username = ? LIMIT 1`, [candidate]);
          if (ex && toInt(ex.id, 0) !== id) candidate = `${base}-${id}`;
        }catch(_){ }

        // último fallback
        for (let i=0;i<5;i++){
          try{
            const ex2 = await get(`SELECT id FROM users WHERE username = ? LIMIT 1`, [candidate]);
            if (!ex2 || toInt(ex2.id, 0) === id) break;
          }catch(_){ break; }
          candidate = `${base}-${id}-${i+1}`;
        }

        try{ await run(`UPDATE users SET username = ? WHERE id = ?`, [String(candidate || '').toLowerCase(), id]); }catch(_){ }
      }
    }catch(_){ }
  })();
  return __profileSchemaPromise;
}
async function resolveUserRowByUid(uid){
  const u = toStr(uid, '').trim();
  if (!u) return null;
  try{
    const row = await get(
      `SELECT * FROM users
       WHERE id = ? OR email = ? OR lower(username) = lower(?)
       LIMIT 1`,
      [u, u, u]
    );
    return row || null;
  }catch(_){
    return null;
  }
}
async function resolveNumericUserIdFromReqUser(reqUser){
  if (!reqUser) return 0;
  const id = reqUser.id ?? reqUser._id;
  if (id !== undefined && id !== null && String(id).trim() !== ''){
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const email = toStr(reqUser.email, '').trim();
  if (!email) return 0;
  const row = await resolveUserRowByUid(email);
  return row ? toInt(row.id, 0) : 0;
}
async function resolveNumericUserId(uid){
  const row = await resolveUserRowByUid(uid);
  return row ? toInt(row.id, 0) : 0;
}

async function calcFollowStats(userId){
  const uid = toInt(userId, 0);
  if (!uid) return { followers: 0, following: 0 };

  try{
    const a = await get(`SELECT COUNT(*) AS c FROM follows WHERE following_id = ?`, [uid]);
    const b = await get(`SELECT COUNT(*) AS c FROM follows WHERE follower_id  = ?`, [uid]);
    return {
      followers: pickCountRow(a),
      following: pickCountRow(b)
    };
  }catch(_){
    return { followers: 0, following: 0 };
  }
}

async function calcApprovedCount(userIdOrUid){
  const key = toStr(userIdOrUid, '').trim();
  if (!key) return 0;

  // Intentamos múltiples tablas posibles (sin romper)
  const tryQueries = [
    [`SELECT COUNT(*) AS c FROM correlatives_status WHERE user_id = ? AND done = 1`, [key]],
    [`SELECT COUNT(*) AS c FROM correlatives_status WHERE user_id = ? AND checked = 1`, [key]],
    [`SELECT COUNT(*) AS c FROM subjects_done WHERE user_id = ? AND done = 1`, [key]],
    [`SELECT COUNT(*) AS c FROM subject_status WHERE user_id = ? AND done = 1`, [key]],
  ];

  for (const [sql, params] of tryQueries){
    try{
      const row = await get(sql, params);
      if (row && (row.c !== undefined || row.C !== undefined)){
        return pickCountRow(row);
      }
    }catch(_){ }
  }

  return 0;
}

async function listUsersLight(){
  try{
    const rows = await all(
      `SELECT id, username, name, career, plan, avatarUrl FROM users ORDER BY name COLLATE NOCASE LIMIT 600`
    );
    return Array.isArray(rows) ? rows : [];
  }catch(_){
    return [];
  }
}

async function listSubjectsLight(career, plan){
  try{
    const c = toStr(career, '').trim();
    const p = toInt(plan, 0) || 0;

    if (c && p){
      return await all(
        `SELECT id, COALESCE(name, subject_name) AS name FROM subjects WHERE career = ? AND plan = ? ORDER BY COALESCE(name, subject_name) COLLATE NOCASE`,
        [c, p]
      );
    }

    if (c){
      return await all(
        `SELECT id, COALESCE(name, subject_name) AS name FROM subjects WHERE career = ? ORDER BY COALESCE(name, subject_name) COLLATE NOCASE`,
        [c]
      );
    }

    return await all(
      `SELECT id, COALESCE(name, subject_name) AS name FROM subjects ORDER BY COALESCE(name, subject_name) COLLATE NOCASE LIMIT 800`
    );
  }catch(_){
    return [];
  }
}
async function listProfessorsLight(career, plan){
  try{
    const c = toStr(career, '').trim();
    const p = toInt(plan, 0) || 0;

    const where = [];
    const params = [];

    if (c){ where.push('career = ?'); params.push(c); }
    if (p){ where.push('plan = ?'); params.push(p); }

    const sql =
      `SELECT id, name, photo_url, subjects_text, career, plan
       FROM professors
       ${where.length ? ('WHERE ' + where.join(' AND ')) : ''}
       ORDER BY name COLLATE NOCASE
       LIMIT 800`;

    const rows = where.length ? await all(sql, params) : await all(sql);
    return Array.isArray(rows) ? rows : [];
  }catch(_){
    return [];
  }
}
async function listRandomUsers(max = 7, excludeId = 0){
  try{
    const ex = toInt(excludeId, 0);
    if (ex){
      const rows = await all(
        `SELECT id, username, name, avatarUrl
         FROM users
         WHERE id != ?
         ORDER BY RANDOM()
         LIMIT ?`,
        [ex, toInt(max, 7)]
      );
      return Array.isArray(rows) ? rows : [];
    }

    const rows = await all(
      `SELECT id, username, name, avatarUrl
       FROM users
       ORDER BY RANDOM()
       LIMIT ?`,
      [toInt(max, 7)]
    );
    return Array.isArray(rows) ? rows : [];
  }catch(_){
    return [];
  }
}


function parseJsonArray(raw){
  try{
    const arr = JSON.parse(String(raw || '[]'));
    return Array.isArray(arr) ? arr : [];
  }catch(_){
    return [];
  }
}

function parseJsonObject(raw){
  try{
    const obj = JSON.parse(String(raw || '{}'));
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  }catch(_){
    return {};
  }
}

function uniqIntArray(arr){
  return Array.from(new Set((Array.isArray(arr) ? arr : []).map(v => toInt(v, 0)).filter(Boolean)));
}

function normalizeAffinityInterests(input, questions){
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const out = {};

  for (const q of (questions || [])){
    const key = String(q.id || '').trim();
    if (!key || !Array.isArray(q.options)) continue;

    if (q.multiple){
      const list = Array.isArray(src[key]) ? src[key] : [src[key]];
      const values = Array.from(new Set(
        list
          .map((value) => toStr(value, '').trim())
          .filter((value) => value && q.options.includes(value))
      ));
      if (values.length) out[key] = values;
      continue;
    }

    const value = toStr(src[key], '').trim();
    if (value && q.options.includes(value)){
      out[key] = value;
    }
  }

  return out;
}

function isAffinityAnswerFilled(question, value){
  if (!question) return false;
  if (question.multiple){
    return Array.isArray(value) && value.length > 0;
  }
  return !!toStr(value, '').trim();
}

function affinityArray(value){
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => toStr(item, '').trim()).filter(Boolean)))
    : [];
}

function countAffinityInterestMatches(question, mine, theirs){
  if (!question) return 0;
  if (question.multiple){
    const mineSet = new Set(affinityArray(mine));
    let matches = 0;
    for (const value of affinityArray(theirs)){
      if (mineSet.has(value)) matches += 1;
    }
    return matches;
  }
  const mineValue = toStr(mine, '').trim();
  const theirValue = toStr(theirs, '').trim();
  return (mineValue && theirValue && mineValue === theirValue) ? 1 : 0;
}

function buildAffinityQuestions(){
  return [
    { id:'ubicacion', section:'Perfil base', label:'Ubicación', question:'¿En qué zona vivís?', options:['La Plata Centro', 'Berisso', 'Ensenada', 'Afueras'] },
    { id:'cafeterias', section:'Perfil base', label:'Cafeterías', multiple:true, question:'¿A qué tipo de cafeterías solés ir?', options:['Starbucks', 'Café de barrio', 'Martínez', 'Tienda de Café', 'Cafecito aesthetic / especialidad', 'No voy a cafeterías'] },
    { id:'deportes', section:'Perfil base', label:'Deportes', multiple:true, question:'¿Qué deportes seguís?', options:['Fútbol', 'Fórmula 1', 'Básquet', 'Tenis', 'Rugby', 'Vóley', 'UFC / Boxeo', 'No sigo deportes'] },
    { id:'gaming', section:'Perfil base', label:'Gaming', multiple:true, question:'¿A qué jugás más seguido?', options:['Fortnite', 'Minecraft', 'LoL', 'CS:GO / CS2', 'FIFA / FC24', 'Valorant', 'Juegos de historia', 'No juego'] },
    { id:'creadores', section:'Perfil base', label:'Creadores', multiple:true, question:'¿Qué youtubers / streamers / creadores seguís?', options:['Martín Cirio', 'Vegetta777', 'Ibai', 'Luquitas Rodriguez', 'Coscu', 'Momo', 'Nati Jota', 'Nicolas de Tracy', 'Davo Xeneize', 'AuronPlay', 'IlloJuan', 'Ninguno / no miro'] },
    { id:'musica_general', section:'Perfil base', label:'Música', multiple:true, question:'¿Qué música solés escuchar?', options:['Pop argentino', 'Trap / RKT', 'Techno / House', 'Indie / Rock nacional', 'Reggaetón', 'Cuarteto / Cachengue', 'Música en inglés / Pop internacional', 'Rock internacional', 'No escucho mucha música'] },
    { id:'chismes', section:'Perfil base', label:'Cultura pop', question:'¿Qué tanto te interesan las polémicas o el bardo de famosos?', options:['Mucho', 'Solo si me aparece en redes', 'Poco', 'Nada'] },
    { id:'media', section:'Perfil base', label:'Reality / TV', question:'¿Viste o ves programas tipo Gran Hermano?', options:['Fanático/a', 'A veces', 'Solo clips / memes', 'No me interesa'] },
    { id:'estudio', section:'Perfil base', label:'Estudio', multiple:true, question:'¿Cómo preferís estudiar?', options:['En silencio total', 'Con música', 'En grupo charlando', 'En una cafetería', 'Con auriculares / ruido blanco'] },

    { id:'solo_casa_comida', section:'Sección A · Elección múltiple', label:'Comida', multiple:true, question:'¿Qué se pide o se come cuando estás solo/a en casa y no hay ganas de cocinar?', options:["McDonald's, Burger King o Mostaza (la vieja confiable).", 'PedidosYa de la rotisería del barrio (milanesa o tortilla).', 'Sushi o ensalada de un lugar aesthetic de la zona.', 'Empanadas (siempre de los mismos 3 gustos).', 'Mate con lo que haya en la heladera y fue.'] },
    { id:'planes_amigos', section:'Sección A · Elección múltiple', label:'Planes', multiple:true, question:'¿Qué planes con amigos son los que más te representan hoy?', options:['Ir al Lollapalooza o a cualquier festival masivo (Primavera Sound, etc).', 'Cervecería artesanal en la 44 o por el centro.', 'Juntada en una casa con juegos de mesa, cartas o Play.', 'Boliche o fiesta tipo Bresh / Polenta para bailar.', 'Ir a ver una banda de la ciudad a un centro cultural.'] },
    { id:'musica_radar', section:'Sección A · Elección múltiple', label:'Radar musical', multiple:true, question:'Si hablamos de música y tendencias, ¿qué solés tener en el radar?', options:['Todo lo que sacan Emilia, Tini o María Becerra.', 'Trap y RKT (Duki, L-Gante, La Joaqui).', 'Techno, house y salidas a fechas de DJs.', 'Indie platense o rock nacional de siempre.', 'El Top 50 de Argentina en Spotify.', 'Pop / rock en inglés.', 'Bandas sonoras, Lo-fi o música tranqui para estudiar.'] },
    { id:'bardo_famosos', section:'Sección B · Opción única', label:'Redes / Bardo', question:'¿Cómo te llevás con el bardo de los famosos en redes (ej. China Suárez, Colapinto, etc.)?', options:['Me sé todo el lore, sigo cuentas de chismes y lo comento con alguien.', 'Me entero por los memes que me cruzo, pero no busco la info.', 'Me da un poco de cringe pero termino mirando los hilos de Twitter.', 'Cero, vivo en un termo y no sé quién es quién.'] },
    { id:'domingo_lp', section:'Sección B · Opción única', label:'Domingo', question:'Domingo a la tarde en La Plata, ¿cuál es el plan imbatible?', options:['Mates en el Bosque, Plaza Moreno o Plaza Malvinas.', 'Quedarme scrolleando TikTok en la cama hasta que se haga lunes.', 'Ir a merendar a un cafecito moderno con pastelería premium.', 'Ver el partido de mi equipo o ir a la cancha.'] },
    { id:'aesthetic_estilo', section:'Sección B · Opción única', label:'Estilo', question:'¿Qué tan importante es para vos que la otra persona sea aesthetic o tenga onda al vestirse?', options:['Fundamental, me importa que cuide su estética y sus fotos.', 'Me gusta que tenga onda, pero prefiero algo más perfil bajo (normcore).', 'No me fijo en eso, mientras nos llevemos bien está todo ok.'] },
    { id:'red_cabecera', section:'Sección B · Opción única', label:'Red social', question:'¿Cuál es tu red social de cabecera?', options:['TikTok: el algoritmo me conoce más que mi familia.', 'Instagram: vivo mirando historias y mandando memes por DM.', 'Twitter (X): amo el bardo, las noticias y el humor ácido.', 'YouTube: me clavo videos largos de cualquier cosa.'] },
    { id:'salida_bar', section:'Sección B · Opción única', label:'Bar / Boliche', question:'Si vas a un boliche o a un bar, ¿qué es lo primero que pedís?', options:['Fernet con Coca (el clásico que no falla).', 'Gin Tonic con mucho berry, pepino o especias.', 'Cerveza tirada (la que esté en promo).', 'Vodka con energizante o Campari.', 'Agua.', 'Ninguna de las anteriores.'] },
    { id:'stream_cultura', section:'Sección B · Opción única', label:'Streaming', question:'¿Qué opinás de los streamers o la cultura del stream (Coscu, Luquitas Rodriguez, etc.)?', options:['Los veo siempre, uso sus palabras y me sé las referencias.', 'Veo los clips que suben a redes, pero no miro el vivo.', 'No entiendo mucho la gracia.', 'No miro streamers.'] },

    { id:'kit_supervivencia', section:'Sección A · Elección múltiple', label:'Cursada / Laburo', multiple:true, question:'El kit de supervivencia para la cursada (o el laburo): ¿Qué no te puede faltar?', options:['El termo y el mate (compañeros de trinchera).', 'Los auriculares (para ignorar al mundo en el micro).', 'Mis amigos/as (sin ellos no se llega al final del cuatrimestre).', 'El cargador del celu (siempre buscando un enchufe cerca).', 'El resaltador flúo y las hojas para anotar todo.'] },
    { id:'plaza_logistica', section:'Sección A · Elección múltiple', label:'Plaza', multiple:true, question:'Domingo de sol en La Plata: ¿Cómo es la logística de la plaza?', options:['Lona en el pasto (nada de sentarse en el banco).', 'Música de fondo (parlantito o el celu bajito).', 'Facturas, bizcochitos de grasa o churros.', 'El perro de alguien que se suma al grupo.', 'Quedarse hasta que baje el sol y refresque.'] },
    { id:'persona_primera_impresion', section:'Sección A · Elección múltiple', label:'Primera impresión', multiple:true, question:'¿Qué cosas te compran de una persona cuando recién la conocés?', options:['Que tenga buen humor y se ría de mis pavadas.', 'Que escuche la misma música que yo.', 'Que sea puntual (o que me avise si llega tarde).', 'Que me mande memes sin que yo se los pida.', 'Que sepa cebar un buen mate.'] },
    { id:'mate_grieta', section:'Sección B · Opción única', label:'Mate', question:'La gran grieta nacional: ¿Cómo se toma el mate?', options:['Amargo siempre (el que sabe, sabe).', 'Con azúcar o edulcorante.', 'Con yuyitos (burrito, menta, peperina).', 'No tomo mate, soy team café o té.'] },
    { id:'mate_compartido', section:'Sección B · Opción única', label:'Compartir', question:'Protocolo de higiene post-pandemia: ¿Se comparte o no se comparte?', options:['Team el mate se comparte: es un ritual social, no se discute.', 'Team cada uno con el suyo: me acostumbré a mi mate y no lo largo.', 'Depende la confianza: si somos amigos comparto, si no, paso.'] },
    { id:'rendis_mas', section:'Sección B · Opción única', label:'Estudiar / Trabajar', question:'Si hay que estudiar o trabajar fuerte: ¿Dónde rendís más?', options:['En el silencio total de una biblioteca o mi pieza.', 'En un café con ruido de fondo y gente pasando.', 'En grupo, explicando y que me expliquen.'] },
    { id:'olvido_termo', section:'Sección B · Opción única', label:'Olvidos', question:'¿Qué hacés si llegás a la plaza y te olvidaste la yerba o el agua caliente?', options:['Camino 10 cuadras hasta encontrar un kiosco abierto.', 'Le pido a algún grupo de al lado (caradurez nivel 100).', 'Me resigno y tomo una gaseosa o agua.'] },
    { id:'salida_grupal', section:'Sección B · Opción única', label:'Rol social', question:'En una salida grupal, ¿quién sos vos?', options:['El que organiza todo y manda la ubicación por WhatsApp.', 'El que confirma a último momento pero después le pone toda la onda.', 'El que propone ir a comer algo pero nunca sabe a dónde.', 'El que saca las fotos y los videos para las historias.'] },
    { id:'whatsapp_visto', section:'Sección B · Opción única', label:'WhatsApp', question:'¿Cómo manejás el visto en WhatsApp?', options:['Lo tengo activado, respondo al toque o cuando puedo.', 'Lo tengo sacado, contesto cuando el destino lo decida.', 'Cuelgo horas pero porque me olvido el celu en cualquier lado.'] }
  ];
}

function affinityQuestionSimilarity(question, mine, theirs){
  if (!question) return 0;
  if (question.multiple){
    const mineArr = affinityArray(mine);
    const theirArr = affinityArray(theirs);
    if (!mineArr.length || !theirArr.length) return 0;
    const mineSet = new Set(mineArr);
    let overlap = 0;
    for (const value of theirArr){
      if (mineSet.has(value)) overlap += 1;
    }
    return overlap / Math.max(mineArr.length, theirArr.length, 1);
  }
  const mineValue = toStr(mine, '').trim();
  const theirValue = toStr(theirs, '').trim();
  return (mineValue && theirValue && mineValue === theirValue) ? 1 : 0;
}

async function listCareerPlanSubjects(career, plan){
  const c = normalizeCareer(toStr(career, '').trim()) || '';
  const p = toInt(plan, 0) || 0;
  if (!c || !p) return [];

  try{
    const rows = await all(
      `SELECT id,
              COALESCE(NULLIF(subject_name,''), NULLIF(name,''), 'Materia') AS name,
              COALESCE(year, 0) AS year,
              COALESCE(semester, 0) AS semester,
              COALESCE(canonical_key, '') AS canonical_key
       FROM subjects
       WHERE career = ? AND plan = ?
       ORDER BY COALESCE(year, 999) ASC, COALESCE(semester, 999) ASC, COALESCE(NULLIF(subject_name,''), NULLIF(name,''), 'Materia') COLLATE NOCASE`,
      [c, p]
    );
    return Array.isArray(rows) ? rows : [];
  }catch(_){
    return [];
  }
}

async function syncAffinityApprovedChecks(userId, subjects, approvedIds){
  const uid = toInt(userId, 0);
  if (!uid) return;

  const allSubjectIds = uniqIntArray((subjects || []).map(s => s.id));
  const approved = new Set(uniqIntArray(approvedIds));
  if (!allSubjectIds.length) return;

  try{
    for (const subjectId of allSubjectIds){
      await run(
        `INSERT INTO user_subject_checks (user_id, subject_id, done, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, subject_id) DO UPDATE SET
           done = excluded.done,
           updated_at = excluded.updated_at`,
        [uid, subjectId, approved.has(subjectId) ? 1 : 0]
      );
    }
  }catch(e){
    console.warn('syncAffinityApprovedChecks failed:', e?.message || e);
  }
}

async function getAffinityStateForUser(userId, career, plan){
  const uid = toInt(userId, 0);
  const questions = buildAffinityQuestions();
  const subjects = await listCareerPlanSubjects(career, plan);
  const validSubjectIds = new Set((subjects || []).map(s => toInt(s.id, 0)).filter(Boolean));

  let row = null;
  try{
    row = await get(
      `SELECT affinity_approved_subject_ids, affinity_current_subject_ids, affinity_interests_json, affinity_completed_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [uid]
    );
  }catch(_){
    row = null;
  }

  let approved = uniqIntArray(parseJsonArray(row?.affinity_approved_subject_ids)).filter(id => validSubjectIds.has(id));

  if (!approved.length && validSubjectIds.size){
    try{
      const checks = await all(
        `SELECT subject_id
         FROM user_subject_checks
         WHERE user_id = ? AND done = 1`,
        [uid]
      );
      approved = uniqIntArray((checks || []).map(r => r.subject_id)).filter(id => validSubjectIds.has(id));
    }catch(_){
      approved = [];
    }
  }

  const approvedSet = new Set(approved);
  const current = uniqIntArray(parseJsonArray(row?.affinity_current_subject_ids))
    .filter(id => validSubjectIds.has(id))
    .filter(id => !approvedSet.has(id));

  const interests = normalizeAffinityInterests(parseJsonObject(row?.affinity_interests_json), questions);
  const requiredAnswered = questions.every((q) => isAffinityAnswerFilled(q, interests[q.id]));
  const completed = !!(row?.affinity_completed_at && subjects.length && requiredAnswered);

  return {
    completed,
    completedAt: toStr(row?.affinity_completed_at, ''),
    questions,
    subjects: (subjects || []).map(s => ({
      id: toInt(s.id, 0),
      name: toStr(s.name, 'Materia'),
      year: toInt(s.year, 0),
      semester: toInt(s.semester, 0),
      canonical_key: toStr(s.canonical_key, '')
    })),
    answers: {
      approvedSubjectIds: approved,
      currentSubjectIds: current,
      interests
    }
  };
}

function computeAffinitySuggestionList(meState, candidateRows){
  const myApproved = new Set(uniqIntArray(meState?.answers?.approvedSubjectIds));
  const myCurrent = new Set(uniqIntArray(meState?.answers?.currentSubjectIds));
  const mySubjectSet = new Set([...myApproved, ...myCurrent]);
  const myInterests = (meState?.answers?.interests && typeof meState.answers.interests === 'object')
    ? meState.answers.interests
    : {};

  const questions = Array.isArray(meState?.questions) ? meState.questions : [];

  return (candidateRows || []).map((row) => {
    const candidateApproved = new Set(uniqIntArray(parseJsonArray(row.affinity_approved_subject_ids)));
    const candidateCurrent = new Set(uniqIntArray(parseJsonArray(row.affinity_current_subject_ids)));
    const candidateSubjectSet = new Set([...candidateApproved, ...candidateCurrent]);
    const candidateInterests = parseJsonObject(row.affinity_interests_json);

    let approvedMatches = 0;
    let currentMatches = 0;
    let subjectMatches = 0;
    let sharedCurrentCount = 0;

    myApproved.forEach((id) => {
      if (candidateApproved.has(id)) approvedMatches += 1;
    });

    myCurrent.forEach((id) => {
      if (candidateCurrent.has(id)) {
        currentMatches += 1;
        sharedCurrentCount += 1;
      }
    });

    mySubjectSet.forEach((id) => {
      if (candidateSubjectSet.has(id)) subjectMatches += 1;
    });

    let interestPoints = 0;
    let interestMaxPoints = 0;
    for (const q of questions){
      const key = String(q.id || '');
      if (!key) continue;
      interestMaxPoints += 1;
      interestPoints += affinityQuestionSimilarity(q, myInterests[key], candidateInterests[key]);
    }

    const interestPercent = interestMaxPoints ? Math.round((interestPoints / interestMaxPoints) * 100) : 0;
    const subjectPercent = mySubjectSet.size ? Math.round((subjectMatches / mySubjectSet.size) * 100) : 0;
    const passesThreshold = interestPercent >= 65 && subjectPercent >= 80 && sharedCurrentCount >= 1;
    const score = (interestPercent * 1000) + (subjectPercent * 100) + (sharedCurrentCount * 10) + approvedMatches + currentMatches;

    return {
      id: toInt(row.id, 0),
      username: toStr(row.username, ''),
      name: toStr(row.name, 'Usuario'),
      career: toStr(row.career, ''),
      plan: toInt(row.plan, 0) || toStr(row.plan, ''),
      avatarUrl: toStr(row.avatarUrl, ''),
      approvedMatches,
      currentMatches,
      subjectMatches,
      sharedCurrentCount,
      interestPercent,
      subjectPercent,
      passesThreshold,
      score
    };
  })
  .filter(item => item.passesThreshold)
  .sort((a, b) =>
    (b.interestPercent - a.interestPercent) ||
    (b.subjectPercent - a.subjectPercent) ||
    (b.sharedCurrentCount - a.sharedCurrentCount) ||
    (b.currentMatches - a.currentMatches) ||
    (b.approvedMatches - a.approvedMatches) ||
    String(a.name).localeCompare(String(b.name), 'es', { sensitivity:'base' })
  );
}

const AGENDA_IMPORT_SOURCE_KIND = 'agenda_import_txt';
const AGENDA_ALL_CAREERS_TOKEN = '*';

function parseAgendaImportLine(line){
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;

  const parts = raw.split('|').map((p) => String(p || '').trim());
  if (parts.length < 4) return null;

  const datePart = parts[0];
  const timePart = parts[1];
  const titlePart = parts[2];
  const textPart = parts.slice(3).join(' | ');

  let from = '';
  let to = '';

  if (/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(datePart)){
    const [a, b] = datePart.split('..');
    from = a;
    to = b;
  }else if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)){
    from = datePart;
    to = datePart;
  }else{
    return null;
  }

  if (!isYMD(from) || !isYMD(to)) return null;
  const time = sanitizeTimeHM(timePart);
  const title = clampText(titlePart, 60);
  const text = clampText(textPart, 300);
  if (!title) return null;

  return {
    title,
    text,
    time,
    from,
    to,
    color: '#38bdf8',
    important: 0,
    repeat_json: JSON.stringify({ mode:'none', dows:[], dom:[] })
  };
}

function parseAgendaImportText(content){
  return String(content || '')
    .split(/\r?\n/)
    .map(parseAgendaImportLine)
    .filter(Boolean);
}

router.get('/api/affinity', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const viewerCareer = normalizeCareer(String(req.user?.career || '').trim()) || '';
    const viewerPlan = toInt(req.user?.plan, 0) || 0;

    const state = await getAffinityStateForUser(viewerId, viewerCareer, viewerPlan);

    let candidateRows = [];
    if (viewerCareer && viewerPlan){
      candidateRows = await all(
        `SELECT id, username, name, career, plan, avatarUrl,
                affinity_approved_subject_ids, affinity_current_subject_ids, affinity_interests_json, affinity_completed_at
         FROM users
         WHERE id <> ?
           AND COALESCE(affinity_completed_at, '') <> ''
           AND career = ?
           AND plan = ?
         ORDER BY name COLLATE NOCASE
         LIMIT 600`,
        [viewerId, viewerCareer, viewerPlan]
      );
    }

    const suggestions = computeAffinitySuggestionList(state, candidateRows);

    return res.json({
      ok: true,
      completed: !!state.completed,
      completedAt: state.completedAt || '',
      profile: state.answers,
      questions: state.questions,
      subjects: state.subjects,
      suggestions
    });
  }catch(e){
    console.error('GET /app/perfil/api/affinity error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo cargar Mis Intereses' });
  }
});

router.post('/api/affinity', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const viewerCareer = normalizeCareer(String(req.user?.career || '').trim()) || '';
    const viewerPlan = toInt(req.user?.plan, 0) || 0;
    const state = await getAffinityStateForUser(viewerId, viewerCareer, viewerPlan);

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const validSubjectIds = new Set((state.subjects || []).map(s => toInt(s.id, 0)).filter(Boolean));

    const approvedSubjectIds = uniqIntArray(body.approvedSubjectIds).filter(id => validSubjectIds.has(id));
    const approvedSet = new Set(approvedSubjectIds);

    const currentSubjectIds = uniqIntArray(body.currentSubjectIds)
      .filter(id => validSubjectIds.has(id))
      .filter(id => !approvedSet.has(id));

    const interests = normalizeAffinityInterests(body.interests, state.questions);

    const missing = state.questions.find((q) => !isAffinityAnswerFilled(q, interests[q.id]));
    if (missing){
      return res.status(400).json({ ok:false, error:'Respondé todas las preguntas antes de finalizar.' });
    }

    await run(
      `UPDATE users
       SET affinity_approved_subject_ids = ?,
           affinity_current_subject_ids = ?,
           affinity_interests_json = ?,
           affinity_completed_at = datetime('now')
       WHERE id = ?`,
      [
        JSON.stringify(approvedSubjectIds),
        JSON.stringify(currentSubjectIds),
        JSON.stringify(interests),
        viewerId
      ]
    );

    await syncAffinityApprovedChecks(viewerId, state.subjects, approvedSubjectIds);

    const refreshed = await getAffinityStateForUser(viewerId, viewerCareer, viewerPlan);

    let candidateRows = [];
    if (viewerCareer && viewerPlan){
      candidateRows = await all(
        `SELECT id, username, name, career, plan, avatarUrl,
                affinity_approved_subject_ids, affinity_current_subject_ids, affinity_interests_json, affinity_completed_at
         FROM users
         WHERE id <> ?
           AND COALESCE(affinity_completed_at, '') <> ''
           AND career = ?
           AND plan = ?
         ORDER BY name COLLATE NOCASE
         LIMIT 600`,
        [viewerId, viewerCareer, viewerPlan]
      );
    }

    const suggestions = computeAffinitySuggestionList(refreshed, candidateRows);

    return res.json({
      ok: true,
      completed: true,
      completedAt: refreshed.completedAt || '',
      profile: refreshed.answers,
      questions: refreshed.questions,
      subjects: refreshed.subjects,
      suggestions
    });
  }catch(e){
    console.error('POST /app/perfil/api/affinity error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo guardar Mis Intereses' });
  }
});

// =========================
// ✅ Perfil: actualizar nombre + bio (JSON)
// POST /app/perfil/update
// =========================
router.post('/update', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const uid = uidOf(req.user);
    if (!uid) return res.status(401).json({ ok:false, error:'No autenticado' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
    const hasBio  = Object.prototype.hasOwnProperty.call(body, 'bio');
    const hasAvatarUrl = Object.prototype.hasOwnProperty.call(body, 'avatarUrl');
    const hasHeroTheme = Object.prototype.hasOwnProperty.call(body, 'heroTheme');
    const hasIg          = Object.prototype.hasOwnProperty.call(body, 'instagram_username');
    const hasSocialLinks = Object.prototype.hasOwnProperty.call(body, 'socialLinks');

    const sets = [];
    const params = [];

    let outName = null;
    let outBio  = null;
    let outAvatarUrl = null;
    let outHeroTheme = null;

    if (hasName){
      const nameRaw = toStr(body.name, '').replace(/\s+/g,' ').trim();
      if (nameRaw){
        outName = clampText(nameRaw, 60);
        sets.push('name = ?');
        params.push(outName);
      }
    }

    if (hasBio){
      const bioRaw = toStr(body.bio, '');
      outBio = clampText(bioRaw, 300).trim();
      sets.push('bio = ?');
      params.push(outBio);
    }

    if (hasAvatarUrl){
      const av = toStr(body.avatarUrl, '').trim().replace(/^["']+|["']+$/g,'');
      outAvatarUrl = (av && av.length > 3) ? av : '';
      sets.push('avatarUrl = ?');
      params.push(outAvatarUrl);
    }

    if (hasHeroTheme){
      const ht = clampText(toStr(body.heroTheme, '').trim(), 20);
      outHeroTheme = ht;
      sets.push('heroTheme = ?');
      params.push(outHeroTheme);
    }

    if (hasIg){
      const ig = clampText(toStr(body.instagram_username, '').trim(), 50);
      sets.push('instagram_username = ?');
      params.push(ig);
      try{ if (req.user) req.user.instagram_username = ig; }catch(_){ }
    }
    if (hasSocialLinks){
      const sl = body.socialLinks && typeof body.socialLinks === 'object'
        ? JSON.stringify(body.socialLinks)
        : '{}';
      sets.push('social_links = ?');
      params.push(sl);
      try{ if (req.user) req.user.social_links = sl; }catch(_){ }
    }

    if (!sets.length) return res.json({ ok:true });

    params.push(uid, uid);
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ? OR email = ?`, params);

    // ✅ si cambió el nombre y el username era vacío/"usuario", lo actualizamos a un slug del nombre
    if (outName !== null){
      try{
        const r0 = await get(`SELECT id, username FROM users WHERE id = ? OR email = ? LIMIT 1`, [uid, uid]);
        const selfId = r0 ? toInt(r0.id, 0) : 0;
        const curU  = r0 ? toStr(r0.username, '').trim() : '';
        const should = (!curU) || /^usuario(\-|$)/i.test(curU);

        if (selfId && should){
          const base = slugifyUsername(outName) || 'usuario';
          let candidate = base;

          for (let i=0;i<8;i++){
            const ex = await get(`SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1`, [candidate]);
            if (!ex || toInt(ex.id, 0) === selfId) break;
            candidate = (i === 0) ? `${base}-${selfId}` : `${base}-${selfId}-${i}`;
          }

          await run(`UPDATE users SET username = ? WHERE id = ?`, [candidate, selfId]);
          try{ if (req.user) req.user.username = candidate; }catch(_){ }
        }
      }catch(_){ }
    }

    // Mantener req.user sincronizado
    try{
      if (req.user){
        if (outName !== null) req.user.name = outName;
        if (outBio  !== null) req.user.bio  = outBio;
        if (outAvatarUrl !== null) req.user.avatarUrl = outAvatarUrl;
        if (outHeroTheme !== null) req.user.heroTheme = outHeroTheme;
      }
    }catch(_){ }

    return res.json({ ok:true, name: outName, bio: outBio, avatarUrl: outAvatarUrl, heroTheme: outHeroTheme });
  }catch(e){
    console.error('POST /app/perfil/update error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo guardar el perfil' });
  }
});

// =========================
// ✅ Follow toggle
// POST /app/perfil/follow/toggle
// body: { uid | targetId | userId | followingId }
// =========================
router.post('/follow/toggle', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const targetUid =
      toStr((req.body && (req.body.uid || req.body.targetId || req.body.userId || req.body.followingId)) || req.query.uid || '', '').trim();

    if (!targetUid) return res.status(400).json({ ok:false, error:'Falta uid' });

    const targetRow = await resolveUserRowByUid(targetUid);
    const targetId = targetRow ? toInt(targetRow.id, 0) : 0;

    if (!targetId) return res.status(404).json({ ok:false, error:'Usuario no encontrado' });
    if (targetId === viewerId) return res.status(400).json({ ok:false, error:'No podés seguirte a vos mismo' });

    const existing = await get(
      `SELECT 1 AS ok FROM follows WHERE follower_id = ? AND following_id = ? LIMIT 1`,
      [viewerId, targetId]
    );

    let following = false;

    if (existing){
      await run(`DELETE FROM follows WHERE follower_id = ? AND following_id = ?`, [viewerId, targetId]);
      following = false;
    } else {
      await run(
        `INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)` ,
        [viewerId, targetId]
      );
      following = true;
    }

    const targetFollowersRow = await get(`SELECT COUNT(*) AS c FROM follows WHERE following_id = ?`, [targetId]);
    const viewerFollowingRow = await get(`SELECT COUNT(*) AS c FROM follows WHERE follower_id  = ?`, [viewerId]);

    const targetFollowers = pickCountRow(targetFollowersRow);
    const viewerFollowing = pickCountRow(viewerFollowingRow);

    return res.json({
      ok: true,
      following,
      targetId,
      targetFollowers,
      viewerFollowing,

      // alias (por si tu front usa otros nombres)
      followersCount: targetFollowers,
      myFollowingCount: viewerFollowing
    });
  }catch(e){
    console.error('POST /app/perfil/follow/toggle error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo actualizar el seguimiento' });
  }
});

// =========================
// ✅ API: usuarios (para búsquedas remotas si querés)
// GET /app/perfil/api/users?q=...
// =========================
router.get('/api/users', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const q = toStr(req.query.q, '').trim();
    if (!q){
      const rows = await listUsersLight();
      return res.json({ ok:true, users: rows });
    }

    const qq = `%${q.toLowerCase()}%`;
    const rows = await all(
      `SELECT id, username, name, career, plan, avatarUrl
       FROM users
       WHERE lower(name) LIKE ? OR lower(surname) LIKE ? OR lower(email) LIKE ? OR lower(username) LIKE ?
       ORDER BY name COLLATE NOCASE
       LIMIT 50`,
      [qq, qq, qq, qq]
    );

    return res.json({ ok:true, users: rows || [] });
  }catch(e){
    console.error('GET /app/perfil/api/users error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo buscar usuarios' });
  }
});

// =========================
// ✅ API: posts por usuario
// GET /app/perfil/api/posts/:uid
// =========================
router.get('/api/posts/:uid', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);

    const uid = toStr(req.params.uid, '').trim();
    const authorRow = await resolveUserRowByUid(uid);
    const authorId = authorRow ? toInt(authorRow.id, 0) : 0;
    if (!authorId) return res.status(404).json({ ok:false, error:'Usuario no encontrado' });

    const posts = await all(
      `SELECT p.id, p.text, p.tags_json, p.created_at,
              u.id AS author_id, u.username AS author_username, u.name AS author_name, u.avatarUrl AS author_avatar,
              COALESCE((SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id), 0) AS likes_count,
              CASE WHEN EXISTS(
                SELECT 1 FROM post_likes l2 WHERE l2.post_id = p.id AND l2.user_id = ?
              ) THEN 1 ELSE 0 END AS liked
       FROM profile_posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.deleted = 0 AND p.author_id = ?
       ORDER BY p.id DESC
       LIMIT 120`,
      [viewerId || 0, authorId]
    );

    return res.json({ ok:true, posts: posts || [] });
  }catch(e){
    console.error('GET /app/perfil/api/posts/:uid error:', e);
    return res.status(500).json({ ok:false, error:'No se pudieron cargar los posts' });
  }
});

// =========================
// ✅ API: feed (mis posts + posts de seguidos)
// GET /app/perfil/api/feed
// =========================
router.get('/api/feed', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const q = toStr(req.query.q, '').trim().toLowerCase();
    const sort = toStr(req.query.sort, '').trim().toLowerCase();

    const where = [`p.deleted = 0`];
    const params = [viewerId];

    if (q){
      where.push(`(lower(p.text) LIKE ? OR lower(COALESCE(p.tags_json,'')) LIKE ? OR lower(COALESCE(u.name,'')) LIKE ? OR lower(COALESCE(u.username,'')) LIKE ?)`);
      const qq = `%${q}%`;
      params.push(qq, qq, qq, qq);
    }

    const orderBy = (sort === 'likes' || sort === 'gustados')
      ? `COALESCE(lc.c, 0) DESC, p.id DESC`
      : `p.id DESC`;

    const posts = await all(
      `SELECT p.id, p.text, p.tags_json, p.created_at,
              u.id AS author_id, u.username AS author_username, u.name AS author_name, u.avatarUrl AS author_avatar,
              COALESCE(lc.c, 0) AS likes_count,
              CASE WHEN ul.user_id IS NULL THEN 0 ELSE 1 END AS liked
       FROM profile_posts p
       JOIN users u ON u.id = p.author_id
       LEFT JOIN (
         SELECT post_id, COUNT(*) AS c
         FROM post_likes
         GROUP BY post_id
       ) lc ON lc.post_id = p.id
       LEFT JOIN post_likes ul ON ul.post_id = p.id AND ul.user_id = ?
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT 300`,
      params
    );

    return res.json({ ok:true, posts: posts || [] });
  }catch(e){
    console.error('GET /app/perfil/api/feed error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo cargar el feed' });
  }
});

// =========================
// ✅ API: crear post
// POST /app/perfil/api/posts
// body: { text }
// =========================
router.post('/api/posts', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    let text = toStr((req.body && req.body.text) || '', '');
    text = clampText(text, 1200);

    if (!text.trim()) return res.status(400).json({ ok:false, error:'El post está vacío' });
    if (wordCount(text) > 150) return res.status(400).json({ ok:false, error:'Máximo 150 palabras' });

    // tags opcionales (subjects/people)
    const rawTags = (req.body && typeof req.body.tags === 'object' && req.body.tags) ? req.body.tags : {};
    const subArr = Array.isArray(rawTags.subjects) ? rawTags.subjects : [];
    const pplArr = Array.isArray(rawTags.people) ? rawTags.people : [];

    const safeSubjects = subArr
      .map(x => ({ id: toStr(x && (x.id ?? x.subjectId ?? x.subject_id), ''), name: toStr(x && (x.name ?? x.title), '') }))
      .filter(x => x.id || x.name)
      .slice(0, 20);

    const safePeople = pplArr
      .map(x => ({ id: toStr(x && (x.id ?? x.userId ?? x.user_id), ''), name: toStr(x && (x.name ?? x.username), '') }))
      .filter(x => x.id || x.name)
      .slice(0, 20);

    const tags_json = JSON.stringify({ subjects: safeSubjects, people: safePeople });

    const rs = await run(
      `INSERT INTO profile_posts (author_id, text, tags_json) VALUES (?, ?, ?)` ,
      [viewerId, text.trim(), tags_json]
    );

    const id = pickLastId(rs);

    const row = await get(
      `SELECT p.id, p.text, p.tags_json, p.created_at,
              u.id AS author_id, u.username AS author_username, u.name AS author_name, u.avatarUrl AS author_avatar,
              0 AS likes_count,
              0 AS liked
       FROM profile_posts p
       JOIN users u ON u.id = p.author_id
       WHERE p.id = ? LIMIT 1`,
      [id]
    );

    return res.json({ ok:true, post: row || null });
  }catch(e){
    console.error('POST /app/perfil/api/posts error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo publicar' });
  }
});

// =========================
// ✅ API: borrar post (solo autor)
// POST /app/perfil/api/posts/delete
// body: { id }
// =========================
router.post('/api/posts/delete', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const postId = toInt((req.body && req.body.id) || 0, 0);
    if (!postId) return res.status(400).json({ ok:false, error:'Falta id' });

    const isAdmin = String(req.user?.role || '').trim().toLowerCase() === 'admin';

    let rs;
    if (isAdmin){
      rs = await run(
        `UPDATE profile_posts SET deleted = 1 WHERE id = ?`,
        [postId]
      );
    }else{
      rs = await run(
        `UPDATE profile_posts SET deleted = 1 WHERE id = ? AND author_id = ?`,
        [postId, viewerId]
      );
    }

    const ok = Number(rs?.rowsAffected || rs?.changes || rs?.affectedRows || 0) > 0;
    if (!ok) return res.status(404).json({ ok:false, error:'No encontrado' });

    return res.json({ ok:true });
  }catch(e){
    console.error('POST /app/perfil/api/posts/delete error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo borrar' });
  }
});

// =========================
// ✅ API: like toggle
// POST /app/perfil/api/posts/like-toggle
// body: { id | postId }
// =========================
router.post('/api/posts/like-toggle', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const postId = toInt((req.body && (req.body.id || req.body.postId)) || 0, 0);
    if (!postId) return res.status(400).json({ ok:false, error:'Falta id' });

    // existe post?
    const p = await get(`SELECT id FROM profile_posts WHERE id = ? AND deleted = 0 LIMIT 1`, [postId]);
    if (!p) return res.status(404).json({ ok:false, error:'Post no encontrado' });

    const ex = await get(
      `SELECT 1 AS ok FROM post_likes WHERE post_id = ? AND user_id = ? LIMIT 1`,
      [postId, viewerId]
    );

    let liked = false;
    if (ex){
      await run(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`, [postId, viewerId]);
      liked = false;
    }else{
      await run(`INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)`, [postId, viewerId]);
      liked = true;
    }

    const cRow = await get(`SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?`, [postId]);
    const likes = pickCountRow(cRow);

    return res.json({ ok:true, postId, liked, likes });
  }catch(e){
    console.error('POST /app/perfil/api/posts/like-toggle error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo actualizar el like' });
  }
});

// =========================
// ✅ AGENDA
// GET  /app/perfil/api/agenda
// POST /app/perfil/api/agenda/save   { id?, title, text, color, from, to, important }
// POST /app/perfil/api/agenda/delete { id }
// =========================
router.get('/api/agenda', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();
    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const viewerCareer = normalizeCareer(String(req.user?.career || '').trim()) || '';
    const isAdmin = String(req.user?.role || '').toLowerCase() === 'admin';

    let rows = [];

    if (isAdmin){
      rows = await all(
        `SELECT id, owner_id, title, text, time_hm, color, repeat_json, is_global, careers, from_ymd, to_ymd, important, created_at, updated_at
         FROM agenda_events
         WHERE deleted = 0
           AND (owner_id = ? OR is_global = 1)
         ORDER BY from_ymd ASC, id ASC
         LIMIT 2000`,
        [viewerId]
      );
    }else if (viewerCareer){
      rows = await all(
        `SELECT id, owner_id, title, text, time_hm, color, repeat_json, is_global, careers, from_ymd, to_ymd, important, created_at, updated_at
         FROM agenda_events
         WHERE deleted = 0
           AND (
             owner_id = ?
             OR (is_global = 1 AND (careers = ? OR ',' || careers || ',' LIKE '%,' || ? || ',%'))
           )
         ORDER BY from_ymd ASC, id ASC
         LIMIT 2000`,
        [viewerId, AGENDA_ALL_CAREERS_TOKEN, viewerCareer]
      );
    }else{
      rows = await all(
        `SELECT id, owner_id, title, text, time_hm, color, repeat_json, is_global, careers, from_ymd, to_ymd, important, created_at, updated_at
         FROM agenda_events
         WHERE deleted = 0
           AND owner_id = ?
         ORDER BY from_ymd ASC, id ASC
         LIMIT 1500`,
        [viewerId]
      );
    }

    const seen = new Set();
    const events = (rows || []).filter(r => {
      const id = toInt(r.id, 0);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    }).map(r => ({
      id: toInt(r.id, 0),
      repeat: parseRepeatJson(r.repeat_json),
      title: toStr(r.title, ''),
      text: toStr(r.text, ''),
      time: sanitizeTimeHM(r.time_hm),
      color: toStr(r.color, '#22c55e') || '#22c55e',
      from: toStr(r.from_ymd, ''),
      to: toStr(r.to_ymd, ''),
      important: !!toInt(r.important, 0),
      isGlobal: !!toInt(r.is_global, 0),
      careers: parseCareerCsv(r.careers),
      canEdit: toInt(r.owner_id, 0) === viewerId
    }));

    return res.json({ ok:true, events });
  }catch(e){
    console.error('GET /app/perfil/api/agenda error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo cargar la agenda' });
  }
});

router.post('/api/agenda/import-text', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();
    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const isAdmin = String(req.user?.role || '').toLowerCase() === 'admin';
    if (!isAdmin) return res.status(403).json({ ok:false, error:'Solo el administrador puede importar horarios' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const content = String(body.content || '');
    const rows = parseAgendaImportText(content);
    if (!rows.length) return res.status(400).json({ ok:false, error:'El archivo no tiene líneas válidas. Usá: YYYY-MM-DD | HH:MM | Título | Texto' });

    await run(
      `UPDATE agenda_events
       SET deleted = 1,
           updated_at = datetime('now')
       WHERE deleted = 0
         AND source_kind = ?`,
      [AGENDA_IMPORT_SOURCE_KIND]
    );

    for (const item of rows){
      await run(
        `INSERT INTO agenda_events (owner_id, title, text, time_hm, color, repeat_json, is_global, careers, from_ymd, to_ymd, important, source_kind)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [viewerId, item.title, item.text, item.time, item.color, item.repeat_json, AGENDA_ALL_CAREERS_TOKEN, item.from, item.to, item.important, AGENDA_IMPORT_SOURCE_KIND]
      );
    }

    return res.json({ ok:true, imported: rows.length });
  }catch(e){
    console.error('POST /app/perfil/api/agenda/import-text error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo importar el archivo de agenda' });
  }
});

router.post('/api/agenda/save', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();
    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const isAdmin = String(req.user?.role || '').toLowerCase() === 'admin';

    const id = toInt(body.id || 0, 0);
    const title = clampText(toStr(body.title, '').trim(), 60);
    const text  = clampText(toStr(body.text, ''), 300).trim();
    const time  = sanitizeTimeHM(body.time);
    const color = clampText(toStr(body.color, '#22c55e').trim(), 20) || '#22c55e';
    const { from, to } = clampRangeYMD(body.from, body.to);
    const important = body.important ? 1 : 0;
    const repeat = sanitizeRepeat(body.repeat);
    const repeat_json = JSON.stringify(repeat);

    const scope = (isAdmin && String(body.scope || '').trim().toLowerCase() === 'global') ? 'global' : 'personal';
    let selectedCareers = Array.isArray(body.careers) ? body.careers : [];
    selectedCareers = selectedCareers.map(c => normalizeCareer(String(c || '').trim())).filter(Boolean);
    selectedCareers = Array.from(new Set(selectedCareers));

    const is_global = scope === 'global' ? 1 : 0;
    const careersCsv = is_global ? selectedCareers.join(',') : '';

    if (!isYMD(from) || !isYMD(to)) return res.status(400).json({ ok:false, error:'Fechas inválidas' });
    if (is_global && !selectedCareers.length) return res.status(400).json({ ok:false, error:'Seleccioná al menos una carrera' });

    if (id){
      // update (solo dueño)
      const ex = await get(`SELECT id FROM agenda_events WHERE id = ? AND owner_id = ? AND deleted = 0 LIMIT 1`, [id, viewerId]);
      if (!ex) return res.status(404).json({ ok:false, error:'Evento no encontrado' });

      await run(
        `UPDATE agenda_events
         SET title = ?, text = ?, time_hm = ?, color = ?, repeat_json = ?, is_global = ?, careers = ?, from_ymd = ?, to_ymd = ?, important = ?, updated_at = datetime('now')
         WHERE id = ? AND owner_id = ?`,
        [title, text, time, color, repeat_json, is_global, careersCsv, from, to, important, id, viewerId]
      );

      return res.json({
        ok:true,
        event: {
          id,
          title,
          text,
          time,
          color,
          from,
          to,
          important: !!important,
          repeat,
          isGlobal: !!is_global,
          careers: selectedCareers,
          canEdit: true
        }
      });
    }

    const rs = await run(
      `INSERT INTO agenda_events (owner_id, title, text, time_hm, color, repeat_json, is_global, careers, from_ymd, to_ymd, important, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
      [viewerId, title, text, time, color, repeat_json, is_global, careersCsv, from, to, important]
    );

    const newId = pickLastId(rs);

    return res.json({
      ok:true,
      event: {
        id: newId,
        title,
        text,
        time,
        color,
        from,
        to,
        important: !!important,
        repeat,
        isGlobal: !!is_global,
        careers: selectedCareers,
        canEdit: true
      }
    });
  }catch(e){
    console.error('POST /app/perfil/api/agenda/save error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo guardar el evento' });
  }
});

router.post('/api/agenda/delete', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();
    const viewerId = await resolveNumericUserIdFromReqUser(req.user);
    if (!viewerId) return res.status(401).json({ ok:false, error:'No autenticado' });

    const id = toInt((req.body && req.body.id) || 0, 0);
    if (!id) return res.status(400).json({ ok:false, error:'Falta id' });

    const rs = await run(
      `UPDATE agenda_events SET deleted = 1, updated_at = datetime('now') WHERE id = ? AND owner_id = ?`,
      [id, viewerId]
    );
    const ok = Number(rs?.rowsAffected || rs?.changes || rs?.affectedRows || 0) > 0;
    if (!ok) return res.status(404).json({ ok:false, error:'No encontrado' });

    return res.json({ ok:true, id });
  }catch(e){
    console.error('POST /app/perfil/api/agenda/delete error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo borrar' });
  }
});

// =========================
// Vista Perfil
// =========================
router.get(['/', '/:uid'], requireAuth, async (req, res) => {
  await ensureProfileSchema();

  const viewer = req.user || null;
  const viewerUid = uidOf(viewer);

  // Por defecto: mostrar MI perfil
  let viewUser = viewer;
  const paramUid = String(req.params.uid || '');
    // ✅ Si es mi perfil, cargamos mi usuario completo desde DB (bio/heroTheme/etc)
  if (viewerUid){
    try{
      const me = await get(
        `SELECT * FROM users WHERE id = ? OR email = ? LIMIT 1`,
        [viewerUid, viewerUid]
      );
      if (me) viewUser = me;
    }catch(_){
      // no rompe
    }
  }

  // Si se pide /app/perfil/:uid, intentamos cargar otro usuario SIN romper si DB no está disponible
  if (paramUid && paramUid !== viewerUid){
    try{
      const row = await get(
        `SELECT * FROM users WHERE id = ? OR email = ? OR lower(username) = lower(?) LIMIT 1`,
        [paramUid, paramUid, paramUid]
      );
      if (row) viewUser = row;
    }catch(_){
      // si falla, seguimos con el propio
    }
  }

  // Forzamos a tener viewUser.id numérico cuando sea posible
  let viewUserId = toInt(viewUser && viewUser.id, 0);
  if (!viewUserId){
    const row = await resolveUserRowByUid(uidOf(viewUser));
    if (row){
      viewUser = row;
      viewUserId = toInt(row.id, 0);
    }
  }

  const viewerIdNum = await resolveNumericUserIdFromReqUser(viewer);

  const isOwn = !!(viewerIdNum && viewUserId && viewerIdNum === viewUserId);

  // Seguidores / Seguidos reales (si existe follows)
  const followStats = await calcFollowStats(viewUserId);

  // Materias aprobadas (best effort, no rompe)
  const approved = await calcApprovedCount(String(viewUserId || uidOf(viewUser) || viewerUid));

  const stats = {
    followers: followStats.followers || 0,
    following: followStats.following || 0,
    approved:  approved || 0
  };

  // isFollowing (para botón Seguir/Seguido)
  let isFollowing = false;
  if (!isOwn && viewerIdNum && viewUserId){
    try{
      const row = await get(
        `SELECT 1 AS ok FROM follows WHERE follower_id = ? AND following_id = ? LIMIT 1`,
        [viewerIdNum, viewUserId]
      );
      isFollowing = !!row;
    }catch(_){ }
  }

  // ✅ Listas para buscador de usuarios y @materia
  const users = await listUsersLight();
  const subjects = await listSubjectsLight(viewer && viewer.career, viewer && viewer.plan);
  const professors = await listProfessorsLight(viewer && viewer.career, viewer && viewer.plan);

  // ✅ random users (max 7) para “circulitos” superpuestos
  const randomUsers = await listRandomUsers(7, viewUserId);

  // ✅ seguidores del usuario LOGUEADO (para el dock lateral)
  let dockFollowers = [];
  if (viewerIdNum){
    try{
      dockFollowers = await all(
        `SELECT u.id, u.username, u.name, u.avatarUrl
         FROM follows f
         JOIN users u ON u.id = f.follower_id
         WHERE f.following_id = ?
         ORDER BY f.created_at DESC
         LIMIT 12`,
        [viewerIdNum]
      );
    }catch(_){ dockFollowers = []; }
  }

  // ✅ amigos = seguidores (solo para MI perfil)
  let myFollowers = [];
  if (isOwn && viewerIdNum){
    try{
      myFollowers = await all(
        `SELECT u.id, u.username, u.name, u.career, u.plan, u.avatarUrl
         FROM follows f
         JOIN users u ON u.id = f.follower_id
         WHERE f.following_id = ?
         ORDER BY u.name COLLATE NOCASE
         LIMIT 400`,
        [viewerIdNum]
      );
    }catch(_){ myFollowers = []; }
  }

  const avatarUrl = String((viewUser && viewUser.avatarUrl) || '').trim();

  let socialLinks = {};
  try{
    const raw = String((viewUser && viewUser.social_links) || '').trim();
    if (raw) socialLinks = JSON.parse(raw);
  }catch(_){ socialLinks = {}; }

  return res.render('perfil', {
    title: 'Perfil',
    user: viewer,        // el logueado
    viewUser,            // el perfil que se ve
    stats,               // {followers, following, approved}
    avatarUrl,
    users,
    subjects,
    isFollowing,
    professors,
    randomUsers,
    dockFollowers,
    myFollowers,
    socialLinks,
    isMainPage: true,
    sectionKey: 'perfil'
  });
});

// =========================
// Seguridad básica anti-SSRF para proxy
// =========================
function isPrivateHostname(hostname){
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return true;

  // localhost & similares
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // IPv6 loopback
  if (h === '::1') return true;

  // IPv4 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m){
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
    const ok = [a,b,c,d].every(n => Number.isFinite(n) && n >= 0 && n <= 255);
    if (!ok) return true;

    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 172.16.0.0 - 172.31.255.255
    if (a === 172 && b >= 16 && b <= 31) return true;
    // link-local 169.254.0.0/16
    if (a === 169 && b === 254) return true;
    // 0.0.0.0
    if (a === 0) return true;
  }

  return false;
}

function safeUrl(str){
  const raw = String(str || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try{
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHostname(u.hostname)) return null;
    return u;
  }catch(_){
    return null;
  }
}

function reqLibFor(urlObj){
  return urlObj.protocol === 'https:' ? https : http;
}
function guessImageContentTypeFromUrl(u){
  try{
    const p = String(u && u.pathname ? u.pathname : '').toLowerCase();
    if (/\.(png)(\?|#|$)/i.test(p)) return 'image/png';
    if (/\.(jpe?g)(\?|#|$)/i.test(p)) return 'image/jpeg';
    if (/\.(webp)(\?|#|$)/i.test(p)) return 'image/webp';
    if (/\.(gif)(\?|#|$)/i.test(p)) return 'image/gif';
    if (/\.(svg)(\?|#|$)/i.test(p)) return 'image/svg+xml';
  }catch(_){}
  return '';
}
function sniffImageContentTypeFromChunk(buf){
  try{
    if (!buf || buf.length < 12) return '';
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    // JPG
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    // GIF
    const a4 = buf.toString('ascii', 0, 4);
    if (a4 === 'GIF8') return 'image/gif';
    // WEBP (RIFF....WEBP)
    const riff = buf.toString('ascii', 0, 4);
    const webp = buf.toString('ascii', 8, 12);
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    // SVG (heurística)
    const head = buf.toString('utf8', 0, Math.min(180, buf.length)).toLowerCase();
    if (head.includes('<svg')) return 'image/svg+xml';
  }catch(_){}
  return '';
}
function fetchWithRedirects(urlStr, opts = {}){
  const {
    timeoutMs = 9000,
    maxBytes = 250000,
    maxRedirects = 5,
    headers = {},
    method = 'GET'
  } = opts;

  return new Promise((resolve, reject) => {
    const u = safeUrl(urlStr);
    if (!u) return reject(new Error('bad url'));

    const lib = reqLibFor(u);

    const r = lib.request(u, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8,text/html;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.7',
        // pedir pocos bytes para no matar la PC (reduce lag)
        'Range': 'bytes=0-262143',
        ...headers
      }
    }, (resp) => {
      const code = resp.statusCode || 0;
      const loc = resp.headers.location;

      if ([301,302,303,307,308].includes(code) && loc && maxRedirects > 0){
        const next = new URL(loc, u).toString();
        resp.resume();
        return resolve(fetchWithRedirects(next, { ...opts, maxRedirects: maxRedirects - 1 }));
      }

      const chunks = [];
      let bytes = 0;

      resp.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes){
          // cortamos para evitar lag
          resp.destroy();
          return;
        }
        chunks.push(chunk);
      });

      resp.on('end', () => {
        resolve({
          finalUrl: u.toString(),
          statusCode: code,
          headers: resp.headers || {},
          buffer: Buffer.concat(chunks)
        });
      });

      resp.on('error', reject);
    });

    r.on('error', reject);
    r.setTimeout(timeoutMs, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

function extractOgImage(html){
  const s = String(html || '');

  // og:image / og:image:secure_url / twitter:image
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["'][^>]*>/i
  ];

  for (const rx of patterns){
    const m = s.match(rx);
    if (m && m[1]) return String(m[1]).trim();
  }

  // alternativa (content antes que property)
  const rx2 = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i;
  const m2 = s.match(rx2);
  if (m2 && m2[1]) return String(m2[1]).trim();

  return '';
}

async function resolveToImageUrl(rawUrl){
  const u = safeUrl(rawUrl);
  if (!u) throw new Error('URL inválida');

  // 1) traemos respuesta liviana
  const r = await fetchWithRedirects(u.toString(), { maxBytes: 260000 });
  const ct = String(r.headers['content-type'] || '').toLowerCase();

  // Si ya es imagen, devolvemos la URL final
  if (ct.startsWith('image/')) return r.finalUrl;

  // Si es HTML, buscamos og:image
  if (ct.includes('text/html') || ct.includes('application/xhtml') || (!ct && r.buffer.length)){
    const html = r.buffer.toString('utf8');
    const og = extractOgImage(html);
    if (og && /^https?:\/\//i.test(og)){
      const ogU = safeUrl(og);
      if (ogU) return ogU.toString();
    }
  }

  // fallback: si parece imagen por extensión, aceptamos
  const s = u.toString().toLowerCase();
  if (/\.(png|jpg|jpeg|webp|gif)(\?|#|$)/i.test(s)) return u.toString();

  throw new Error('No se pudo resolver a una imagen (probá pegar el link directo de la imagen)');
}

/* =========================
   AVATAR: Proxy (para hotlink/IG/etc.)
   GET /app/perfil/avatar/proxy?u=https://...
   ========================= */
router.get('/avatar/proxy', async (req, res) => {
  try{
    const u = safeUrl(req.query.u);
    if (!u) return res.status(400).end('bad url');

    const lib = reqLibFor(u);
    const r = lib.request(u, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.7',
        'Referer': u.origin
      }
    }, (resp) => {
      const code = resp.statusCode || 0;

      // redirects
      if ([301,302,303,307,308].includes(code) && resp.headers.location){
        const next = new URL(resp.headers.location, u).toString();
        resp.resume();
        return res.redirect(`/app/perfil/avatar/proxy?u=${encodeURIComponent(next)}`);
      }

      if (code >= 400){
        resp.resume();
        return res.status(404).end('not found');
      }

      let ct = String(resp.headers['content-type'] || '').toLowerCase().trim();
      const isOctetOrEmpty = (ct === '' || ct === 'application/octet-stream' || ct === 'binary/octet-stream');
      const guessed = guessImageContentTypeFromUrl(u);

      // Si el server remoto manda Content-Type malo (vacío u octet-stream),
      // intentamos deducirlo por URL o por "magic bytes" del archivo.
      if (!ct.startsWith('image/')){
        if (!isOctetOrEmpty){
          resp.resume();
          return res.status(415).end('not image');
        }

        // 1) si la URL tiene extensión de imagen, lo aceptamos
        if (guessed) ct = guessed;

        // 2) si NO hay extensión, sniff del primer chunk y recién ahí decidimos
        if (!ct.startsWith('image/')){
          resp.pause();

          let bytes = 0;
          let decided = false;

          resp.once('data', (first) => {
            bytes += first.length;

            const sniffed = sniffImageContentTypeFromChunk(first);
            if (sniffed) ct = sniffed;

            if (!ct.startsWith('image/')){
              try{ resp.destroy(); }catch(_){}
              return res.status(415).end('not image');
            }

            res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'public, max-age=86400');

            // límite para evitar lag/abuso
            resp.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > 6 * 1024 * 1024){
                resp.destroy();
              }
            });

            // escribimos el primer chunk que ya consumimos y seguimos pipeando
            res.write(first);
            decided = true;
            resp.pipe(res);
            resp.resume();
          });

          // por si no llega data (edge)
          resp.once('end', () => {
            if (!decided) return res.status(404).end('not found');
          });

          return;
        }
      }

      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');

      // límite para evitar lag/abuso
      let bytes = 0;
      resp.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 6 * 1024 * 1024){
          resp.destroy();
        }
      });

      resp.pipe(res);
    });

    r.on('error', () => res.status(400).end('error'));
    r.setTimeout(9000, () => r.destroy(new Error('timeout')));
    r.end();
  }catch(_){
    return res.status(400).end('error');
  }
});

/* =========================
   AVATAR: Presets “Netflix-style”
   GET  /app/perfil/avatar/preset/:key.svg
   POST /app/perfil/avatar/preset  { key }
   ========================= */
const PRESET_KEYS = new Set([
  'p01','p02','p03','p04','p05','p06','p07','p08',
  'p09','p10','p11','p12','p13','p14','p15','p16',
  'p17','p18','p19','p20','p21','p22','p23','p24'
]);

function accentFromKey(key){
  const h = crypto.createHash('sha1').update(String(key)).digest('hex');
  // colores suaves tipo iOS
  const palette = ['#60a5fa','#34d399','#fbbf24','#fb7185','#a78bfa','#22d3ee','#f97316','#94a3b8'];
  const idx = parseInt(h.slice(0, 2), 16) % palette.length;
  return palette[idx];
}

router.get('/avatar/preset/:key.svg', (req, res) => {
  try{
    const key = String(req.params.key || '').trim();
    if (!PRESET_KEYS.has(key)) return res.status(404).end('not found');

    const acc = accentFromKey(key);
    const ink = '#0f172a';

    const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${acc}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${acc}" stop-opacity="0.25"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="${ink}" flood-opacity="0.18"/>
    </filter>
  </defs>

  <circle cx="128" cy="128" r="110" fill="url(#g)" filter="url(#s)"/>
  <circle cx="128" cy="110" r="52" fill="#ffffff" opacity="0.98"/>
  <path d="M56 232c14-52 52-74 72-74s58 22 72 74" fill="#ffffff" opacity="0.98"/>

  <circle cx="108" cy="112" r="7" fill="${ink}" opacity="0.75"/>
  <circle cx="148" cy="112" r="7" fill="${ink}" opacity="0.75"/>
  <path d="M108 136c10 10 30 10 40 0" stroke="${ink}" stroke-width="10" stroke-linecap="round" opacity="0.35"/>
</svg>`;

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(svg);
  }catch(_){
    return res.status(500).end('error');
  }
});

router.post('/avatar/preset', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const key = String((req.body && req.body.key) || '').trim();
    if (!PRESET_KEYS.has(key)) return res.status(400).json({ ok:false, error:'Preset inválido' });

    const uid = uidOf(req.user);
    const stored = `/app/perfil/avatar/preset/${encodeURIComponent(key)}.svg`;

    try{
      await run(
        `UPDATE users SET avatarUrl=?, instagram_username=NULL WHERE id=? OR email=?`,
        [stored, uid, uid]
      );
    }catch(_){
      await run(
        `UPDATE users SET avatarUrl=? WHERE id=? OR email=?`,
        [stored, uid, uid]
      );
    }

    if (req.user) req.user.avatarUrl = stored;

    return res.json({ ok:true, avatarUrl: stored, key });
  }catch(e){
    console.error('POST /app/perfil/avatar/preset error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo guardar el avatar' });
  }
});

/* =========================
   AVATAR: pegar URL (cualquiera)
   - resuelve a imagen (og:image etc.)
   - guarda como proxy local para evitar hotlink
   ========================= */
router.post('/avatar/url', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const raw = String((req.body && (req.body.url || req.body.avatar || req.body.avatarUrl)) || '').trim();
    if (!raw) return res.status(400).json({ ok:false, error:'Pegá una URL válida' });

    // Aceptamos:
    // - URL http/https (se resuelve a imagen)
    // - data:image/png;base64,...
    // - data:image/jpeg;base64,...
    // - data:image/webp;base64,...
    const isHttp = /^https?:\/\/.+/i.test(raw);
    const isData = /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(raw);

    if (!isHttp && !isData){
      return res.status(400).json({ ok:false, error:'La URL debe ser http(s) o una imagen data:image (png/jpg/webp)' });
    }

    const uid = uidOf(req.user);

    // DataURL: guardamos directo (ojo: puede ser pesado)
    if (isData){
      try{
        await run(
          `UPDATE users SET avatarUrl=?, instagram_username=NULL WHERE id=? OR email=?`,
          [raw, uid, uid]
        );
      }catch(_){
        await run(
          `UPDATE users SET avatarUrl=? WHERE id=? OR email=?`,
          [raw, uid, uid]
        );
      }
      if (req.user) req.user.avatarUrl = raw;
      return res.json({ ok:true, avatarUrl: raw, stored: raw, resolved: raw });
    }

    // HTTP: resolvemos a imagen real y guardamos proxy
        const resolved = await resolveToImageUrl(raw);

    // ✅ Para Instagram/Facebook CDN (fbcdn) NO usamos proxy: suelen bloquear requests server-side.
    // Guardamos directo para que lo cargue el navegador.
    let stored = `/app/perfil/avatar/proxy?u=${encodeURIComponent(resolved)}`;
    try{
      const ru = new URL(resolved);
      const h = String(ru.hostname || '').toLowerCase();
      if (h.endsWith('fbcdn.net') || h.includes('cdninstagram.com')){
        stored = resolved;
      }
    }catch(_){ }

    try{
      await run(
        `UPDATE users SET avatarUrl=?, instagram_username=NULL WHERE id=? OR email=?`,
        [stored, uid, uid]
      );
    }catch(_){
      await run(
        `UPDATE users SET avatarUrl=? WHERE id=? OR email=?`,
        [stored, uid, uid]
      );
    }

    if (req.user) req.user.avatarUrl = stored;

    return res.json({ ok:true, avatarUrl: stored, stored, resolved });
  }catch(e){
    console.error('POST /app/perfil/avatar/url error:', e);
    const msg = (e && e.message) ? e.message : 'No se pudo guardar la foto';
    return res.status(500).json({ ok:false, error: msg });
  }
});

/* =========================
   AVATAR: eliminar foto
   ========================= */
router.post('/avatar/clear', requireAuth, async (req, res) => {
  try{
    await ensureProfileSchema();

    const uid = uidOf(req.user);

    try{
      await run(
        `UPDATE users SET avatarUrl='', instagram_username=NULL WHERE id=? OR email=?`,
        [uid, uid]
      );
    }catch(_){
      await run(
        `UPDATE users SET avatarUrl='' WHERE id=? OR email=?`,
        [uid, uid]
      );
    }

    if (req.user) req.user.avatarUrl = '';
    return res.json({ ok:true });
  }catch(e){
    console.error('POST /app/perfil/avatar/clear error:', e);
    return res.status(500).json({ ok:false, error:'No se pudo eliminar' });
  }
});

/* =========================
   AVATAR: generar PNG (Funko 3D) (legacy)
   - guarda dataURL PNG en users.avatarUrl
   ========================= */
router.post(
  '/avatar/generated',
  requireAuth,
  express.json({ limit: '3mb' }),
  async (req, res) => {
    try{
      await ensureProfileSchema();

      const png = String((req.body && (req.body.pngDataUrl || req.body.png || req.body.dataUrl)) || '').trim();
      if (!png) return res.status(400).json({ ok:false, error:'Falta la imagen' });

      if (!/^data:image\/png;base64,/i.test(png)){
        return res.status(400).json({ ok:false, error:'La imagen debe ser PNG (data:image/png;base64,...)' });
      }

      // límite de tamaño (base64 -> bytes aprox)
      const b64 = png.split(',')[1] || '';
      const approxBytes = Math.floor((b64.length * 3) / 4);
      if (approxBytes > 900000){
        return res.status(413).json({ ok:false, error:'La imagen es muy grande. Probá de nuevo.' });
      }

      const uid = uidOf(req.user);

      try{
        await run(
          `UPDATE users SET avatarUrl=?, instagram_username=NULL WHERE id=? OR email=?`,
          [png, uid, uid]
        );
      }catch(_){
        await run(
          `UPDATE users SET avatarUrl=? WHERE id=? OR email=?`,
          [png, uid, uid]
        );
      }

      if (req.user) req.user.avatarUrl = png;

      return res.json({ ok:true, avatarUrl: png });
    }catch(e){
      console.error('POST /app/perfil/avatar/generated error:', e);
      return res.status(500).json({ ok:false, error:'No se pudo guardar el avatar' });
    }
  }
);

module.exports = router;
