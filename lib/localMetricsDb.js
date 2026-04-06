const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_DIR = path.resolve(__dirname, '..', 'db');
const DB_PATH = path.resolve(DB_DIR, 'local_metrics.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

console.log('[localMetricsDb] usando archivo SQLite local en:', DB_PATH);

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[localMetricsDb] error abriendo SQLite local:', err?.message || err);
    return;
  }
  console.log('[localMetricsDb] conexión SQLite local OK');
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

let initPromise = null;
function ensureLocalMetricsSchema() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await run(`
      CREATE TABLE IF NOT EXISTS local_metrics (
        metric_key TEXT NOT NULL,
        metric_date TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (metric_key, metric_date)
      )
    `);

    await run(`
      CREATE INDEX IF NOT EXISTS idx_local_metrics_date_key
      ON local_metrics(metric_date, metric_key)
    `);

    console.log('[localMetricsDb] esquema local_metrics asegurado');
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

async function upsertLocalMetricsBatch(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return 0;
  await ensureLocalMetricsSchema();

  let written = 0;
  await run('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const key = String(row.metric_key || '').trim();
      const date = String(row.metric_date || '').trim();
      const count = Math.max(1, parseInt(row.count, 10) || 0);
      if (!key || !date || !count) continue;

      await run(
        `
        INSERT INTO local_metrics (metric_key, metric_date, count)
        VALUES (?, ?, ?)
        ON CONFLICT(metric_key, metric_date)
        DO UPDATE SET count = local_metrics.count + excluded.count
        `,
        [key, date, count]
      );
      written += 1;
    }
    await run('COMMIT');
  } catch (err) {
    try { await run('ROLLBACK'); } catch (_) {}
    throw err;
  }

  return written;
}

async function incrementLocalMetric(metricKey, metricDate, count = 1) {
  const key = String(metricKey || '').trim().slice(0, 180);
  const date = String(metricDate || '').trim().slice(0, 10);
  const delta = Math.max(1, parseInt(count, 10) || 0);
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !delta) return false;

  await ensureLocalMetricsSchema();
  await run(
    `
    INSERT INTO local_metrics (metric_key, metric_date, count)
    VALUES (?, ?, ?)
    ON CONFLICT(metric_key, metric_date)
    DO UPDATE SET count = local_metrics.count + excluded.count
    `,
    [key, date, delta]
  );
  return true;
}

async function readAllLocalMetrics() {
  await ensureLocalMetricsSchema();
  return all(
    `
    SELECT metric_key, metric_date, count
      FROM local_metrics
     ORDER BY metric_date ASC, metric_key ASC
    `
  );
}

async function clearLocalMetrics() {
  await ensureLocalMetricsSchema();
  await run(`DELETE FROM local_metrics`);
}

module.exports = {
  DB_PATH,
  ensureLocalMetricsSchema,
  incrementLocalMetric,
  upsertLocalMetricsBatch,
  readAllLocalMetrics,
  clearLocalMetrics
};
