require('dotenv').config();

const { db } = require('../models/db');
const { ensureMetricsSchema } = require('../lib/appMetrics');
const {
  ensureLocalMetricsSchema,
  readAllLocalMetrics,
  clearLocalMetrics
} = require('../lib/localMetricsDb');

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1500;
const BATCH_SIZE = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkRows(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

function normalizeMetricRow(row, index) {
  const metric_key = String(row?.metric_key || '').trim();
  const metric_date = String(row?.metric_date || '').trim();
  const count = parseInt(row?.count, 10);

  return {
    rowNumber: index + 1,
    metric_key,
    metric_date,
    count,
    raw: row
  };
}

function isValidMetricRow(row) {
  return !!(
    row.metric_key &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.metric_date) &&
    Number.isInteger(row.count) &&
    row.count > 0
  );
}

function buildUpsertStatement(row) {
  return {
    sql: `
      INSERT INTO app_metrics (metric_key, metric_date, count)
      VALUES (?, ?, ?)
      ON CONFLICT(metric_key, metric_date)
      DO UPDATE SET count = app_metrics.count + excluded.count
    `,
    args: [row.metric_key, row.metric_date, row.count]
  };
}

function describeError(err) {
  return String(err?.message || err || 'unknown error');
}

function isRetryableNetworkError(err) {
  const msg = describeError(err).toLowerCase();
  return [
    'timeout',
    'timed out',
    'network',
    'fetch failed',
    'connection',
    'socket',
    'econnreset',
    'econnrefused',
    'enotfound',
    'etimedout',
    'temporar',
    'unavailable',
    '502',
    '503',
    '504',
    'hrana'
  ].some((token) => msg.includes(token));
}

async function pushBatchToTurso(rows, batchIndex, batchCount) {
  const statements = rows.map(buildUpsertStatement);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      console.log(
        `[sync_local_metrics_to_turso] enviando lote ${batchIndex}/${batchCount} ` +
        `con ${rows.length} fila(s) a Turso (intento ${attempt}/${MAX_RETRIES})`
      );

      await db.batch(statements, 'write');
      return;
    } catch (err) {
      const msg = describeError(err);
      const retryable = isRetryableNetworkError(err);

      console.error(
        `[sync_local_metrics_to_turso] fallo lote ${batchIndex}/${batchCount} ` +
        `(intento ${attempt}/${MAX_RETRIES}): ${msg}`
      );

      if (!retryable || attempt === MAX_RETRIES) {
        throw err;
      }

      const waitMs = RETRY_BASE_MS * attempt;
      console.warn(
        `[sync_local_metrics_to_turso] error de red/transporte detectado; ` +
        `reintentando en ${waitMs}ms`
      );
      await sleep(waitMs);
    }
  }
}

async function diagnoseRows(rows, batchIndex, batchCount) {
  console.warn(
    `[sync_local_metrics_to_turso] iniciando diagnóstico por fila para lote ` +
    `${batchIndex}/${batchCount}`
  );

  for (const row of rows) {
    if (!isValidMetricRow(row)) {
      console.error(
        `[sync_local_metrics_to_turso] fila inválida detectada antes de subir:`,
        {
          rowNumber: row.rowNumber,
          metric_key: row.metric_key,
          metric_date: row.metric_date,
          count: row.count,
          raw: row.raw
        }
      );
      continue;
    }

    try {
      await db.execute(buildUpsertStatement(row));
    } catch (err) {
      console.error(
        `[sync_local_metrics_to_turso] falló la fila ${row.rowNumber} ` +
        `(${row.metric_key} | ${row.metric_date} | ${row.count})`
      );
      console.error('[sync_local_metrics_to_turso] detalle del error:', describeError(err));
      throw err;
    }
  }
}

async function main() {
  await ensureLocalMetricsSchema();
  await ensureMetricsSchema();

  const rawRows = await readAllLocalMetrics();
  if (!rawRows.length) {
    console.log('[sync_local_metrics_to_turso] no hay métricas locales para sincronizar');
    return;
  }

  const rows = rawRows.map(normalizeMetricRow);
  const invalidRows = rows.filter((row) => !isValidMetricRow(row));

  if (invalidRows.length) {
    console.error(
      `[sync_local_metrics_to_turso] se detectaron ${invalidRows.length} fila(s) inválidas en local_metrics; ` +
      `se aborta la sincronización para evitar datos corruptos`
    );
    for (const row of invalidRows) {
      console.error('[sync_local_metrics_to_turso] fila inválida:', {
        rowNumber: row.rowNumber,
        metric_key: row.metric_key,
        metric_date: row.metric_date,
        count: row.count,
        raw: row.raw
      });
    }
    process.exitCode = 1;
    return;
  }

  const batches = chunkRows(rows, BATCH_SIZE);
  console.log(
    `[sync_local_metrics_to_turso] sincronizando ${rows.length} fila(s) locales ` +
    `en ${batches.length} lote(s)`
  );

  for (let i = 0; i < batches.length; i += 1) {
    const batchIndex = i + 1;
    const batch = batches[i];

    try {
      await pushBatchToTurso(batch, batchIndex, batches.length);
    } catch (err) {
      console.error(
        `[sync_local_metrics_to_turso] el lote ${batchIndex}/${batches.length} no pudo sincronizarse`
      );

      if (!isRetryableNetworkError(err)) {
        await diagnoseRows(batch, batchIndex, batches.length);
      }

      throw err;
    }
  }

  await clearLocalMetrics();
  console.log('[sync_local_metrics_to_turso] sincronización completa y tabla local vaciada');
}

main().catch((err) => {
  console.error('[sync_local_metrics_to_turso] error final:', describeError(err));
  process.exitCode = 1;
});
