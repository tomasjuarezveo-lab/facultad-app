// routes/grupos.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const { all, get, run } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');

/* =====================================
   1) Helpers de SSE (chat en vivo)
===================================== */
const sseChannels = new Map(); // subjectId -> Set(res)

function broadcast(subjectId, payload) {
  const subs = sseChannels.get(String(subjectId));
  if (!subs) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    try { res.write(data); } catch (_) {}
  }
}

function subscribe(subjectId, res) {
  const key = String(subjectId);
  if (!sseChannels.has(key)) sseChannels.set(key, new Set());
  sseChannels.get(key).add(res);
  res.on('close', () => {
    const set = sseChannels.get(key);
    if (set) set.delete(res);
  });
}

/* =====================================
   2) Subidas de archivos del chat
===================================== */
const CHAT_BASE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'chat');
try { fs.mkdirSync(CHAT_BASE_DIR, { recursive: true }); } catch (_) {}

function makeStorageFor(subjectId) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(CHAT_BASE_DIR, String(subjectId));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const orig = String(file.originalname || 'archivo');
      const safe = orig.replace(/[^\w.\- ()áéíóúñÁÉÍÓÚ]/g, '_');
      const dot = safe.lastIndexOf('.');
      const base = dot >= 0 ? safe.slice(0, dot) : safe;
      const ext  = dot >= 0 ? safe.slice(dot)    : '';
      cb(null, `${base}-${Date.now()}${ext}`);
    }
  });
}

// Filtros
function imageFilter(req, file, cb) {
  const ok = file && /^image\//i.test(file.mimetype);
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
    ok = /\.(pdf|doc|docx|ppt|pptx)$/i.test(file.originalname.toLowerCase());
  }
  cb(null, !!ok);
}

/* ===================================================
   3) Reseteo global (miembros + mensajes) por calendario
   - Fechas fijas cada año, siempre a las 23:59 (UTC)
   - Usa fecha/hora de internet (cabecera Date de un host público)
   - Efecto global para TODOS los grupos (todas las carreras/planes)
=================================================== */

// Fechas (mes 1..12, día)
const RESET_DATES = [
  { m: 1,  d: 15 }, // 15 enero
  { m: 2,  d: 17 }, // 17 febrero
  { m: 3,  d: 17 }, // 17 marzo
  { m: 4,  d: 17 }, // 17 abril
  { m: 6,  d: 17 }, // 17 junio
  { m: 7,  d: 20 }, // 20 julio
  { m: 8,  d: 17 }, // 17 agosto
  { m: 9,  d: 17 }, // 17 septiembre
  { m: 11, d: 15 }, // 15 noviembre
];

// Archivo de “último reseteo hecho” (para no repetir el mismo día)
const RESET_STATE_DIR = path.join(__dirname, '..', 'data', 'groups');
const RESET_STATE_FILE = path.join(RESET_STATE_DIR, 'reset_state.json');
try { fs.mkdirSync(RESET_STATE_DIR, { recursive: true }); } catch (_){}

function readResetState() {
  try {
    return JSON.parse(fs.readFileSync(RESET_STATE_FILE, 'utf8'));
  } catch {
    return { lastResetKey: null }; // ej: "2025-08-17"
  }
}
function writeResetState(state) {
  try {
    fs.writeFileSync(RESET_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('writeResetState error:', e);
  }
}

// Obtener “ahora” en UTC desde internet (cabecera Date)
function getInternetNowUTC() {
  return new Promise((resolve) => {
    const req = https.request(
      { method: 'HEAD', host: 'www.google.com', path: '/' },
      (res) => {
        const dateHeader = res.headers['date'];
        if (dateHeader) {
          const d = new Date(dateHeader);
          if (!isNaN(d.getTime())) {
            return resolve(d); // UTC
          }
        }
        resolve(new Date()); // fallback local
      }
    );
    req.on('error', () => resolve(new Date())); // fallback
    req.end();
  });
}

// Devuelve el objeto Date UTC de la próxima fecha de reset (23:59 UTC)
function nextResetDateUTC(nowUtc) {
  const y = nowUtc.getUTCFullYear();

  // Candidatos: este año y el siguiente
  const candidates = [];
  for (const { m, d } of RESET_DATES) {
    const dt = new Date(Date.UTC(y, m - 1, d, 23, 59, 0, 0)); // 23:59:00 UTC
    candidates.push(dt);
  }
  for (const { m, d } of RESET_DATES) {
    const dt = new Date(Date.UTC(y + 1, m - 1, d, 23, 59, 0, 0));
    candidates.push(dt);
  }
  candidates.sort((a, b) => a - b);

  for (const c of candidates) {
    if (c.getTime() > nowUtc.getTime()) return c;
  }
  // Fallback
  return new Date(Date.UTC(y + 1, 0, 15, 23, 59, 0, 0));
}

// Devuelve la fecha de reset “vigente” (la más reciente cuyo instante <= now), si existe.
function currentResetSlotUTC(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const all = RESET_DATES.map(({ m, d }) => new Date(Date.UTC(y, m - 1, d, 23, 59, 0, 0)))
    .concat(RESET_DATES.map(({ m, d }) => new Date(Date.UTC(y - 1, m - 1, d, 23, 59, 0, 0))))
    .sort((a, b) => a - b);

  let slot = null;
  for (const c of all) {
    if (c.getTime() <= nowUtc.getTime()) slot = c;
    else break;
  }
  return slot;
}

function ymdKey(dateUtc) {
  const y = dateUtc.getUTCFullYear();
  const m = String(dateUtc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dateUtc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Ejecuta reseteo global (borra mensajes y miembros de todos los grupos)
async function doGlobalGroupsReset() {
  // Estas tablas deben existir:
  // - group_messages(subject_id, user_id, text, created_at, attachment_url, attachment_type, id PK)
  // - group_members(subject_id, user_id, joined_at, PK compuesto)
  await run(`DELETE FROM group_messages`, []);
  await run(`DELETE FROM group_members`, []);
  console.log('✅ Reset global de grupos aplicado (mensajes + miembros).');
}

// Middleware: en cualquier request de /app/grupos/*,
// verifica contra hora de internet si corresponde reseteo global.
async function maybeResetGlobal(req, res, next) {
  try {
    const nowUtc = await getInternetNowUTC();
    const slot = currentResetSlotUTC(nowUtc); // fecha de reset “vigente” (si ya pasó)
    if (!slot) return next();

    const key = ymdKey(slot); // ej: "2025-09-17"
    const state = readResetState();

    if (state.lastResetKey !== key) {
      // Si no aplicamos aún el reseteo para este “día clave”, lo hacemos ahora.
      await doGlobalGroupsReset();
      state.lastResetKey = key;
      writeResetState(state);
    }
    return next();
  } catch (e) {
    console.error('maybeResetGlobal error:', e);
    return next(); // no bloqueamos si falla
  }
}

/* ===================================================
   4) Router
=================================================== */
module.exports = (deps = {}) => {
  const router = express.Router();

  // Aplica el middleware de reseteo a todo el módulo /app/grupos/*
  router.use(maybeResetGlobal);

  // Helper user
  function currentUser(req) {
    return req.user || req.session.user || null;
  }

  // ======= Endpoint para “próxima fecha de reseteo” (para UI) =======
  // GET /app/grupos/reset-info
  router.get('/reset-info', async (req, res) => {
    try {
      const nowUtc = await getInternetNowUTC();
      const next = nextResetDateUTC(nowUtc);
      const dd = String(next.getUTCDate()).padStart(2, '0');
      const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = String(next.getUTCFullYear());
      // siempre mostrar sin hora, y aclarar que es a las 23:59 (UTC)
      return res.json({
        ok: true,
        nextResetDateISO: next.toISOString(),
        nextResetDateText: `${dd}/${mm}/${yyyy}`,
        note: 'El reseteo ocurre a las 23:59 (UTC) de ese día.'
      });
    } catch (e) {
      console.error('GET /app/grupos/reset-info error:', e);
      return res.json({ ok: false });
    }
  });

  /* =========================
     LISTA DE GRUPOS
  ========================= */
  // GET /app/grupos?tab=mis|explorar&year=0..5&q=texto
  router.get('/', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect('/login');

    const tab = (req.query.tab || 'mis').toLowerCase() === 'explorar' ? 'explorar' : 'mis';
    const year = parseInt(req.query.year || '0', 10) || 0;
    const q    = (req.query.q || '').trim();

    const career = normalizeCareer(user.career || '');
    const plan   = parseInt(user.plan, 10) || 0;

    try {
      const myRows = await all(`SELECT subject_id FROM group_members WHERE user_id = ?`, [user.id]);
      const membership = new Set(myRows.map(r => r.subject_id));

      let groups = [];
      if (tab === 'mis') {
        groups = await all(
          `
          SELECT
            s.id, s.name, s.year, s.career, s.plan,
            (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.subject_id = s.id) AS miembros,
            (SELECT m.text FROM group_messages m WHERE m.subject_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_msg_text,
            (SELECT m.created_at FROM group_messages m WHERE m.subject_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_msg_at
          FROM subjects s
          JOIN group_members gm ON gm.subject_id = s.id
          WHERE gm.user_id = ?
            AND s.career = ?
            AND s.plan   = ?
            AND (? = '' OR LOWER(s.name) LIKE '%' || LOWER(?) || '%')
          ORDER BY 
            COALESCE((SELECT m.id FROM group_messages m WHERE m.subject_id = s.id ORDER BY m.id DESC LIMIT 1), 0) DESC,
            s.year ASC, COALESCE(s.name,'') ASC
          `,
          [user.id, career, plan, q, q]
        );
      } else {
        groups = await all(
          `
          SELECT
            s.id, s.name, s.year, s.career, s.plan,
            (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.subject_id = s.id) AS miembros,
            (SELECT m.text FROM group_messages m WHERE m.subject_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_msg_text,
            (SELECT m.created_at FROM group_messages m WHERE m.subject_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_msg_at
          FROM subjects s
          WHERE s.career = ?
            AND s.plan   = ?
            AND (? = 0 OR s.year = ?)
            AND (? = '' OR LOWER(s.name) LIKE '%' || LOWER(?) || '%')
          ORDER BY s.year ASC, COALESCE(s.name,'') ASC
          `,
          [career, plan, year, year, q, q]
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

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).json({ ok: false, error: 'ID inválido' });

    const subject = await get(`SELECT id, name, career, plan FROM subjects WHERE id = ?`, [subjectId]);
    if (!subject) return res.status(404).json({ ok: false, error: 'Materia no encontrada' });

    const career = normalizeCareer(user.career || '');
    const plan   = parseInt(user.plan, 10) || 0;
    if (normalizeCareer(subject.career || '') !== career || parseInt(subject.plan, 10) !== plan) {
      return res.status(403).json({ ok: false, error: 'No podés unirte a grupos de otra carrera/plan' });
    }

    try {
      await run(
        `INSERT OR IGNORE INTO group_members (subject_id, user_id, joined_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
        [subjectId, user.id]
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

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).send('ID inválido');

    // ¿Miembro?
    let isMember = await get(
      `SELECT 1 FROM group_members WHERE subject_id = ? AND user_id = ?`,
      [subjectId, user.id]
    );
    if (!isMember) {
      if (req.query.join === '1') {
        try {
          await run(
            `INSERT OR IGNORE INTO group_members (subject_id, user_id, joined_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
            [subjectId, user.id]
          );
          isMember = { 1: 1 };
        } catch (_) {}
      } else {
        return res.redirect(`/app/grupos?tab=explorar`);
      }
    }

    const subject = await get(
      `SELECT id, name, year, career, plan FROM subjects WHERE id = ?`,
      [subjectId]
    );
    if (!subject) return res.status(404).send('Materia no encontrada');

    const messages = await all(
      `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
              u.id as user_id, u.name as user_name
         FROM group_messages m
         JOIN users u ON u.id = m.user_id
        WHERE m.subject_id = ?
        ORDER BY m.id ASC
        LIMIT 500`,
      [subjectId]
    );

    const members = await all(
      `SELECT u.id, u.name, u.career, u.plan
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.subject_id = ?
        ORDER BY u.name COLLATE NOCASE ASC`,
      [subjectId]
    );

    // Texto de próxima fecha de reseteo (por si querés mostrarlo directo en la vista)
    let nextResetText = '';
    try {
      const nowUtc = await getInternetNowUTC();
      const next = nextResetDateUTC(nowUtc);
      const dd = String(next.getUTCDate()).padStart(2, '0');
      const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = String(next.getUTCFullYear());
      nextResetText = `${dd}/${mm}/${yyyy}`; // (el evento ocurre a las 23:59 UTC)
    } catch (_) {
      nextResetText = '';
    }

    res.render('chat-group', {
      title: (subject.name || 'Grupo') + ' · Grupo',
      user,
      subject,
      messages,
      members,
      nextResetText
    });
  });

  /* =========================
     ENVIAR MENSAJE
  ========================= */
  router.post('/:subjectId/messages', express.urlencoded({ extended: true }), async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const subjectId = parseInt(req.params.subjectId, 10);
    const text = String(req.body.text || '').trim().slice(0, 2000);
    if (!subjectId) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!text) return res.status(400).json({ ok: false, error: 'Vacío' });

    const isMember = await get(
      `SELECT 1 FROM group_members WHERE subject_id = ? AND user_id = ?`,
      [subjectId, user.id]
    );
    if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

    try {
      const rs = await run(
        `INSERT INTO group_messages (subject_id, user_id, text, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [subjectId, user.id, text]
      );
      const msg = await get(
        `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                u.id as user_id, u.name as user_name
           FROM group_messages m
           JOIN users u ON u.id = m.user_id
          WHERE m.id = ?`,
        [rs.lastID]
      );
      broadcast(subjectId, { type: 'message', payload: msg });
      return res.json({ ok: true, message: msg });
    } catch (e) {
      console.error('POST message error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo enviar' });
    }
  });

  /* =========================
   BORRADO MASIVO DE MENSAJES (solo admin)
  ========================= */
  router.post('/:subjectId/mensajes/bulk-delete', express.json(), async (req, res) => {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ ok: false, error: 'No auth' });
    if (me.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo para administradores' });

    const subjectId = parseInt(req.params.subjectId, 10);
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
    if (!subjectId || !ids.length) {
      return res.status(400).json({ ok: false, error: 'Faltan parámetros' });
    }

    try {
      // IMPORTANTE: ajustá el nombre de la tabla si en tu schema difiere.
      // Suele ser group_messages / messages / chat_messages
      const placeholders = ids.map(() => '?').join(',');
      await run(`DELETE FROM group_messages WHERE subject_id = ? AND id IN (${placeholders})`, [subjectId, ...ids]);

      // Aviso SSE opcional a clientes conectados
      broadcast(subjectId, { type: 'message', payload: { kind: 'bulk-delete', ids } });

      return res.json({ ok: true, deleted: ids });
    } catch (e) {
      console.error('bulk-delete error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo borrar' });
    }
  });

  /* =========================
     ELIMINAR MENSAJE (suave)
  ========================= */
  router.post('/:subjectId/messages/:id/delete', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const subjectId = parseInt(req.params.subjectId, 10);
    const id = parseInt(req.params.id, 10);
    if (!subjectId || !id) return res.status(400).json({ ok: false, error: 'Datos inválidos' });

    try {
      const row = await get(
        `SELECT id, user_id FROM group_messages WHERE id = ? AND subject_id = ?`,
        [id, subjectId]
      );
      if (!row) return res.status(404).json({ ok: false, error: 'Mensaje no encontrado' });
      if (Number(row.user_id) !== Number(user.id)) {
        return res.status(403).json({ ok: false, error: 'No podés eliminar mensajes de otros' });
      }

      const deletedText = 'Este mensaje fue eliminado por su creador.';
      await run(`UPDATE group_messages SET text = ? WHERE id = ?`, [deletedText, id]);

      const upd = await get(
        `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                u.id as user_id, u.name as user_name
           FROM group_messages m
           JOIN users u ON u.id = m.user_id
          WHERE m.id = ?`,
        [id]
      );
      broadcast(subjectId, { type: 'update', payload: upd });
      return res.json({ ok: true, message: upd });
    } catch (e) {
      console.error('DELETE message error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo eliminar' });
    }
  });

  /* =========================
   ELIMINAR MENSAJES (ADMIN, definitivo, múltiple)
  ========================= */
  router.post('/:subjectId/messages/bulk-delete', express.json(), async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });
    if (String(user.role) !== 'admin') return res.status(403).json({ ok: false, error: 'Solo admin' });

    const subjectId = parseInt(req.params.subjectId, 10);
    const idsRaw = Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = idsRaw.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n));

    if (!subjectId || !ids.length) {
      return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    }

    try {
      // Verificá que el admin sea miembro del grupo (consistente con el resto de endpoints)
      const isMember = await get(
        `SELECT 1 FROM group_members WHERE subject_id = ? AND user_id = ?`,
        [subjectId, user.id]
      );
      if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

      // Traemos los adjuntos (si hay) para intentar limpiarlos del disco
      const rows = await all(
        `SELECT id, attachment_url 
          FROM group_messages 
          WHERE subject_id = ? 
            AND id IN (${ids.map(() => '?').join(',')})`,
        [subjectId, ...ids]
      );

      // Borrado definitivo
      await run(
        `DELETE FROM group_messages 
          WHERE subject_id = ? 
            AND id IN (${ids.map(() => '?').join(',')})`,
        [subjectId, ...ids]
      );

      // Limpieza de archivos subidos (best-effort)
      for (const r of rows) {
        if (r.attachment_url) {
          const abs = path.join(__dirname, '..', 'public', r.attachment_url.replace(/^\//, ''));
          fs.unlink(abs, () => {});
        }
      }

      // Aviso por SSE para que otros clientes saquen del DOM
      broadcast(subjectId, { type: 'message', payload: { kind: 'messages-deleted', ids } });
      return res.json({ ok: true, ids });
    } catch (e) {
      console.error('bulk-delete error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo eliminar' });
    }
  });

  /* =========================
     Upload de FOTOS
  ========================= */
  router.post('/:subjectId/upload/photos', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!Number.isFinite(subjectId)) return res.status(400).json({ ok: false, error: 'ID inválido' });

    const isMember = await get(
      `SELECT 1 FROM group_members WHERE subject_id = ? AND user_id = ?`,
      [subjectId, user.id]
    );
    if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

    const storage = makeStorageFor(subjectId);
    const upload = multer({
      storage,
      fileFilter: imageFilter,
      limits: { fileSize: 12 * 1024 * 1024 }
    }).array('photos', 5);

    upload(req, res, async (err) => {
      if (err) return res.status(400).json({ ok: false, error: 'Error al subir (tamaño o tipo)' });
      try {
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ ok: false, error: 'No se envió imagen' });
        const created = [];
        for (const f of files) {
          const relUrl = `/uploads/chat/${subjectId}/${path.basename(f.path)}`;
          const rs = await run(
            `INSERT INTO group_messages (subject_id, user_id, text, attachment_url, attachment_type, created_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [subjectId, user.id, '📷 Foto', relUrl, 'image']
          );
          const msg = await get(
            `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                    u.id as user_id, u.name as user_name
               FROM group_messages m
               JOIN users u ON u.id = m.user_id
              WHERE m.id = ?`,
            [rs.lastID]
          );
          created.push(msg);
          broadcast(subjectId, { type: 'message', payload: msg });
        }
        return res.json({ ok: true, messages: created });
      } catch (e) {
        console.error('upload photos error', e);
        return res.status(500).json({ ok: false, error: 'No se pudo subir' });
      }
    });
  });

  /* =========================
     Upload de DOCS (pdf/doc/docx/ppt/pptx)
  ========================= */
  router.post('/:subjectId/upload/docs', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!Number.isFinite(subjectId)) return res.status(400).json({ ok: false, error: 'ID inválido' });

    const isMember = await get(
      `SELECT 1 FROM group_members WHERE subject_id = ? AND user_id = ?`,
      [subjectId, user.id]
    );
    if (!isMember) return res.status(403).json({ ok: false, error: 'No sos miembro' });

    const storage = makeStorageFor(subjectId);
    const upload = multer({
      storage,
      fileFilter: docsFilter,
      limits: { fileSize: 20 * 1024 * 1024 }
    }).array('docs', 5);

    upload(req, res, async (err) => {
      if (err) return res.status(400).json({ ok: false, error: 'Error al subir (tamaño o tipo)' });
      try {
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ ok: false, error: 'No se envió archivo' });
        const created = [];
        for (const f of files) {
          const relUrl = `/uploads/chat/${subjectId}/${path.basename(f.path)}`;
          const baseName = path.basename(f.originalname || path.basename(f.path));
          const rs = await run(
            `INSERT INTO group_messages (subject_id, user_id, text, attachment_url, attachment_type, created_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [subjectId, user.id, baseName, relUrl, 'doc']
          );
          const msg = await get(
            `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                    u.id as user_id, u.name as user_name
               FROM group_messages m
               JOIN users u ON u.id = m.user_id
              WHERE m.id = ?`,
            [rs.lastID]
          );
          created.push(msg);
          broadcast(subjectId, { type: 'message', payload: msg });
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
  // GET /app/grupos/:subjectId/stream
  router.get('/:subjectId/stream', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).end();
    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).end();

    const isMember = await get(
      `SELECT 1 FROM group_members WHERE subject_id = ? AND user_id = ?`,
      [subjectId, user.id]
    );
    if (!isMember) return res.status(403).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // ping
    const ping = setInterval(() => {
      try { res.write('event: ping\ndata: {}\n\n'); } catch (_) {}
    }, 25000);

    try {
      const last50 = await all(
        `SELECT m.id, m.text, m.created_at, m.attachment_url, m.attachment_type,
                u.id as user_id, u.name as user_name
           FROM group_messages m
           JOIN users u ON u.id = m.user_id
          WHERE m.subject_id = ?
          ORDER BY m.id DESC
          LIMIT 50`,
        [subjectId]
      );
      res.write(`event: history\ndata: ${JSON.stringify(last50.reverse())}\n\n`);
    } catch (_) {}

    subscribe(subjectId, res);
    req.on('close', () => clearInterval(ping));
  });

  /* =========================
     MEMBERS JSON
  ========================= */
  router.get('/:subjectId/members.json', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false });

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).json({ ok: false });

    const isMember = await get(
      `SELECT 1 FROM group_members WHERE subject_id = ? AND user_id = ?`,
      [subjectId, user.id]
    );
    if (!isMember) return res.status(403).json({ ok: false });

    try {
      const members = await all(
        `SELECT u.id, u.name, u.career, u.plan
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.subject_id = ?
          ORDER BY u.name COLLATE NOCASE ASC`,
        [subjectId]
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
  router.post('/:subjectId/miembros/:userId/quitar', async (req, res) => {
    const me = currentUser(req);
    if (!me) return res.status(401).json({ ok: false, error: 'No auth' });
    if (me.role !== 'admin') return res.status(403).json({ ok: false, error: 'Solo para administradores' });

    const subjectId = parseInt(req.params.subjectId, 10);
    const userId    = parseInt(req.params.userId, 10);
    if (!subjectId || !userId) {
      return res.status(400).json({ ok: false, error: 'Parámetros inválidos' });
    }

    try {
      await run(`DELETE FROM group_members WHERE subject_id = ? AND user_id = ?`, [subjectId, userId]);
      // Aviso por SSE (opcional): otros clientes pueden reaccionar si lo deseás
      broadcast(subjectId, { type: 'message', payload: { kind: 'member-removed', user_id: userId } });
      return res.json({ ok: true });
    } catch (e) {
      console.error('kick member error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo quitar al miembro' });
    }
  });

  /* =========================
     SALIR DEL GRUPO
  ========================= */
  router.post('/:subjectId/salir', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'No auth' });

    const subjectId = parseInt(req.params.subjectId, 10);
    if (!subjectId) return res.status(400).json({ ok: false, error: 'ID inválido' });

    try {
      await run(`DELETE FROM group_members WHERE subject_id = ? AND user_id = ?`, [subjectId, user.id]);
      return res.json({ ok: true });
    } catch (e) {
      console.error('leave group error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo salir del grupo' });
    }
  });

  // No hay endpoints de avatar de grupo (queda ícono/inicial).
  return router;
};
