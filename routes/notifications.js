const express = require('express');
const { all, get, run } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');
const {
  ensureMetricsSchema,
  getAdminMetricsSummary,
  listAdminSuggestions,
  createUserSuggestion
} = require('../lib/appMetrics');

module.exports = ({ ensureAdmin } = {}) => {
  const router = express.Router();
  const requireAdmin = ensureAdmin || ((req, res, next) => next());

  router.get('/notifications', async (req, res) => {
    try {
      const user = req.user || {};
      const isAdmin = user.role === 'admin';
      const myCareer = normalizeCareer(String(user.career || '')) || '';
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

      let rows;
      if (isAdmin) {
        rows = await all(
          `
          SELECT n.id, n.body, n.careers, n.created_by, n.created_at, u.name AS admin_name
          FROM notifications n
          LEFT JOIN users u ON u.id = n.created_by
          ORDER BY n.created_at DESC
          LIMIT ?
          `,
          [limit]
        );
      } else if (myCareer) {
        rows = await all(
          `
          SELECT n.id, n.body, n.careers, n.created_by, n.created_at, u.name AS admin_name
          FROM notifications n
          LEFT JOIN users u ON u.id = n.created_by
          WHERE ',' || n.careers || ',' LIKE '%,' || ? || ',%'
          ORDER BY n.created_at DESC
          LIMIT ?
          `,
          [myCareer, limit]
        );
      } else {
        rows = await all(
          `
          SELECT n.id, n.body, n.careers, n.created_by, n.created_at, u.name AS admin_name
          FROM notifications n
          LEFT JOIN users u ON u.id = n.created_by
          ORDER BY n.created_at DESC
          LIMIT ?
          `,
          [limit]
        );
      }

      res.json({ items: rows || [] });
    } catch (e) {
      console.error('GET /app/notifications error:', e);
      res.status(500).json({ error: 'No se pudieron cargar las notificaciones' });
    }
  });

  router.post('/notifications', requireAdmin, async (req, res) => {
    try {
      const { text, careers } = req.body || {};
      const adminId = (req.user && req.user.id) || null;

      const body = String(text || '').trim();
      if (!body) return res.status(400).json({ error: 'El texto es obligatorio' });

      let selected = Array.isArray(careers) ? careers : [];
      selected = selected.map((c) => normalizeCareer(String(c || ''))).filter(Boolean);

      if (!selected.length) {
        return res.status(400).json({ error: 'Debe seleccionar al menos una carrera' });
      }

      await run(
        `
        INSERT INTO notifications (body, careers, created_by)
        VALUES (?, ?, ?)
        `,
        [body, selected.join(','), adminId]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('POST /app/notifications error:', e);
      res.status(500).json({ error: 'No se pudo crear la notificación' });
    }
  });

  router.delete('/notifications/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'ID inválido' });
      await run(`DELETE FROM notifications WHERE id = ?`, [id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /app/notifications/:id error:', e);
      res.status(500).json({ error: 'No se pudo eliminar la notificación' });
    }
  });

  router.get('/chatbot/kb', async (req, res) => {
    try {
      await ensureMetricsSchema();
      await run(`
        CREATE TABLE IF NOT EXISTS chatbot_kb (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          raw_text TEXT NOT NULL,
          kb_json TEXT NOT NULL,
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      const row = await get(`SELECT kb_json FROM chatbot_kb ORDER BY id DESC LIMIT 1`);
      if (!row) return res.json({ ok: true, kb: [] });
      let kb = [];
      try { kb = JSON.parse(row.kb_json); } catch (_) {}
      res.json({ ok: true, kb });
    } catch (e) {
      console.error('GET /app/chatbot/kb error:', e);
      res.status(500).json({ ok: false, error: 'No se pudo cargar el chatbot' });
    }
  });

  router.get('/admin/metrics/summary', requireAdmin, async (req, res) => {
    try {
      const summary = await getAdminMetricsSummary();
      return res.json({ ok: true, summary });
    } catch (e) {
      console.error('GET /app/admin/metrics/summary error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudieron cargar las estadísticas' });
    }
  });

  router.get('/admin/suggestions', requireAdmin, async (req, res) => {
    try {
      const theme = String(req.query.theme || '').trim();
      const out = await listAdminSuggestions(theme);
      return res.json({ ok: true, ...out });
    } catch (e) {
      console.error('GET /app/admin/suggestions error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudieron cargar las sugerencias' });
    }
  });

  router.post('/suggestions', express.json(), express.urlencoded({ extended: true }), async (req, res) => {
    try {
      const user = req.user || {};
      const message = String(req.body?.message || req.body?.text || '').trim();
      const theme = String(req.body?.theme || 'general').trim();
      if (!message) return res.status(400).json({ ok: false, error: 'La sugerencia está vacía' });

      await createUserSuggestion({
        userId: user.id || null,
        theme,
        message
      });

      return res.json({ ok: true });
    } catch (e) {
      console.error('POST /app/suggestions error:', e);
      return res.status(500).json({ ok: false, error: 'No se pudo guardar la sugerencia' });
    }
  });

  return router;
};
