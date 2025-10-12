const express = require('express');
const { all, get, run } = require('../models/db');
const { normalizeCareer } = require('../utils/careers');

module.exports = ({ ensureAdmin } = {}) => {
  const router = express.Router();

  // GET /app/notifications -> lista notificaciones (admin: todas; usuario: por carrera)
  router.get('/notifications', async (req, res) => {
    try {
      const user = req.user || {};
      const isAdmin = (user && user.role === 'admin');
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

  // POST /app/notifications -> crear notificación (solo admin)
  router.post('/notifications', ensureAdmin || ((req,res,next)=>next()), async (req, res) => {
    try {
      const { text, careers } = req.body || {};
      const adminId = (req.user && req.user.id) || null;

      const body = String(text || '').trim();
      if (!body) return res.status(400).json({ error: 'El texto es obligatorio' });

      let selected = Array.isArray(careers) ? careers : [];
      selected = selected.map(c => normalizeCareer(String(c || ''))).filter(Boolean);

      if (!selected.length) {
        return res.status(400).json({ error: 'Debe seleccionar al menos una carrera' });
      }

      const csv = selected.join(',');

      await run(
        `
        INSERT INTO notifications (body, careers, created_by)
        VALUES (?, ?, ?)
        `,
        [body, csv, adminId]
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('POST /app/notifications error:', e);
      res.status(500).json({ error: 'No se pudo crear la notificación' });
    }
  });

  // DELETE /app/notifications/:id -> borrar notificación (solo admin)
  router.delete('/notifications/:id', ensureAdmin || ((req,res,next)=>next()), async (req, res) => {
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

  return router;
};
