// lib/libsqlSessionStore.js
// Store de express-session usando Turso/libSQL.
// Permite compartir sesiones entre múltiples instancias (Koyeb/Render/etc.).

const session = require('express-session');

function nowMs() {
  return Date.now();
}

function computeExpireMs(sess, fallbackTtlMs) {
  try {
    const exp = sess?.cookie?.expires;
    if (exp) {
      const t = new Date(exp).getTime();
      if (!Number.isNaN(t) && t > 0) return t;
    }
  } catch (_) {}

  const maxAge = Number(sess?.cookie?.maxAge);
  const ttl = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : fallbackTtlMs;
  return nowMs() + ttl;
}

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
const SESSION_TOUCH_GRACE_MS = 15 * 60 * 1000;      // 15 min

class LibsqlSessionStore extends session.Store {
  constructor({ get, run, ttlMs } = {}) {
    super();
    this._get = get;
    this._run = run;
    this.ttlMs = Number(ttlMs) > 0 ? Number(ttlMs) : (30 * 24 * 60 * 60 * 1000);
    this._lastCleanupAt = 0;
    if (typeof this._get !== 'function' || typeof this._run !== 'function') {
      throw new Error('LibsqlSessionStore requiere { get, run } (helpers de models/db.js)');
    }
  }

  async _maybeCleanup() {
    const now = nowMs();
    if ((now - this._lastCleanupAt) < SESSION_CLEANUP_INTERVAL_MS) return;
    this._lastCleanupAt = now;
    await this._run(`DELETE FROM sessions WHERE expire IS NOT NULL AND expire <= ?`, [now]);
  }

  get(sid, cb) {
    (async () => {
      const row = await this._get(
        `SELECT sess, expire FROM sessions WHERE sid=? LIMIT 1`,
        [sid]
      );
      if (!row) return cb(null, null);

      const expire = row.expire == null ? null : Number(row.expire);
      if (expire && expire <= nowMs()) {
        await this._run(`DELETE FROM sessions WHERE sid=?`, [sid]);
        return cb(null, null);
      }

      try {
        const sess = JSON.parse(row.sess);
        return cb(null, sess);
      } catch (e) {
        // si se corrompió, la borramos
        await this._run(`DELETE FROM sessions WHERE sid=?`, [sid]);
        return cb(null, null);
      }
    })().catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    (async () => {
      const expire = computeExpireMs(sess, this.ttlMs);
      const sessJson = JSON.stringify(sess);
      await this._run(
        `
        INSERT INTO sessions (sid, sess, expire)
        VALUES (?,?,?)
        ON CONFLICT(sid) DO UPDATE SET
          sess=excluded.sess,
          expire=excluded.expire
        `,
        [sid, sessJson, expire]
      );

      // limpieza best-effort
      try {
        await this._maybeCleanup();
      } catch (_) {}

      cb && cb(null);
    })().catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    (async () => {
      await this._run(`DELETE FROM sessions WHERE sid=?`, [sid]);
      cb && cb(null);
    })().catch((err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    (async () => {
      const expire = computeExpireMs(sess, this.ttlMs);
      const minExpireToWrite = expire - SESSION_TOUCH_GRACE_MS;

      await this._run(
        `
        UPDATE sessions
           SET expire = ?
         WHERE sid = ?
           AND (expire IS NULL OR expire < ?)
        `,
        [expire, sid, minExpireToWrite]
      );

      cb && cb(null);
    })().catch((err) => cb && cb(err));
  }
}

module.exports = LibsqlSessionStore;
