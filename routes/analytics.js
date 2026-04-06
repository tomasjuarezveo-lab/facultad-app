const express = require('express');
const { processAnalyticsPayload } = require('../lib/appMetrics');

module.exports = () => {
  const router = express.Router();

  router.use(express.json({
    limit: '256kb',
    strict: false,
    type: ['application/json', 'application/*+json', 'text/plain']
  }));

  router.post('/track', async (req, res) => {
    try {
      let payload = req.body;
      if (typeof payload === 'string') {
        payload = payload.trim() ? JSON.parse(payload) : {};
      }
      if (!payload || typeof payload !== 'object') payload = {};

      console.log('[analytics] Recibiendo paquete de métricas:', JSON.stringify(payload));
      await processAnalyticsPayload(payload);
      return res.status(204).end();
    } catch (err) {
      console.error('POST /api/analytics/track error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'No se pudieron guardar las métricas locales' });
    }
  });

  return router;
};
