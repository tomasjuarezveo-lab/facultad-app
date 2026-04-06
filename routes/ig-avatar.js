// routes/ig-avatar.js
const express = require('express');
const router = express.Router();

// ✅ Adaptable a tu models/db.js (db / client / export directo)
const dbmod = require('../models/db');
const db = dbmod.db || dbmod.client || dbmod;

function ensureAuth(req, res, next){
  try{
    if (req.isAuthenticated && req.isAuthenticated()) return next();
  }catch(_){}
  return res.status(401).json({ ok:false, error:'AUTH' });
}

async function exec(sql, args = []){
  if (db && typeof db.execute === 'function'){
    // libSQL usual
    return db.execute({ sql, args });
  }
  if (db && typeof db.run === 'function'){
    // sqlite style
    return db.run(sql, args);
  }
  if (db && typeof db.query === 'function'){
    return db.query(sql, args);
  }
  throw new Error('DB driver no soportado: no encuentro execute/run/query.');
}

function cleanHandle(raw){
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '');
}

function isValidHandle(h){
  // Instagram: letras/números/._ (1..30 aprox)
  return /^[a-zA-Z0-9._]{1,30}$/.test(h);
}

function decodeHtmlEntities(s){
  return String(s || '').replace(/&amp;/g, '&');
}

function pickOgImage(html){
  const h = String(html || '');
  // property="og:image" content="..."
  let m = h.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (!m) m = h.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  return m ? decodeHtmlEntities(m[1]) : '';
}

async function fetchHtml(url){
  const r = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'es-AR,es;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      'pragma': 'no-cache'
    }
  });
  const txt = await r.text();
  return { ok: r.ok, status: r.status, text: txt };
}

async function resolveInstagramAvatarUrl(handle){
  // 1) Intento directo a Instagram
  const url1 = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
  const a = await fetchHtml(url1);
  let img = pickOgImage(a.text);
  if (img) return img;

  // 2) Fallback: r.jina.ai (a veces pasa bloqueos)
  const url2 = `https://r.jina.ai/http://www.instagram.com/${encodeURIComponent(handle)}/`;
  const b = await fetchHtml(url2);
  img = pickOgImage(b.text);
  if (img) return img;

  return '';
}

router.use(express.json());

router.post('/set', ensureAuth, async (req, res) => {
  try{
    const viewer = req.user || {};
    const viewerId = viewer.id || viewer._id || viewer.email || null;
    if (!viewerId) return res.status(400).json({ ok:false, error:'NO_VIEWER_ID' });

    const igHandle = cleanHandle(req.body && (req.body.igHandle || req.body.instagram || req.body.handle));
    if (!isValidHandle(igHandle)) return res.status(400).json({ ok:false, error:'HANDLE_INVALID' });

    const avatarUrl = await resolveInstagramAvatarUrl(igHandle);
    if (!avatarUrl) return res.status(404).json({ ok:false, error:'NO_OG_IMAGE' });

    await exec(
      "UPDATE users SET igHandle = ?, avatarUrl = ? WHERE id = ? OR _id = ? OR email = ?",
      [igHandle, avatarUrl, viewerId, viewerId, viewerId]
    );

    return res.json({ ok:true, igHandle, avatarUrl });
  }catch(err){
    return res.status(500).json({ ok:false, error:'SERVER', detail: String(err && err.message || err) });
  }
});

module.exports = router;
