// models/db.js (Turso/libSQL) - DEBUG + compatibilidad total
const { createClient } = require("@libsql/client");
const bcrypt = require("bcrypt");

function readEnvTrim(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

const DB_URL = readEnvTrim("DATABASE_URL", "TURSO_DATABASE_URL", "LIBSQL_URL");
const DB_TOKEN = readEnvTrim("DATABASE_AUTH_TOKEN", "TURSO_AUTH_TOKEN", "LIBSQL_AUTH_TOKEN");

// DEBUG (no imprime el token completo)
console.log("✅ db.js cargado (libSQL/Turso)");
console.log("DB_URL:", DB_URL || "(VACIO)");
console.log("DB_TOKEN length:", DB_TOKEN ? DB_TOKEN.length : 0);
console.log("DB_TOKEN startsWith:", DB_TOKEN ? DB_TOKEN.slice(0, 12) + "..." : "(VACIO)");

const db = createClient({
  url: DB_URL,
  authToken: DB_TOKEN,
});

async function run(sql, params = []) {
  const r = await db.execute({ sql, args: params });
  return r;
}

async function get(sql, params = []) {
  const r = await db.execute({ sql, args: params });
  return r.rows && r.rows.length ? r.rows[0] : null;
}

async function all(sql, params = []) {
  const r = await db.execute({ sql, args: params });
  return r.rows || [];
}

async function init() {
  // Ping mínimo: si falla acá, es 100% URL/token
  const ping = await db.execute("SELECT 1 as ok");
  console.log("✅ Turso ping OK:", ping.rows?.[0]?.ok);

  // Tablas base (mínimo para arrancar)
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      career TEXT DEFAULT '',
      plan TEXT DEFAULT ''
    )
  `);

  // Seed admin si no existe
  const admin = await get(`SELECT * FROM users WHERE role = 'admin' LIMIT 1`);
  if (!admin) {
    const email = process.env.ADMIN_EMAIL || "admin@demo.com";
    const pass = process.env.ADMIN_PASS || "admin123";
    const pass_hash = await bcrypt.hash(pass, 10);
    await run(
      `INSERT INTO users (name, email, pass_hash, role) VALUES (?, ?, ?, 'admin')`,
      ["Admin", email, pass_hash]
    );
    console.log(`[DB] Admin creado: ${email} / ${pass}`);
  }

  console.log("[DB] init OK (libSQL remoto)");
}

module.exports = { db, all, get, run, init };
