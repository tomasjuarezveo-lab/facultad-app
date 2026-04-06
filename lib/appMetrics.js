const { all, run } = require('../models/db');
const { ensureLocalMetricsSchema, upsertLocalMetricsBatch } = require('./localMetricsDb');

const TZ = 'America/Argentina/Buenos_Aires';
const ADMIN_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_BUFFER_ITEMS = 200;

let schemaPromise = null;
let statsCache = { at: 0, value: null };

function normalizeToken(value, fallback = 'unknown') {
  let s = String(value ?? '').trim().toLowerCase();
  try {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {}
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

function formatMetricDate(date = new Date(), timeZone = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function shiftDateYmd(ymd, deltaDays) {
  const [y, m, d] = String(ymd || '').split('-').map((n) => parseInt(n, 10));
  const base = new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
  base.setUTCDate(base.getUTCDate() + (parseInt(deltaDays, 10) || 0));
  return formatMetricDate(base, 'UTC');
}

function prefixBounds(prefix) {
  return [prefix, `${prefix}\uffff`];
}

function humanizeSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Sin dato';
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await run(`
      CREATE TABLE IF NOT EXISTS app_metrics (
        metric_key TEXT NOT NULL,
        metric_date TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (metric_key, metric_date)
      )
    `);

    await run(`
      CREATE INDEX IF NOT EXISTS idx_app_metrics_date_key
      ON app_metrics(metric_date, metric_key)
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS user_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        theme TEXT NOT NULL DEFAULT 'general',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await run(`
      CREATE INDEX IF NOT EXISTS idx_user_suggestions_theme_created
      ON user_suggestions(theme, created_at DESC)
    `);
  })().catch((err) => {
    schemaPromise = null;
    throw err;
  });

  return schemaPromise;
}

function sanitizeBufferedMetrics(metrics) {
  const rows = Array.isArray(metrics) ? metrics : [];
  const grouped = new Map();

  for (const raw of rows.slice(0, MAX_BUFFER_ITEMS)) {
    const metricKey = String(raw && raw.metric_key || '').trim().slice(0, 180);
    const metricDate = String(raw && raw.metric_date || '').trim().slice(0, 10);
    const count = Math.max(1, Math.min(1000, parseInt(raw && raw.count, 10) || 0));
    if (!metricKey || !/^\d{4}-\d{2}-\d{2}$/.test(metricDate) || !count) continue;

    const compound = `${metricKey}|${metricDate}`;
    grouped.set(compound, (grouped.get(compound) || 0) + count);
  }

  return Array.from(grouped.entries()).map(([compound, count]) => {
    const splitAt = compound.lastIndexOf('|');
    return {
      metric_key: compound.slice(0, splitAt),
      metric_date: compound.slice(splitAt + 1),
      count
    };
  });
}

async function processAnalyticsPayload(payload) {
  await ensureLocalMetricsSchema();
  const metrics = sanitizeBufferedMetrics(payload && payload.metrics);
  if (!metrics.length) {
    return { accepted: 0, written: 0 };
  }

  const written = await upsertLocalMetricsBatch(metrics);
  return {
    accepted: metrics.length,
    written
  };
}

async function selectMetricTotalsByPrefix(prefix, { sinceDate = null, limit = null, order = 'DESC', dateList = null } = {}) {
  await ensureSchema();
  const [fromKey, toKey] = prefixBounds(prefix);
  const params = [fromKey, toKey];
  const where = ['metric_key >= ?', 'metric_key <= ?'];

  if (sinceDate) {
    where.push('metric_date >= ?');
    params.push(sinceDate);
  }

  if (Array.isArray(dateList) && dateList.length) {
    where.push(`metric_date IN (${dateList.map(() => '?').join(',')})`);
    params.push(...dateList);
  }

  const sql = `
    SELECT metric_key, SUM(count) AS total
      FROM app_metrics
     WHERE ${where.join(' AND ')}
     GROUP BY metric_key
     ORDER BY total ${order === 'ASC' ? 'ASC' : 'DESC'}, metric_key ASC
     ${limit ? `LIMIT ${Math.max(1, parseInt(limit, 10) || 1)}` : ''}
  `;

  return all(sql, params);
}

async function getAdminMetricsSummary({ force = false } = {}) {
  const now = Date.now();
  if (!force && statsCache.value && (now - statsCache.at) < ADMIN_CACHE_TTL_MS) {
    return statsCache.value;
  }

  const today = formatMetricDate();
  const yesterday = shiftDateYmd(today, -1);
  const last30Days = shiftDateYmd(today, -29);

  const [topSectionsRows, lowSectionsRows, subjectRows, toolRows, pdfRows] = await Promise.all([
    selectMetricTotalsByPrefix('visit:section:', { sinceDate: last30Days, limit: 5, order: 'DESC' }),
    selectMetricTotalsByPrefix('visit:section:', { sinceDate: last30Days, limit: 5, order: 'ASC' }),
    selectMetricTotalsByPrefix('visit:subject:', { sinceDate: last30Days, limit: 120, order: 'DESC' }),
    selectMetricTotalsByPrefix('tool:', { sinceDate: last30Days, limit: 10, order: 'DESC' }),
    (async () => {
      await ensureSchema();
      const [fromKey, toKey] = prefixBounds('pdf_down:');
      return all(
        `
        SELECT metric_date, SUM(count) AS total
          FROM app_metrics
         WHERE metric_key >= ?
           AND metric_key <= ?
           AND metric_date IN (?, ?)
         GROUP BY metric_date
        `,
        [fromKey, toKey, today, yesterday]
      );
    })()
  ]);

  const mapSectionRow = (row) => {
    const slug = String(row.metric_key || '').split(':')[2] || '';
    return {
      key: row.metric_key,
      slug,
      label: humanizeSlug(slug),
      total: Number(row.total || 0)
    };
  };

  const byCareer = new Map();
  for (const row of subjectRows) {
    const parts = String(row.metric_key || '').split(':');
    const careerSlug = parts[2] || 'unknown';
    const subjectSlug = parts.slice(3).join(':') || 'unknown';
    if (!byCareer.has(careerSlug)) byCareer.set(careerSlug, []);
    byCareer.get(careerSlug).push({
      key: row.metric_key,
      careerSlug,
      careerLabel: humanizeSlug(careerSlug),
      subjectSlug,
      subjectLabel: humanizeSlug(subjectSlug),
      total: Number(row.total || 0)
    });
  }

  const popularSubjectsByCareer = Array.from(byCareer.values())
    .map((items) => ({
      careerSlug: items[0].careerSlug,
      careerLabel: items[0].careerLabel,
      items: items.sort((a, b) => b.total - a.total).slice(0, 5)
    }))
    .sort((a, b) => a.careerLabel.localeCompare(b.careerLabel, 'es'));

  const pdfCompare = { today: 0, yesterday: 0 };
  for (const row of pdfRows) {
    const total = Number(row.total || 0);
    if (row.metric_date === today) pdfCompare.today = total;
    if (row.metric_date === yesterday) pdfCompare.yesterday = total;
  }

  const value = {
    generatedAt: new Date().toISOString(),
    cacheTtlMs: ADMIN_CACHE_TTL_MS,
    windowStartDate: last30Days,
    windowEndDate: today,
    topSections: topSectionsRows.map(mapSectionRow),
    lowSections: lowSectionsRows.map(mapSectionRow),
    popularSubjectsByCareer,
    toolUsage: toolRows.map((row) => {
      const slug = String(row.metric_key || '').split(':')[1] || '';
      return { key: row.metric_key, slug, label: humanizeSlug(slug), total: Number(row.total || 0) };
    }),
    pdfDownloads: {
      today: { date: today, total: pdfCompare.today },
      yesterday: { date: yesterday, total: pdfCompare.yesterday },
      delta: pdfCompare.today - pdfCompare.yesterday
    }
  };

  statsCache = { at: now, value };
  return value;
}

async function listAdminSuggestions(theme = '') {
  await ensureSchema();
  const normalizedTheme = normalizeToken(theme, '');
  const themes = await all(
    `
    SELECT theme, COUNT(*) AS total
      FROM user_suggestions
     GROUP BY theme
     ORDER BY theme ASC
    `
  );

  const rows = normalizedTheme
    ? await all(
        `
        SELECT id,
               theme,
               SUBSTR(COALESCE(message, ''), 1, 200) AS message,
               created_at
          FROM user_suggestions
         WHERE theme = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 200
        `,
        [normalizedTheme]
      )
    : await all(
        `
        SELECT id,
               theme,
               SUBSTR(COALESCE(message, ''), 1, 200) AS message,
               created_at
          FROM user_suggestions
         ORDER BY created_at DESC, id DESC
         LIMIT 200
        `
      );

  return {
    themes: themes.map((row) => ({
      value: String(row.theme || ''),
      label: humanizeSlug(row.theme || ''),
      total: Number(row.total || 0)
    })),
    items: rows.map((row) => ({
      id: Number(row.id || 0),
      theme: String(row.theme || ''),
      themeLabel: humanizeSlug(row.theme || ''),
      message: String(row.message || ''),
      created_at: String(row.created_at || '')
    }))
  };
}

async function createUserSuggestion({ userId = null, theme = 'general', message = '' }) {
  const msg = String(message || '').trim().slice(0, 200);
  if (!msg) return false;
  await ensureSchema();
  await run(
    `
    INSERT INTO user_suggestions (user_id, theme, message, created_at)
    VALUES (?, ?, ?, datetime('now'))
    `,
    [userId ? Number(userId) : null, normalizeToken(theme, 'general'), msg]
  );
  return true;
}

module.exports = {
  ensureMetricsSchema: ensureSchema,
  formatMetricDate,
  processAnalyticsPayload,
  getAdminMetricsSummary,
  listAdminSuggestions,
  createUserSuggestion,
  normalizeMetricToken: normalizeToken
};
