// routes/groups.js
// Chats de Grupos por materia, separados por tipo:
// - tipo=finales  -> "Final de <Materia>"
// - tipo=cursos   -> "Cursada de <Materia>"
// Reseteos:
// - finales: mismas fechas actuales (más veces)
// - cursos: 01/01 y 01/08 de cada año a las 23:59 (hora Argentina)

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const { all, get, run } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');

/* =====================================
   0) Helpers “anti-libsql Unsupported type”
===================================== */
function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toStr(v, fallback = '') {
  if (v === undefined || v === null) return fallback;
  return String(v);
}
function pickLastId(rs) {
  const raw =
    (rs && (rs.lastInsertRowid ?? rs.lastID ?? rs.lastId ?? rs.last_insert_rowid)) ??
    null;
  try {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  return 0;
}

/* =====================================
   1) Helpers de SSE (chat en vivo)
===================================== */
const sseChannels = new Map(); // "subjectId:chat_type" -> Set(res)

function normChatType(v) {
  const t = String(v || '').toLowerCase().trim();
  return t === 'cursos' ? 'cursos' : 'finales';
}

function sseKey(subjectId, chatType) {
  return `${String(subjectId)}:${normChatType(chatType)}`;
}

function broadcast(subjectId, chatType, payloadObj) {
  const subs = sseChannels.get(sseKey(subjectId, chatType));
  if (!subs) return;

  const data = `data: ${JSON.stringify(payloadObj)}\n\n`;

  for (const res of subs) {
    try {
      res.write(data);
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {}
  }
}

function subscribe(subjectId, chatType, res) {
  const key = sseKey(subjectId, chatType);
  if (!sseChannels.has(key)) sseChannels.set(key, new Set());
  sseChannels.get(key).add(res);
  res.on('close', () => {
    const set = sseChannels.get(key);
    if (set) set.delete(res);
  });
}

/* =====================================
   2) Subidas de archivos del chat (filesystem local)
   Nota: Si querés compartir adjuntos entre Koyeb/Render,
   conviene mover esto a R2 también.
===================================== */
/* =====================================
   2) Subidas de archivos del chat (R2)
===================================== */
const R2_PUBLIC_BASE = String(process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '');
const chatR2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
  }
});

function safeUploadName(originalname) {
  return String(originalname || 'archivo').replace(/[^\w.\- ()áéíóúñÁÉÍÓÚ]/g, '_');
}

function imageFilter(req, file, cb) {
  const ok = file && /^image\//i.test(file.mimetype || '');
  cb(null, !!ok);
}

const DOC_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

function docsFilter(req, file, cb) {
  let ok = false;
  if (file && file.mimetype) ok = DOC_MIMES.has(file.mimetype);
  if (!ok && file && file.originalname) {
    ok = /\.(pdf|doc|docx|ppt|pptx)$/i.test(String(file.originalname).toLowerCase());
  }
  cb(null, !!ok);
}

async function putChatFileToR2(subjectId, file, folder) {
  if (!process.env.R2_ENDPOINT || !process.env.R2_BUCKET || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE) {
    throw new Error('Storage (R2) no configurado');
  }

  const safe = safeUploadName(file.originalname || 'archivo');
  const key = `chat/${toInt(subjectId)}/${folder}/${Date.now()}-${Math.random().toString(16).slice(2)}-${safe}`;

  await chatR2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || 'application/octet-stream',
    CacheControl: 'public, max-age=31536000, immutable'
  }));

  return `${R2_PUBLIC_BASE}/${key}`;
}

const uploadPhotos = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFilter,
  limits: { fileSize: 12 * 1024 * 1024 }
}).array('photos', 5);

const uploadDocs = multer({
  storage: multer.memoryStorage(),
  fileFilter: docsFilter,
  limits: { fileSize: 20 * 1024 * 1024 }
}).array('docs', 5);

/* ===================================================
   3) Reseteo global (miembros + mensajes) por calendario
=================================================== */

// ===== Reset de FINALES (igual que tu comportamiento actual) =====
const RESET_DATES_FINALES = [
  { m: 1,  d: 15 },
  { m: 2,  d: 17 },
  { m: 3,  d: 17 },
  { m: 4,  d: 17 },
  { m: 6,  d: 17 },
  { m: 7,  d: 20 },
  { m: 8,  d: 17 },
  { m: 9,  d: 17 },
  { m: 11, d: 15 },
];

// ===== Reset de CURSOS (2 veces al año) =====
// 01/01 y 01/08, a las 23:59 hora Argentina
const RESET_DATES_CURSOS = [
  { m: 1, d: 1 },
  { m: 8, d: 1 },
];

const TZ_AR = 'America/Argentina/Buenos_Aires';

async function getAppState(key) {
  try {
    const row = await get(`SELECT value FROM app_state WHERE key = ?`, [toStr(key)]);
    return row ? toStr(row.value, '') : '';
  } catch (e) {
    console.error('getAppState error:', e);
    return '';
  }
}

/**
 * ✅ FIX CRÍTICO:
 * En libSQL a veces no vienen rowsAffected/chances.
 * Antes devolvías "now === v" y eso daba TRUE siempre (reset en cada request).
 * Ahora: primero leo el valor anterior; si NO cambió => false; si cambió => upsert y true.
 */
async function setAppStateIfChanged(key, value) {
  const k = toStr(key);
  const v = toStr(value);

  try {
    const prev = await get(`SELECT value FROM app_state WHERE key = ?`, [k]);
    const prevVal = prev ? toStr(prev.value, '') : '';

    if (prevVal === v) return false;

    await run(
      `
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
      `,
      [k, v]
    );

    return true;
  } catch (e) {
    console.error('setAppStateIfChanged error:', e);
    return false;
  }
}

/**
 * ✅ FIX extra:
 * El HEAD a Google a veces cuelga => UI “cargando”.
 * Metemos timeout y fallback a Date() local.
 */
function getInternetNowUTC() {
  return new Promise((resolve) => {
    const req = https.request(
      { method: 'HEAD', host: 'www.google.com', path: '/', timeout: 2500 },
      (res) => {
        const dateHeader = res.headers['date'];
        if (dateHeader) {
          const d = new Date(dateHeader);
          if (!isNaN(d.getTime())) return resolve(d);
        }
        resolve(new Date());
      }
    );

    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      resolve(new Date());
    });

    req.on('error', () => resolve(new Date()));
    req.end();
  });
}

// Cache simple para evitar 2 HEAD por request (TTL 60s)
let __internetNowCache = { at: 0, value: null };
async function getInternetNowUTC_cached() {
  const now = Date.now();
  if (__internetNowCache.value && (now - __internetNowCache.at) < 60000) return __internetNowCache.value;
  const d = await getInternetNowUTC();
  __internetNowCache = { at: now, value: d };
  return d;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function ymdKey(dateUtc) {
  const y = dateUtc.getUTCFullYear();
  const m = pad2(dateUtc.getUTCMonth() + 1);
  const d = pad2(dateUtc.getUTCDate());
  return `${y}-${m}-${d}`;
}

function formatDDMMYYYY(dateUtc, timeZone = TZ_AR) {
  try {
    return new Intl.DateTimeFormat('es-AR', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(dateUtc);
  } catch (_) {
    const dd = pad2(dateUtc.getUTCDate());
    const mm = pad2(dateUtc.getUTCMonth() + 1);
    const yyyy = String(dateUtc.getUTCFullYear());
    return `${dd}/${mm}/${yyyy}`;
  }
}

// ---- FINALES (23:59 UTC) ----
function nextResetDateUTC(nowUtc, dates) {
  const y = nowUtc.getUTCFullYear();
  const candidates = [];
  for (const { m, d } of dates) candidates.push(new Date(Date.UTC(y, m - 1, d, 23, 59, 0, 0)));
  for (const { m, d } of dates) candidates.push(new Date(Date.UTC(y + 1, m - 1, d, 23, 59, 0, 0)));
  candidates.sort((a, b) => a - b);
  for (const c of candidates) if (c.getTime() > nowUtc.getTime()) return c;
  return new Date(Date.UTC(y + 1, 0, 15, 23, 59, 0, 0));
}

function currentResetSlotUTC(nowUtc, dates) {
  const y = nowUtc.getUTCFullYear();
  const allDates =
    dates.map(({ m, d }) => new Date(Date.UTC(y, m - 1, d, 23, 59, 0, 0)))
      .concat(dates.map(({ m, d }) => new Date(Date.UTC(y - 1, m - 1, d, 23, 59, 0, 0))))
      .sort((a, b) => a - b);

  let slot = null;
  for (const c of allDates) {
    if (c.getTime() <= nowUtc.getTime()) slot = c;
    else break;
  }
  return slot;
}

// ---- CURSOS (23:59 hora Argentina => -03:00) ----
function makeDateAt2359ART(year, m, d) {
  const yyyy = String(year);
  const mm = pad2(m);
  const dd = pad2(d);
  return new Date(`${yyyy}-${mm}-${dd}T23:59:00-03:00`);
}

function localNowART(nowUtc) {
  return new Date(nowUtc.getTime() - (3 * 60 * 60 * 1000));
}

function nextResetDateART(nowUtc) {
  const ln = localNowART(nowUtc);
  const y = ln.getUTCFullYear();
  const candidates = [];
  for (const { m, d } of RESET_DATES_CURSOS) candidates.push(makeDateAt2359ART(y, m, d));
  for (const { m, d } of RESET_DATES_CURSOS) candidates.push(makeDateAt2359ART(y + 1, m, d));
  candidates.sort((a, b) => a - b);
  for (const c of candidates) if (c.getTime() > nowUtc.getTime()) return c;
  return makeDateAt2359ART(y + 1, 1, 1);
}

function ymdKeyFromParts(y, m, d) {
  return `${String(y)}-${pad2(m)}-${pad2(d)}`;
}

function currentResetSlotART(nowUtc) {
  const ln = localNowART(nowUtc);
  const y = ln.getUTCFullYear();
  const all = [];
  for (const { m, d } of RESET_DATES_CURSOS) all.push({ y, m, d, dateUtc: makeDateAt2359ART(y, m, d) });
  for (const { m, d } of RESET_DATES_CURSOS) all.push({ y: y - 1, m, d, dateUtc: makeDateAt2359ART(y - 1, m, d) });
  all.sort((a, b) => a.dateUtc - b.dateUtc);

  let slot = null;
  for (const c of all) {
    if (c.dateUtc.getTime() <= nowUtc.getTime()) slot = c;
    else break;
  }
  if (!slot) return null;
  return { dateUtc: slot.dateUtc, key: ymdKeyFromParts(slot.y, slot.m, slot.d) };
}

async function doGlobalGroupsReset(chatType) {
  const t = normChatType(chatType);
  await run(
    `DELETE FROM group_messages
      WHERE COALESCE(NULLIF(chat_type,''), 'finales') = ?`,
    [toStr(t)]
  );
  await run(
    `DELETE FROM group_members
      WHERE COALESCE(NULLIF(chat_type,''), 'finales') = ?`,
    [toStr(t)]
  );
  console.log(`✅ Reset de grupos aplicado (${t}) (mensajes + miembros).`);
}

async function maybeResetFinales(req, res, next) {
  try {
    const nowUtc = await getInternetNowUTC_cached();
    const slot = currentResetSlotUTC(nowUtc, RESET_DATES_FINALES);
    if (!slot) return next();

    const key = ymdKey(slot);
    const shouldReset = await setAppStateIfChanged('groups_last_reset_key_finales', key);
    if (shouldReset) await doGlobalGroupsReset('finales');
    return next();
  } catch (e) {
    console.error('maybeResetFinales error:', e);
    return next();
  }
}

async function maybeResetCursos(req, res, next) {
  try {
    const nowUtc = await getInternetNowUTC_cached();
    const slot = currentResetSlotART(nowUtc);
    if (!slot) return next();

    const key = toStr(slot.key);
    const shouldReset = await setAppStateIfChanged('groups_last_reset_key_cursos', key);
    if (shouldReset) await doGlobalGroupsReset('cursos');
    return next();
  } catch (e) {
    console.error('maybeResetCursos error:', e);
    return next();
  }
}

/* ===================================================
   4) Router
=================================================== */
module.exports = () => {
  const router = express.Router();

  // Reseteos por tipo
  router.use(maybeResetFinales);
  router.use(maybeResetCursos);

  function currentUser(req) {
    return req.user || req.session.user || null;
  }

  // GET /app/grupos/reset-info?tipo=finales|cursos
  router.get('/reset-info', async (req, res) => {
    try {
      const nowUtc = await getInternetNowUTC_cached();
      const tipo = normChatType(req.query.tipo);
      const next = (tipo === 'cursos')
        ? nextResetDateART(nowUtc)
        : nextResetDateUTC(nowUtc, RESET_DATES_FINALES);

      return res.json({
        ok: true,
        nextResetDateISO: next.toISOString(),
        nextResetDateText: formatDDMMYYYY(next, TZ_AR),
        note: (tipo === 'cursos')
          ? 'El reseteo ocurre a las 23:59 (hora Argentina) de ese día.'
          : 'El reseteo ocurre a las 23:59 (UTC) de ese día.'
      });
    } catch (e) {
      console.error('GET /app/grupos/reset-info error:', e);
      return res.json({ ok: false });
    }
  });

  /* =========================
     LISTA DE GRUPOS
  ========================= */
  // GET /app/grupos?tab=mis|cursos|finales&year=0..5&q=texto
  router.get('/', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect('/login');

    const tabRaw = String(req.query.tab || 'mis').toLowerCase();
    const tab = (tabRaw === 'cursos' || tabRaw === 'finales') ? tabRaw : 'mis';
    const year = parseInt(req.query.year || '0', 10) || 0;
    const q = String(req.query.q || '').trim();

    const career = normalizeCareer(user.career || '');
    const plan = parseInt(user.plan, 10) || 0;

    try {
      const myRows = await all(
        `SELECT subject_id, chat_type
           FROM group_members
          WHERE user_id = ?`,
        [toInt(user.id)]
      );
      const membership = new Set(myRows.map(r => `${toInt(r.subject_id)}:${normChatType(r.chat_type)}`));

      let groups = [];

      if (tab === 'mis') {
        groups = await all(
          `
          WITH my_groups AS (
            SELECT DISTINCT
                   subject_id,
                   chat_type
              FROM group_members
             WHERE user_id = ?
          ),
          member_counts AS (
            SELECT gm.subject_id,
                   gm.chat_type AS chat_type,
                   COUNT(*) AS miembros
              FROM group_members gm
              JOIN my_groups mg
                ON mg.subject_id = gm.subject_id
               AND mg.chat_type = gm.chat_type
             GROUP BY gm.subject_id, gm.chat_type
          ),
          last_message_ids AS (
            SELECT m.subject_id,
                   m.chat_type AS chat_type,
                   MAX(m.id) AS last_message_id
              FROM group_messages m
              JOIN my_groups mg
                ON mg.subject_id = m.subject_id
               AND mg.chat_type = m.chat_type
             GROUP BY m.subject_id, m.chat_type
          )
          SELECT
            s.id, s.name, s.year, s.career, s.plan,
            mg.chat_type,
            COALESCE(mc.miembros, 0) AS miembros,
            lm.text AS last_msg_text,
            lm.created_at AS last_msg_at
          FROM my_groups mg
          JOIN subjects s ON s.id = mg.subject_id
          LEFT JOIN member_counts mc
            ON mc.subject_id = mg.subject_id
           AND mc.chat_type = mg.chat_type
          LEFT JOIN last_message_ids lmi
            ON lmi.subject_id = mg.subject_id
           AND lmi.chat_type = mg.chat_type
          LEFT JOIN group_messages lm ON lm.id = lmi.last_message_id
          WHERE s.career = ?
            AND s.plan   = ?
            AND (? = '' OR LOWER(s.name) LIKE '%' || LOWER(?) || '%')
          ORDER BY
            COALESCE(lmi.last_message_id, 0) DESC,
            s.year ASC, COALESCE(s.name,'') ASC
          `,
          [toInt(user.id), career, plan, q, q]
        );
      } else {
        const tipo = normChatType(tab);
        groups = await all(
          `
          WITH member_counts AS (
            SELECT subject_id, COUNT(*) AS miembros
              FROM group_members
             WHERE chat_type = ?
             GROUP BY subject_id
          ),
          last_message_ids AS (
            SELECT subject_id, MAX(id) AS last_message_id
              FROM group_messages
             WHERE chat_type = ?
             GROUP BY subject_id
          )
          SELECT
            s.id, s.name, s.year, s.career, s.plan,
            COALESCE(mc.miembros, 0) AS miembros,
            lm.text AS last_msg_text,
            lm.created_at AS last_msg_at
          FROM subjects s
          LEFT JOIN member_counts mc ON mc.subject_id = s.id
          LEFT JOIN last_message_ids lmi ON lmi.subject_id = s.id
          LEFT JOIN group_messages lm ON lm.id = lmi.last_message_id
          WHERE s.career = ?
            AND s.plan   = ?
            AND (? = 0 OR s.year = ?)
            AND (? = '' OR LOWER(s.name) LIKE '%' || LOWER(?) || '%')
          ORDER BY s.year ASC, COALESCE(s.name,'') ASC
          `,
          [toStr(tipo), toStr(tipo), career, plan, year, year, q, q]
        );
      }

      res.render('grupos', {
        title: 'Grupos',
        user,
        tab,
        year,
        q,
        groups,
        membership
      });
    } catch (e) {
      console.error('GET /app/grupos error:', e);
      res.status(500).send('No se pudo cargar Grupos');
    }
  });

  /* =========================
     UNIRSE A GRUPO
  ========================= */
  router.post('/:subjectId/unirse', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).json({ ok: false, error: 'ID inválido' });

    const subject = await get(`SELECT id, name, career, plan FROM subjects WHERE id = ?`, [toInt(subjectId)]);
    if (!subject) return res.status(404).json({ ok: false, error: 'Materia no encontrada' });

    const career = normalizeCareer(user.career || '');
    const plan = parseInt(user.plan, 10) || 0;
    if (normalizeCareer(subject.career || '') !== career || parseInt(subject.plan, 10) !== plan) {
      return res.status(403).json({ ok: false, error: 'No podés unirte a grupos de otra carrera/plan' });
    }

    try {
      await run(
        `INSERT OR IGNORE INTO group_members (subject_id, user_id, chat_type, joined_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [toInt(subjectId), toInt(user.id), toStr(chatType)]
      );
      return res.json({ ok: true, joined: true });
    } catch (e) {
      console.error('POST join error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo unir' });
    }
  });

  /* =========================
     VER CHAT DE UN GRUPO
  ========================= */
  router.get('/:subjectId', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect('/login');

    const chatType = normChatType(req.query.tipo);

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).send('ID inválido');

    let isMember = await get(
      `SELECT 1
         FROM group_members
        WHERE subject_id = ?
          AND user_id = ?
          AND chat_type = ?`,
      [toInt(subjectId), toInt(user.id), toStr(chatType)]
    );

    if (!isMember) {
      if (String(req.query.join || '') === '1') {
        try {
          await run(
            `INSERT OR IGNORE INTO group_members (subject_id, user_id, chat_type, joined_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
            [toInt(subjectId), toInt(user.id), toStr(chatType)]
          );
          isMember = { ok: 1 };
        } catch (_) {}
      } else {
        return res.redirect(`/app/grupos?tab=${chatType === 'cursos' ? 'cursos' : 'finales'}`);
      }
    }

    const subject = await get(
      `SELECT id, name, year, career, plan FROM subjects WHERE id = ?`,
      [toInt(subjectId)]
    );
    if (!subject) return res.status(404).send('Materia no encontrada');

    const messages = await all(
        `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                u.id as user_id, u.name as user_name
           FROM group_messages m
           JOIN users u ON u.id = m.user_id
          WHERE m.subject_id = ?
          AND m.chat_type = ?
         ORDER BY m.id ASC
         LIMIT 500`,
      [toInt(subjectId), toStr(chatType)]
    );

    const members = await all(
        `SELECT u.id, u.name, u.career, u.plan
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.subject_id = ?
          AND gm.chat_type = ?
          ORDER BY u.name COLLATE NOCASE ASC`,
      [toInt(subjectId), toStr(chatType)]
    );

    let nextResetText = '';
    try {
      const nowUtc = await getInternetNowUTC_cached();
      const next = (chatType === 'cursos')
        ? nextResetDateART(nowUtc)
        : nextResetDateUTC(nowUtc, RESET_DATES_FINALES);
      nextResetText = formatDDMMYYYY(next, TZ_AR);
    } catch (_) {
      nextResetText = '';
    }

    res.render('chat-group', {
      title: (chatType === 'cursos' ? 'Cursada de ' : 'Final de ') + (subject.name || 'Grupo') + ' · Grupo',
      user,
      subject,
      messages,
      members,
      nextResetText,
      tipo: chatType,
      bodyClass: 'cw-chat-page'
    });
  });

  /* =========================
     ENVIAR MENSAJE
  ========================= */
  router.post('/:subjectId/messages', express.urlencoded({ extended: true }), async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

    const subjectId = parseInt(req.params.subjectId, 10);
    const rawText = (req.body && (req.body.text ?? req.body.message)) ?? '';
    const text = toStr(rawText, '').trim().slice(0, 2000);

    if (!subjectId) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!text) return res.status(400).json({ ok: false, error: 'Vacío' });

    const isMember = await get(
      `SELECT 1
         FROM group_members
        WHERE subject_id = ?
          AND user_id = ?
          AND chat_type = ?`,
      [toInt(subjectId), toInt(user.id), toStr(chatType)]
    );
    if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

    try {
      const rs = await run(
        `INSERT INTO group_messages (subject_id, user_id, text, created_at, chat_type)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [toInt(subjectId), toInt(user.id), toStr(text), toStr(chatType)]
      );

      let lastId = pickLastId(rs);
      if (!lastId) {
        const row = await get(
          `SELECT id
             FROM group_messages
            WHERE subject_id = ?
              AND user_id = ?
              AND chat_type = ?
            ORDER BY id DESC
            LIMIT 1`,
          [toInt(subjectId), toInt(user.id), toStr(chatType)]
        );
        lastId = toInt(row && (row.id ?? row.ID ?? row.Id), 0);
      }
      if (!lastId) return res.status(500).json({ ok: false, error: 'No se pudo enviar' });

      const msg = await get(
        `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                u.id as user_id, u.name as user_name
           FROM group_messages m
           JOIN users u ON u.id = m.user_id
          WHERE m.id = ?`,
        [toInt(lastId)]
      );

      broadcast(subjectId, chatType, { type: 'message', payload: msg });
      return res.json({ ok: true, message: msg });
    } catch (e) {
      console.error('POST message error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo enviar' });
    }
  });

  /* =========================
     ELIMINAR MENSAJE (definitivo, propio)
  ========================= */
  async function deleteOwnMessage(req, res) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

    const subjectId = parseInt(req.params.subjectId, 10);
    const id = parseInt(req.params.id, 10);
    if (!subjectId || !id) return res.status(400).json({ ok: false, error: 'Datos inválidos' });

    try {
      const row = await get(
        `SELECT id, user_id, attachment_url
           FROM group_messages
          WHERE id = ?
            AND subject_id = ?
            AND chat_type = ?`,
        [toInt(id), toInt(subjectId), toStr(chatType)]
      );
      if (!row) return res.status(404).json({ ok: false, error: 'Mensaje no encontrado' });
      if (Number(row.user_id) !== Number(user.id)) {
        return res.status(403).json({ ok: false, error: 'No podés eliminar mensajes de otros' });
      }

      await run(
        `DELETE FROM group_messages
          WHERE id = ?
            AND subject_id = ?
            AND user_id = ?
            AND chat_type = ?`,
        [toInt(id), toInt(subjectId), toInt(user.id), toStr(chatType)]
      );

      broadcast(subjectId, chatType, { type: 'message', payload: { kind: 'messages-deleted', ids: [toInt(id)] } });
      return res.json({ ok: true });
    } catch (e) {
      console.error('DELETE message error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo eliminar' });
    }
  }

  router.post('/:subjectId/messages/:id/delete', deleteOwnMessage);
  router.post('/:subjectId/message/:id/delete', deleteOwnMessage);

  /* =========================
     ELIMINAR MENSAJES (ADMIN, definitivo, múltiple)
  ========================= */
  async function adminBulkDelete(req, res) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });
    if (String(user.role) !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });

    const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

    const subjectId = parseInt(req.params.subjectId, 10);
    const idsRaw = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const ids = idsRaw.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n));

    if (!subjectId || !ids.length) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    }

    try {
      const isMember = await get(
        `SELECT 1
           FROM group_members
          WHERE subject_id = ?
            AND user_id = ?
            AND chat_type = ?`,
        [toInt(subjectId), toInt(user.id), toStr(chatType)]
      );
      if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

      const rows = await all(
        `SELECT id, attachment_url
           FROM group_messages
          WHERE subject_id = ?
            AND chat_type = ?
            AND id IN (${ids.map(() => '?').join(',')})`,
        [toInt(subjectId), toStr(chatType), ...ids.map(toInt)]
      );

      await run(
        `DELETE FROM group_messages
          WHERE subject_id = ?
            AND chat_type = ?
            AND id IN (${ids.map(() => '?').join(',')})`,
        [toInt(subjectId), toStr(chatType), ...ids.map(toInt)]
      );

      broadcast(subjectId, chatType, { type: 'message', payload: { kind: 'messages-deleted', ids } });
      return res.json({ ok: true, ids });
    } catch (e) {
      console.error('bulk-delete error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo eliminar' });
    }
  }

  router.post('/:subjectId/messages/bulk-delete', express.json(), adminBulkDelete);
  // Alias legacy
  router.post('/:subjectId/mensajes/bulk-delete', express.json(), adminBulkDelete);

  /* =========================
     Upload de FOTOS
  ========================= */
  router.post('/:subjectId/upload/photos', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

  const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

  const subjectId = parseInt(req.params.subjectId, 10);
  if (!Number.isFinite(subjectId)) return res.status(400).json({ ok: false, error: 'ID inválido' });

  const isMember = await get(
    `SELECT 1
       FROM group_members
      WHERE subject_id = ?
        AND user_id = ?
        AND chat_type = ?`,
    [toInt(subjectId), toInt(user.id), toStr(chatType)]
  );
  if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

  uploadPhotos(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: 'Error al subir (tamaño o tipo)' });
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ ok: false, error: 'No se envió imagen' });

      const created = [];
      for (const f of files) {
        const relUrl = await putChatFileToR2(subjectId, f, 'images');
        const rs = await run(
          `INSERT INTO group_messages (subject_id, user_id, text, attachment_url, attachment_type, created_at, chat_type)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
          [toInt(subjectId), toInt(user.id), '📷 Foto', toStr(relUrl), 'image', toStr(chatType)]
        );

        let lastId = pickLastId(rs);
        if (!lastId) {
          const row = await get(
            `SELECT id
               FROM group_messages
              WHERE subject_id = ?
                AND user_id = ?
                AND chat_type = ?
              ORDER BY id DESC
              LIMIT 1`,
            [toInt(subjectId), toInt(user.id), toStr(chatType)]
          );
          lastId = toInt(row && row.id, 0);
        }

        const msg = await get(
          `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                  u.id as user_id, u.name as user_name
             FROM group_messages m
             JOIN users u ON u.id = m.user_id
            WHERE m.id = ?`,
          [toInt(lastId)]
        );

        created.push(msg);
        broadcast(subjectId, chatType, { type: 'message', payload: msg });
      }

      return res.json({ ok: true, messages: created });
    } catch (e) {
      console.error('upload photos error', e);
      return res.status(500).json({ ok: false, error: 'No se pudo subir' });
    }
  });
});

  /* =========================
     Upload de DOCS
  ========================= */
  router.post('/:subjectId/upload/docs', async (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

  const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

  const subjectId = parseInt(req.params.subjectId, 10);
  if (!Number.isFinite(subjectId)) return res.status(400).json({ ok: false, error: 'ID inválido' });

  const isMember = await get(
    `SELECT 1
       FROM group_members
      WHERE subject_id = ?
        AND user_id = ?
        AND chat_type = ?`,
    [toInt(subjectId), toInt(user.id), toStr(chatType)]
  );
  if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

  uploadDocs(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: 'Error al subir (tamaño o tipo)' });
    try {
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ ok: false, error: 'No se envió archivo' });

      const created = [];
      for (const f of files) {
        const relUrl = await putChatFileToR2(subjectId, f, 'docs');
        const baseName = path.basename(f.originalname || 'archivo');
        const rs = await run(
          `INSERT INTO group_messages (subject_id, user_id, text, attachment_url, attachment_type, created_at, chat_type)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
          [toInt(subjectId), toInt(user.id), toStr(baseName), toStr(relUrl), 'doc', toStr(chatType)]
        );

        let lastId = pickLastId(rs);
        if (!lastId) {
          const row = await get(
            `SELECT id
               FROM group_messages
              WHERE subject_id = ?
                AND user_id = ?
                AND chat_type = ?
              ORDER BY id DESC
              LIMIT 1`,
            [toInt(subjectId), toInt(user.id), toStr(chatType)]
          );
          lastId = toInt(row && row.id, 0);
        }

        const msg = await get(
          `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                  u.id as user_id, u.name as user_name
             FROM group_messages m
             JOIN users u ON u.id = m.user_id
            WHERE m.id = ?`,
          [toInt(lastId)]
        );

        created.push(msg);
        broadcast(subjectId, chatType, { type: 'message', payload: msg });
      }

      return res.json({ ok: true, messages: created });
    } catch (e) {
      console.error('upload docs error', e);
      return res.status(500).json({ ok: false, error: 'No se pudo subir' });
    }
  });
});

  /* =========================
     SSE (stream)
  ========================= */
  // GET /app/grupos/:subjectId/stream?tipo=finales|cursos
  router.get('/:subjectId/stream', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).end();

    const chatType = normChatType(req.query.tipo);

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).end();

    const isMember = await get(
      `SELECT 1
         FROM group_members
        WHERE subject_id = ?
          AND user_id = ?
          AND chat_type = ?`,
      [toInt(subjectId), toInt(user.id), toStr(chatType)]
    );
    if (!isMember) return res.status(403).end();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');
    res.flushHeaders?.();

    // abre el stream inmediatamente
    try {
      res.write(': connected\n\n');
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {}

    const ping = setInterval(() => {
      try {
        res.write('event: ping\ndata: {}\n\n');
        if (typeof res.flush === 'function') res.flush();
      } catch (_) {}
    }, 25000);

    try {
      const last50 = await all(
        `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                u.id as user_id, u.name as user_name
           FROM group_messages m
           JOIN users u ON u.id = m.user_id
          WHERE m.subject_id = ?
            AND m.chat_type = ?
          ORDER BY m.id DESC
          LIMIT 50`,
        [toInt(subjectId), toStr(chatType)]
      );
      res.write(`event: history\ndata: ${JSON.stringify(last50.reverse())}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {}

    subscribe(subjectId, chatType, res);
    req.on('close', () => clearInterval(ping));
  });

  /* =========================
     MEMBERS JSON
  ========================= */
  // GET /app/grupos/:subjectId/members.json?tipo=...
  router.get('/:subjectId/members.json', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false });

    const chatType = normChatType(req.query.tipo);

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).json({ ok: false });

    const isMember = await get(
      `SELECT 1
         FROM group_members
        WHERE subject_id = ?
          AND user_id = ?
          AND chat_type = ?`,
      [toInt(subjectId), toInt(user.id), toStr(chatType)]
    );
    if (!isMember) return res.status(403).json({ ok: false });

    try {
      const members = await all(
        `SELECT u.id, u.name, u.career, u.plan
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.subject_id = ?
            AND gm.chat_type = ?
          ORDER BY u.name COLLATE NOCASE ASC`,
        [toInt(subjectId), toStr(chatType)]
      );
      res.json({ ok: true, members });
    } catch (e) {
      console.error('members.json error:', e);
      res.json({ ok: false, members: [] });
    }
  });

  /* =========================
     QUITAR MIEMBRO (solo admin)
  ========================= */
  async function kickMember(req, res) {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ ok: false, error: 'No auth' });
    if (String(me.role) !== 'admin') return res.status(403).json({ ok: false, error: 'Solo para administradores' });

    const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

    const subjectId = parseInt(req.params.subjectId, 10);
    const userId = parseInt(req.params.userId, 10);
    if (!subjectId || !userId) {
      return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
    }

    try {
      await run(
        `DELETE FROM group_members
          WHERE subject_id = ?
            AND user_id = ?
            AND chat_type = ?`,
        [toInt(subjectId), toInt(userId), toStr(chatType)]
      );
      broadcast(subjectId, chatType, { type: 'message', payload: { kind: 'member-removed', user_id: toInt(userId) } });
      return res.json({ ok: true });
    } catch (e) {
      console.error('kick member error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo quitar al miembro' });
    }
  }

  router.post('/:subjectId/miembros/:userId/quitar', kickMember);
  router.post('/:subjectId/members/:userId/kick', kickMember);
  router.post('/:subjectId/kick/:userId', kickMember);

  /* =========================
     SALIR DEL GRUPO
  ========================= */
  // POST /app/grupos/:subjectId/salir?tipo=...
  async function leaveGroup(req, res) {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const chatType = normChatType(req.query.tipo || (req.body && req.body.tipo));

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).json({ ok: false, error: 'ID inválido' });

    try {
      await run(
        `DELETE FROM group_members
          WHERE subject_id = ?
            AND user_id = ?
            AND chat_type = ?`,
        [toInt(subjectId), toInt(user.id), toStr(chatType)]
      );
      return res.json({ ok: true });
    } catch (e) {
      console.error('leave group error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo salir del grupo' });
    }
  }

  router.post('/:subjectId/salir', leaveGroup);
  router.post('/:subjectId/leave', leaveGroup);
  router.post('/:subjectId/members/leave', leaveGroup);

  return router;
};
