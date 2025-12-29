const express = require('express');  
const { all, get, run } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');

module.exports = (deps = {}) => {
  const router = express.Router();
  const ensureAdmin =
    deps.ensureAdmin ||
    ((req, res, next) => {
      // Guard mínimo por si no se inyecta ensureAdmin desde fuera
      if (req.user && req.user.role === 'admin') return next();
      return res.status(403).send('Solo para administradores');
    });

  // Helper: obtener usuario de forma segura
  function safeUser(req) {
    const u = req.user || {};
    return {
      id: u.id ?? 0,
      role: u.role || 'user',
      career: normalizeCareer(u.career || ''),
      plan: Number.isInteger(u.plan) ? u.plan : parseInt(u.plan || '0', 10) || 0
    };
  }

  // =========================
  // Grupos (Mis grupos vs Explorar)
  // =========================
  router.get('/grupos', async (req, res) => {
    try {
      const user = safeUser(req);
      if (!user.id) return res.redirect('/login');

      // Lee parámetros que espera la vista
      const tab = (req.query.tab === 'explorar') ? 'explorar' : 'mis';
      const year = Number.isInteger(parseInt(req.query.year, 10))
        ? parseInt(req.query.year, 10)
        : 0; // 0 = todos
      const q = (req.query.q || '').toString().trim().toLowerCase();

      // ¿Existe la tabla de mensajes?
      const hasGmTable = await get(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='group_messages'`
      );

      // Mis grupos: materias donde soy miembro (con último mensaje si hay tabla)
      let myGroups;
      if (hasGmTable) {
        myGroups = await all(
          `
          SELECT 
            s.*,
            gm.joined_at,
            lm.last_msg_text,
            lm.last_msg_at
          FROM subjects s
          JOIN group_members gm
            ON gm.subject_id = s.id
           AND gm.user_id   = ?
          LEFT JOIN (
            SELECT g.subject_id,
                   g.text       AS last_msg_text,
                   g.created_at AS last_msg_at
            FROM group_messages g
            JOIN (
                SELECT subject_id, MAX(created_at) AS max_ts
                FROM group_messages
                GROUP BY subject_id
            ) t ON t.subject_id = g.subject_id
               AND t.max_ts     = g.created_at
          ) lm ON lm.subject_id = s.id
          WHERE s.career = ? AND s.plan = ?
          ORDER BY 
            COALESCE(lm.last_msg_at, '') DESC,  -- primero los con actividad reciente
            s.year, s.name
          `,
          [user.id, user.career, user.plan]
        );
      } else {
        // Fallback sin últimos mensajes
        myGroups = await all(
          `
          SELECT s.*, gm.joined_at
            FROM subjects s
            JOIN group_members gm
              ON gm.subject_id = s.id
             AND gm.user_id   = ?
           WHERE s.career = ? AND s.plan = ?
           ORDER BY s.year, s.name
          `,
          [user.id, user.career, user.plan]
        );
      }

      // Explorar: materias de la carrera/plan donde NO soy miembro
      const exploreGroups = await all(
        `
        SELECT s.*
          FROM subjects s
         WHERE s.career = ?
           AND s.plan   = ?
           AND NOT EXISTS (
                 SELECT 1
                   FROM group_members gm
                  WHERE gm.subject_id = s.id
                    AND gm.user_id    = ?
           )
         ORDER BY s.year, s.name
        `,
        [user.career, user.plan, user.id]
      );

      // Aplico filtros (year, q) según tab
      function applyFilters(list) {
        let out = list;
        if (year && Number.isInteger(year)) {
          out = out.filter(r => parseInt(r.year || '0', 10) === year);
        }
        if (q) {
          out = out.filter(r => String(r.name || '').toLowerCase().includes(q));
        }
        return out;
      }

      const groups = (tab === 'mis')
        ? applyFilters(myGroups)
        : applyFilters(exploreGroups);

      return res.render('grupos', {
        title: 'Grupos',
        // lo que la vista espera:
        tab,
        year,
        q,
        groups,
        // útiles en layout
        carrera: user.career,
        plan: user.plan,
        user: req.user || {}
      });
    } catch (err) {
      console.error('GET /app/grupos error:', err);
      return res.status(500).send('Error cargando grupos');
    }
  });
  

  // =========================
  // Materias (home) — filtro por career/plan (admin puede forzar por query)
  // =========================
  router.get('/materias', async (req, res) => {
    try {
      const user = safeUser(req);
      let career = user.career;
      let plan = user.plan;

      if (user.role === 'admin' && (req.query.career || req.query.plan)) {
        if (req.query.career) career = normalizeCareer(String(req.query.career));
        if (req.query.plan) plan = parseInt(req.query.plan, 10) || 0;
      }

            // ✅ Auto-fix: asegurar tabla subjects en Turso (por si init no la creó todavía)
      await run(`
        CREATE TABLE IF NOT EXISTS subjects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          career TEXT,
          plan TEXT,
          year INTEGER,
          name TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);

      const subjects = await all(
        `SELECT * FROM subjects WHERE career=? AND plan=? ORDER BY year, name`,
        [career, plan]
      );

      let adminFilters = null;
      if (user.role === 'admin') {
        const careersRows = await all(
          `SELECT DISTINCT career FROM (
            SELECT career FROM subjects
            UNION
            SELECT career FROM users
          ) WHERE career IS NOT NULL AND TRIM(career) <> '' ORDER BY career`
        );
        const plansRows = await all(
          `SELECT DISTINCT plan FROM (
            SELECT plan FROM subjects
            UNION
            SELECT plan FROM users
          ) WHERE plan IS NOT NULL ORDER BY plan`
        );

        adminFilters = {
          careers: careersRows.map((r) => normalizeCareer(r.career)),
          plans: plansRows.map((r) => r.plan),
          selectedCareer: career,
          selectedPlan: plan
        };
      }

      return res.render('materias', {
        title: 'Materias · iOS',
        subjects,
        adminFilters,
        carrera: career,
        plan
      });
    } catch (err) {
      console.error('GET /app/materias error:', err);
      return res.status(500).send('Error listando materias');
    }
  });

  // =========================
  // Crear materia
  // =========================
  router.post('/materias', ensureAdmin, async (req, res) => {
    try {
      const { name, year, career, plan } = req.body;

      const r = await run(
        `INSERT INTO subjects (name, year, career, plan) VALUES (?,?,?,?)`,
        [name, parseInt(year, 10) || null, normalizeCareer(career), parseInt(plan, 10) || 0]
      );
      const subjectId = r.lastID;

      const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

      const cursada = toArr(req.body['prereq_cursada[]'] || req.body.prereq_cursada);
      const finalReq = toArr(req.body['prereq_final[]'] || req.body.prereq_final);

      for (const depId of cursada) {
        const idNum = parseInt(depId, 10);
        if (!Number.isNaN(idNum))
          await run(
            `INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
            [subjectId, idNum, 'cursada']
          );
      }
      for (const depId of finalReq) {
        const idNum = parseInt(depId, 10);
        if (!Number.isNaN(idNum))
          await run(
            `INSERT INTO correlatives (subject_id, depends_on_id, req_type) VALUES (?,?,?)`,
            [subjectId, idNum, 'final']
          );
      }

      return res.redirect('/app/materias');
    } catch (err) {
      console.error('POST /app/materias error:', err);
      return res.status(500).send('Error creando materia');
    }
  });

  // =========================
  // Renombrar materia
  // =========================
  router.post('/materias/:id/rename', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');
      await run(`UPDATE subjects SET name=? WHERE id=?`, [req.body.name, id]);
      return res.redirect('/app/materias');
    } catch (err) {
      console.error('POST /app/materias/:id/rename error:', err);
      return res.status(500).send('Error renombrando materia');
    }
  });

  // =========================
  // Eliminar materia
  // =========================
  router.post('/materias/:id/delete', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');
      await run(`DELETE FROM subjects WHERE id=?`, [id]);
      return res.redirect('/app/materias');
    } catch (err) {
      console.error('POST /app/materias/:id/delete error:', err);
      return res.status(500).send('Error eliminando materia');
    }
  });

  // =========================
  // Vista de materia (con agrupado de “resúmenes” por doc_group y nivel)
  // =========================
router.get('/materias/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send('ID inválido');

    const user = safeUser(req);
    let subject;

    if (user.role === 'admin') {
      subject = await get(`SELECT * FROM subjects WHERE id=?`, [id]);
    } else {
      subject = await get(
        `SELECT * FROM subjects WHERE id=? AND career=? AND plan=?`,
        [id, user.career, user.plan]
      );
    }
    if (!subject) return res.status(404).send('Materia no encontrada');

    const VALID_CATS = new Set([
      'parciales',
      'finales',
      'trabajos',
      'bibliografia',
      'resumenes',
      'clases'
    ]);
    let category = String(req.query.category || 'parciales').toLowerCase();
    if (!VALID_CATS.has(category)) category = 'parciales';

    // Chequeo de columnas opcionales (soporta DBs con group_uid o doc_group)
    const hasLevelRow = await get(
      `SELECT 1 ok FROM pragma_table_info('documents') WHERE name='level'`
    );
    const hasGroupUidRow = await get(
      `SELECT 1 ok FROM pragma_table_info('documents') WHERE name='group_uid'`
    );
    const hasDocGroupRow = await get(
      `SELECT 1 ok FROM pragma_table_info('documents') WHERE name='doc_group'`
    );
    const hasLevel = !!hasLevelRow;
    const hasAnyGroup = !!hasGroupUidRow || !!hasDocGroupRow;

    const VALID_LEVELS = new Set(['completo', 'mediano', 'facil']);
    let level = String(req.query.level || 'completo').toLowerCase();
    if (!VALID_LEVELS.has(level)) level = 'completo';

    const docs = await all(
      `SELECT * FROM documents WHERE subject_id=? AND category=? ORDER BY created_at DESC, id DESC`,
      [id, category]
    );

    let groups = null;
    let activeDoc = null;

    if (category === 'resumenes') {
      // Agrupado por group_uid/doc_group (fallback: id)
      const map = new Map();
      const pickGroupId = (d) => {
        // Prioridad: group_uid → doc_group → g-<id>
        if (hasGroupUidRow && d.group_uid) return d.group_uid;
        if (hasDocGroupRow && d.doc_group) return d.doc_group;
        return `g-${d.id}`;
      };

      for (const d of docs) {
        const gid = hasAnyGroup ? pickGroupId(d) : `g-${d.id}`;
        if (!map.has(gid)) {
          map.set(gid, {
            group_uid: gid,
            title: d.title || 'Resumen',
            latest_at: d.created_at || null,
            // guardamos 1 por nivel
            versions: { completo: null, mediano: null, facil: null }
          });
        }
        const g = map.get(gid);
        if (!g.title && d.title) g.title = d.title;
        if (d.created_at && (!g.latest_at || d.created_at > g.latest_at)) {
          g.latest_at = d.created_at;
        }

        const lv = hasLevel ? (d.level || 'completo') : 'completo';
        if (!g.versions[lv]) g.versions[lv] = d;
      }

      groups = Array.from(map.values()).sort((a, b) =>
        (b.latest_at || '') > (a.latest_at || '') ? 1 : -1
      );

      // Selección de grupo/doc activo
      const gidParam = String(req.query.gid || '');
      const activeGroup =
        groups.find((g) => g.group_uid === gidParam) || groups[0] || null;

      if (activeGroup) {
        activeDoc =
          activeGroup.versions[level] ||
          activeGroup.versions.completo ||
          activeGroup.versions.mediano ||
          activeGroup.versions.facil ||
          null;
      }
    } else {
      // Categorías normales
      const activeDocId = req.query.doc ? parseInt(req.query.doc, 10) : (docs[0]?.id || null);
      activeDoc = activeDocId ? docs.find((d) => d.id === activeDocId) : null;
    }

    // Render principal (EJS subject.ejs debe generar el iframe a /pdf?file=... cuando exista activeDoc)
    return res.render('subject', {
      title: subject.name,
      subject,
      category,
      docs,      // solo para categorías normales
      groups,    // solo para resúmenes
      activeDoc,
      currentLevel: level,
      query: req.query, // útil para mantener parámetros en links
      carrera: user.career,
      plan: user.plan
    });
  } catch (err) {
    console.error('GET /app/materias/:id error:', err);
    return res.status(500).send('Error cargando la materia');
  }
});

  // =========================
  // Autoevaluaciones
  // =========================
  router.get('/autoevaluaciones', async (req, res) => {
    try {
      const user = safeUser(req);
      const subjects = await all(
        `SELECT * FROM subjects WHERE career=? AND plan=? ORDER BY year, name`,
        [user.career, user.plan]
      );
      return res.render('autoevaluaciones', {
        title: 'Autoevaluaciones',
        subjects,
        carrera: user.career,
        plan: user.plan
      });
    } catch (err) {
      console.error('GET /app/autoevaluaciones error:', err);
      return res.status(500).send('Error cargando autoevaluaciones');
    }
  });

  router.post('/autoevaluaciones/iniciar', async (req, res) => {
    try {
      const { subject_id } = req.body;
      const sid = parseInt(subject_id, 10);
      if (Number.isNaN(sid)) return res.status(400).json({ error: 'subject_id inválido' });

      const questions = await all(
        `SELECT * FROM quiz_questions WHERE subject_id=? ORDER BY RANDOM() LIMIT 5`,
        [sid]
      );
      return res.json({
        questions: questions.map((q) => ({
          id: q.id,
          q: q.q,
          a: q.a,
          b: q.b,
          c: q.c,
          d: q.d
        }))
      });
    } catch (err) {
      console.error('POST /app/autoevaluaciones/iniciar error:', err);
      return res.status(500).json({ error: 'Error iniciando autoevaluación' });
    }
  });

  router.post('/autoevaluaciones/responder', async (req, res) => {
    try {
      const user = safeUser(req);
      const { subject_id, answers } = req.body;
      const sid = parseInt(subject_id, 10);
      if (Number.isNaN(sid) || !Array.isArray(answers))
        return res.status(400).json({ error: 'Datos inválidos' });

      let correctCount = 0;
      for (const ans of answers) {
        const row = await get(`SELECT correct FROM quiz_questions WHERE id=?`, [ans.id]);
        if (row && row.correct === ans.choice) correctCount++;
      }
      const score = correctCount * 2;

      await run(
        `INSERT INTO quiz_attempts (user_id, subject_id, score, total, answers_json) VALUES (?,?,?,?,?)`,
        [user.id, sid, score, 10, JSON.stringify(answers)]
      );
      return res.json({ score, total: 10 });
    } catch (err) {
      console.error('POST /app/autoevaluaciones/responder error:', err);
      return res.status(500).json({ error: 'Error registrando respuestas' });
    }
  });

  // =========================
  // Juegos
  // =========================
  router.get('/juegos', async (req, res) => {
    try {
      const user = safeUser(req);
      const subjects = await all(
        `SELECT * FROM subjects WHERE career=? AND plan=? ORDER BY year, name`,
        [user.career, user.plan]
      );

      // Si NO está autenticado, NO crear fila y mostrar puntos = null
      let puntos = null;
      if (user.id) {
        const row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
        puntos = row ? Number(row.points||0) : 0;
        if (!row) {
          await run(`INSERT OR IGNORE INTO game_scores (user_id, points) VALUES (?, 0)`, [user.id]);
        }
      }

      return res.render('juegos', {
        title: 'Juegos',
        subjects,
        carrera: user.career,
        plan: user.plan,
        puntos
      });
    } catch (err) {
      console.error('GET /app/juegos error:', err);
      return res.status(500).send('Error cargando juegos');
    }
  });

  // =========================
  // Correlativas (reservado)
  // =========================

  // =========================
  // Finales
  // =========================
  router.get('/finales', async (req, res) => {
    try {
      const user = safeUser(req);

      // Mismos finales para todos (sin filtrar por carrera/plan) y SIN pasar params
      const rows = await all(
        `SELECT finals.*, subjects.name as subject_name
           FROM finals
           JOIN subjects ON subjects.id = finals.subject_id
          ORDER BY subjects.name`
      );

      // Lista de materias para el formulario (sin filtrar y SIN params)
      const subjects = await all(
        `SELECT * FROM subjects ORDER BY name`
      );

      return res.render('finales', {
        title: 'Finales',
        rows,
        subjects,
        carrera: user.career,
        plan: user.plan
      });
    } catch (err) {
      console.error('GET /app/finales error:', err);
      return res.status(500).send('Error cargando finales');
    }
  });

  router.post(
    '/finales',
    express.urlencoded({ extended: true }),  // 👈 asegura parseo del form
    ensureAdmin,
    async (req, res) => {
      try {
        // Aceptar múltiples nombres
        const subject_id =
          req.body.subject_id || req.body.materia_id || req.body.subject || req.body.materia;
        const sid = parseInt(subject_id, 10);
        if (Number.isNaN(sid)) return res.status(400).send('subject_id inválido');

        const year = (req.body.year ?? req.body.anio ?? req.body.año ?? '').toString().trim() || null;

        // 'escrito','oral','escrito y oral'
        const exam_type_raw = (req.body.exam_type ?? req.body.tipo ?? req.body.tipo_examen ?? '').toString().trim().toLowerCase();
        let exam_type = 'escrito';
        if (['escrito','oral','escrito y oral','escrito/oral','escrito+oral'].includes(exam_type_raw)) {
          exam_type = (exam_type_raw === 'escrito/oral' || exam_type_raw === 'escrito+oral') ? 'escrito y oral' : exam_type_raw;
        }

        // 'libre','regular'
        const modalidad_raw = (req.body.modalidad ?? req.body.modo ?? '').toString().trim().toLowerCase();
        const modalidad = (modalidad_raw === 'regular' || modalidad_raw === 'libre') ? modalidad_raw : 'regular';

        // checkbox
        const rendible = (req.body.rendible === 'on' || req.body.rendible === '1' || req.body.rendible === 1 || req.body.rendible === true) ? 1 : 0;

        await run(
          `INSERT INTO finals (subject_id, year, exam_type, modalidad, rendible) VALUES (?,?,?,?,?)`,
          [sid, year, exam_type, modalidad, rendible]
        );
        return res.redirect('/app/finales');
      } catch (err) {
        console.error('POST /app/finales error:', err);
        return res.status(500).send('Error creando final');
      }
    }
  );

  router.post(
    '/finales/:id/delete',
    express.urlencoded({ extended: true }),
    ensureAdmin,
    async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).send('ID inválido');
        await run(`DELETE FROM finals WHERE id=?`, [id]);
        return res.redirect('/app/finales');
      } catch (err) {
        console.error('POST /app/finales/:id/delete error:', err);
        return res.status(500).send('Error eliminando final');
      }
    }
  );

  // =========================
  // Profesores (paginado 5, filtro por estrellas, top del mes) — SIN filtrar por carrera/plan
  // =========================
  router.get('/profesores', async (req, res) => {
    try {
      const user = safeUser(req);
      const q = String(req.query.q || '').trim();
      const stars = parseInt(req.query.stars || '', 10) || null;

      // Paginación (se aplicará después de filtrar)
      const page = Math.max(1, parseInt(req.query.page || '1', 10));
      const pageSize = 5;

      // -------- Materias (para usar en la vista si hace falta) — ahora sin filtrar por carrera/plan
      const materiasRows = await all(
        `SELECT DISTINCT name FROM subjects ORDER BY name`
      );
      const materias = materiasRows.map(r => r.name);

      // -------- WHERE base para traer profesores (sin filtrar por carrera/plan)
      const whereParts = [];
      const params = [];
      if (q) {
        whereParts.push('p.name LIKE ?');
        params.push(`%${q}%`);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

      const profRows = await all(
        `
        SELECT p.id, p.name, p.photo_url, IFNULL(p.subjects_text,'') AS subjects_text
        FROM professors p
        ${where}
        ORDER BY p.name
        `,
        params
      );

      // -------- Armar objetos con promedios, métricas y comentarios
      const profesores = [];
      for (const p of profRows) {
        const stats = await get(
          `SELECT AVG(rating) AS avg, COUNT(*) AS count FROM reviews WHERE professor_id=?`,
          [p.id]
        );
        const avg = stats?.avg ? Number(stats.avg) : 0;
        const count = stats?.count ? Number(stats.count) : 0;

        // Promedios de sub-scores
        const metr = await get(
          `SELECT AVG(corre)  AS corre,
                  AVG(clases) AS clases,
                  AVG(onda)   AS onda
            FROM reviews
            WHERE professor_id=?`,
          [p.id]
        );

        // Comentario aleatorio directo (para mini-comentario)
        const randomComment = await get(
          `SELECT comment FROM reviews
            WHERE professor_id=? AND comment IS NOT NULL AND TRIM(comment)!=''
            ORDER BY RANDOM() LIMIT 1`,
          [p.id]
        );

        // Comentarios recientes para el modal
        const lastComments = await all(
          `SELECT rating AS stars,
                  comment,
                  strftime('%s', created_at) AS ts
            FROM reviews
            WHERE professor_id=? 
              AND comment IS NOT NULL
              AND TRIM(comment)!=''
            ORDER BY created_at DESC
            LIMIT 20`,
          [p.id]
        );

        profesores.push({
          id: p.id,
          name: p.name,
          photo_url: p.photo_url || '',
          subjects_text: p.subjects_text || '',
          avg,
          count,
          random_comment: randomComment?.comment || '',
          metrics: {
            corre:  metr?.corre  != null ? Math.round(Number(metr.corre))  : null,
            clases: metr?.clases != null ? Math.round(Number(metr.clases)) : null,
            onda:   metr?.onda   != null ? Math.round(Number(metr.onda))   : null
          },
          ratings: lastComments
        });
      }

      // -------- Top del mes (últimos 30 días) — ahora global (sin carrera/plan)
      let topMes = [];
      {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        const rows = await all(
          `
          SELECT
            p.id,
            p.name,
            p.photo_url,
            AVG(r.rating)        AS monthAvg,
            COUNT(r.id)          AS monthCount
          FROM professors p
          LEFT JOIN reviews r
            ON r.professor_id = p.id
          AND DATE(r.created_at) >= ?
          GROUP BY p.id
          HAVING monthCount > 0
          ORDER BY monthAvg DESC,
                  monthCount DESC,
                  p.name ASC
          LIMIT 5
          `,
          [cutoffStr]
        );

        topMes = rows.map((p) => ({
          id: p.id,
          nombre: p.name,
          avatar: (p.photo_url && p.photo_url.trim())
            ? p.photo_url
            : `https://ui-avatars.com/api/?name=${encodeURIComponent(p.name)}`,
          monthAvg: Number(p.monthAvg || 0),
          monthCount: Number(p.monthCount || 0)
        }));
      }

      // -------- Filtro por estrellas (sobre el promedio redondeado)
      let filtered = profesores;
      if (stars && stars >= 1 && stars <= 5) {
        filtered = profesores.filter(p => Math.round(p.avg || 0) === stars);
      }

      // -------- Paginación en memoria sobre el filtrado
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const start = (page - 1) * pageSize;
      const pageItems = filtered.slice(start, start + pageSize);

      return res.render('profesores', {
        title: 'Profesores',
        // estos dos los podés seguir pasando si el layout los usa, pero ya no influyen en el listado
        carrera: user.career,
        plan: user.plan,
        materias,
        q,
        stars,
        profesores: pageItems,
        page, totalPages, total,
        topMes: topMes || [],
        isAdmin: (user.role === 'admin')
      });
    } catch (err) {
      console.error('GET /app/profesores error:', err);
      return res.status(500).send('Error cargando profesores');
    }
  });

  // =========================
  // Crear profesor (acepta varios nombres de campos del form)
  // =========================
  router.post(
    '/profesores',
    express.urlencoded({ extended: true }),
    express.json(),
    ensureAdmin,
    async (req, res) => {
      try {
        // Aceptar variantes que suelen venir desde la vista
        const name =
          (req.body.name ?? req.body.nombre ?? '').toString().trim();
        const photo_url =
          (req.body.photo_url ?? req.body.foto_url ?? req.body.foto ?? '').toString().trim();
        const careerRaw =
          (req.body.career ?? req.body.carrera ?? '').toString().trim();
        const subjects_textRaw =
          (req.body.subjects_text ?? req.body.materias ?? req.body.asignaturas ?? '').toString().trim();
        const plan =
          parseInt((req.body.plan ?? req.body.plan_estudios ?? '0').toString(), 10) || 0;

        if (!name) {
          return res.status(400).send('El nombre del profesor es obligatorio');
        }

        // Si no vino carrera en el form, usar la del usuario logueado (admin puede estar filtrando por carrera/plan)
        const user = (req.user || {});
        const career = normalizeCareer(careerRaw || user.career || '');

        // subjects_text puede ser string o una lista desde el form (join con coma)
        let subjects_text = subjects_textRaw || null;
        if (!subjects_text && Array.isArray(req.body['subjects_text[]'])) {
          subjects_text = req.body['subjects_text[]'].filter(Boolean).join(', ');
        }
        if (!subjects_text && Array.isArray(req.body['materias[]'])) {
          subjects_text = req.body['materias[]'].filter(Boolean).join(', ');
        }

        await run(
          `INSERT INTO professors (name, photo_url, career, plan, subjects_text) VALUES (?,?,?,?,?)`,
          [name, photo_url || '', career, plan, subjects_text]
        );

        return res.redirect('/app/profesores');
      } catch (err) {
        console.error('POST /app/profesores error:', err);
        return res.status(500).send('Error creando profesor');
      }
    }
  );

  // =========================
  // Eliminar profesor
  // =========================
  router.post('/profesores/:id/delete', ensureAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).send('ID inválido');
      await run(`DELETE FROM professors WHERE id=?`, [id]);
      return res.redirect('/app/profesores');
    } catch (err) {
      console.error('POST /app/profesores/:id/delete error:', err);
      return res.status(500).send('Error eliminando profesor');
    }
  });

  // =========================
  // Crear/Reemplazar review (1 por usuario por profesor) — soporta JSON (modal) o form
  // =========================
  router.post(
    '/profesores/:id/review',
    express.json(),
    express.urlencoded({ extended: true }),
    async (req, res) => {
      try {
        const user = safeUser(req);
        if (!user || !user.id) {
          const wantsJson =
            req.xhr ||
            (req.get('accept') && req.get('accept').includes('application/json')) ||
            (req.is && req.is('application/json'));
          if (wantsJson) return res.status(401).json({ ok: false, error: 'No autenticado' });
        return res.redirect('/app/profesores');
        }

        const pid = parseInt(req.params.id, 10);
        if (Number.isNaN(pid)) {
          const wantsJson =
            req.xhr ||
            (req.get('accept') && req.get('accept').includes('application/json')) ||
            (req.is && req.is('application/json'));
          if (wantsJson) return res.status(400).json({ ok: false, error: 'ID inválido' });
          return res.status(400).send('ID inválido');
        }

        let rating = parseInt(req.body.stars || req.body.rating, 10);
        rating = Math.max(1, Math.min(5, rating || 0));
        const commentRaw = (req.body.comment ?? '').toString();
        const comment = commentRaw.trim() ? commentRaw.trim() : null;

        // sub-scores
        const corre  = Math.max(1, Math.min(10, parseInt(req.body.corre  ?? '0', 10) || 0));
        const clases = Math.max(1, Math.min(10, parseInt(req.body.clases ?? '0', 10) || 0));
        const onda   = Math.max(1, Math.min(10, parseInt(req.body.onda   ?? '0', 10) || 0));

        // Reemplazar la review previa del usuario para ese profe
        await run(`DELETE FROM reviews WHERE professor_id=? AND user_id=?`, [pid, user.id]);

        // Insertar con sub-scores
        await run(
          `INSERT INTO reviews (professor_id, user_id, rating, comment, corre, clases, onda)
           VALUES (?,?,?,?,?,?,?)`,
          [pid, user.id, rating, comment, corre || null, clases || null, onda || null]
        );

        // Respuesta (promedios de estrellas)
        const stats = await get(
          `SELECT AVG(rating) AS avg, COUNT(*) AS count FROM reviews WHERE professor_id=?`,
          [pid]
        );

        const wantsJson =
          req.xhr ||
          (req.get('accept') && req.get('accept').includes('application/json')) ||
          (req.is && req.is('application/json'));

        if (wantsJson) {
          return res.json({ ok: true, avg: stats?.avg || 0, count: stats?.count || 0 });
        }
        return res.redirect('/app/profesores');
      } catch (err) {
        console.error('POST /app/profesores/:id/review error:', err);
        const wantsJson =
          req.xhr ||
          (req.get('accept') && req.get('accept').includes('application/json')) ||
          (req.is && req.is('application/json'));
        if (wantsJson) return res.status(500).json({ ok: false, error: 'Error creando reseña' });
        return res.status(500).send('Error creando reseña');
      }
    }
  );

  // =========================
  // API alternativa para el modal (soporta el fetch PUT /api/profesores/:id/rate)
  // =========================
  router.put(
    '/api/profesores/:id/rate',
    express.json(),
    async (req, res) => {
      try {
        const user = safeUser(req);
        if (!user || !user.id) return res.status(401).json({ ok: false, error: 'No autenticado' });

        const pid = parseInt(req.params.id, 10);
        if (Number.isNaN(pid)) return res.status(400).json({ ok: false, error: 'ID inválido' });

        let rating = parseInt(req.body.stars || req.body.rating, 10);
        rating = Math.max(1, Math.min(5, rating || 0));
        const commentRaw = (req.body.comment ?? '').toString();
        const comment = commentRaw.trim() ? commentRaw.trim() : null;

        const corre  = Math.max(1, Math.min(10, parseInt(req.body.corre  ?? '0', 10) || 0));
        const clases = Math.max(1, Math.min(10, parseInt(req.body.clases ?? '0', 10) || 0));
        const onda   = Math.max(1, Math.min(10, parseInt(req.body.onda   ?? '0', 10) || 0));

        await run(`DELETE FROM reviews WHERE professor_id=? AND user_id=?`, [pid, user.id]);
        await run(
          `INSERT INTO reviews (professor_id, user_id, rating, comment, corre, clases, onda)
           VALUES (?,?,?,?,?,?,?)`,
          [pid, user.id, rating, comment, corre || null, clases || null, onda || null]
        );

        const stats = await get(
          `SELECT AVG(rating) AS avg, COUNT(*) AS count FROM reviews WHERE professor_id=?`,
          [pid]
        );
        return res.json({ ok: true, avg: stats?.avg || 0, count: stats?.count || 0 });
      } catch (err) {
        console.error('PUT /api/profesores/:id/rate error:', err);
        return res.status(500).json({ ok: false, error: 'Error creando reseña' });
      }
    }
  );

  // === API Puntos de Juegos ===

  // Devuelve puntos actuales del usuario autenticado
  router.get('/api/juegos/puntos', async (req, res) => {
    try {
      const user = safeUser(req);
      if (!user.id) return res.status(401).json({ ok:false, error:'No autenticado' });
      let row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
      if (!row) {
        await run(`INSERT OR IGNORE INTO game_scores (user_id, points) VALUES (?, 0)`, [user.id]);
        row = { points: 0 };
      }
      return res.json({ ok:true, points: Number(row.points||0) });
    } catch (e) {
      console.error('GET /api/juegos/puntos', e);
      return res.status(500).json({ ok:false, error:'Error leyendo puntos' });
    }
  });

  // Suma N puntos al usuario (body: {delta})
  router.post('/api/juegos/puntos/add', express.json(), async (req, res) => {
    try {
      const user = safeUser(req);
      if (!user.id) return res.status(401).json({ ok:false, error:'No autenticado' });
      const delta = parseInt(req.body.delta, 10) || 0;

      await run(`
        INSERT INTO game_scores (user_id, points)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          points = points + excluded.points,
          updated_at = CURRENT_TIMESTAMP
      `, [user.id, Math.max(delta,0)]);

      const row = await get(`SELECT points FROM game_scores WHERE user_id=?`, [user.id]);
      return res.json({ ok:true, points: Number(row.points||0) });
    } catch (e) {
      console.error('POST /api/juegos/puntos/add', e);
      return res.status(500).json({ ok:false, error:'Error actualizando puntos' });
    }
  });

  // Setea puntos exactos (opcional; body: {points})
  router.post('/api/juegos/puntos/set', express.json(), async (req, res) => {
    try {
      const user = safeUser(req);
      if (!user.id) return res.status(401).json({ ok:false, error:'No autenticado' });
      const points = Math.max(0, parseInt(req.body.points, 10) || 0);

      await run(`
        INSERT INTO game_scores (user_id, points)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          points = excluded.points,
          updated_at = CURRENT_TIMESTAMP
      `, [user.id, points]);

      return res.json({ ok:true, points });
    } catch (e) {
      console.error('POST /api/juegos/puntos/set', e);
      return res.status(500).json({ ok:false, error:'Error seteando puntos' });
    }
  });

  return router;
};