// utils/instagramAvatar.js
'use strict';

const DEFAULT_UA =
  process.env.INSTAGRAM_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = Math.max(
  2000,
  Math.min(25000, Number(process.env.INSTAGRAM_FETCH_TIMEOUT_MS || 12000))
);

const IG_APP_ID  = String(process.env.INSTAGRAM_APP_ID  || '936619743392459');
const IG_ASBD_ID = String(process.env.INSTAGRAM_ASBD_ID || '129477');

function normalizeInstagramUsername(raw) {
  const s = String(raw || '').trim().replace(/^@/, '');
  if (!s) {
    const err = new Error('Falta el usuario de Instagram');
    err.code = 'INVALID_USERNAME';
    err.status = 400;
    throw err;
  }
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(s)) {
    const err = new Error('Instagram inválido');
    err.code = 'INVALID_USERNAME';
    err.status = 400;
    throw err;
  }
  return s;
}

function decodeHtmlEntities(str) {
  let s = String(str || '');
  s = s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    if (!Number.isFinite(code) || code <= 0) return _;
    try { return String.fromCodePoint(code); } catch { return _; }
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const code = parseInt(h, 16);
    if (!Number.isFinite(code) || code <= 0) return _;
    try { return String.fromCodePoint(code); } catch { return _; }
  });
  return s;
}

function unescapeIgJsonUrl(s) {
  let x = String(s || '');
  x = x.replace(/\\u0026/gi, '&');
  x = x.replace(/\\\//g, '/');
  x = x.replace(/\\"/g, '"');
  x = x.replace(/\\\\/g, '\\');
  return x;
}

function pickUrlCandidate(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) return '';
  return u;
}

function looksHtml(s) {
  const t = String(s || '').trim();
  return /^<!doctype html/i.test(t) || /^<html/i.test(t);
}

function looksRateLimited(html) {
  const h = String(html || '');
  return /too many requests/i.test(h) || /Please wait a few minutes/i.test(h) || /rate limit/i.test(h);
}

function looksBlockedOrChallenge(html) {
  const h = String(html || '');
  return /challenge/i.test(h) || /suspicious/i.test(h) || /temporarily blocked/i.test(h) || (/login/i.test(h) && /instagram/i.test(h));
}

async function fetchWithTimeout(url, fetchOptions, timeoutMs) {
  const ms = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

  if (typeof fetch === 'function') {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...fetchOptions, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  const https = require('https');
  return await new Promise((resolve, reject) => {
    const req = https.request(url, fetchOptions, (res) => resolve(res));
    req.on('error', reject);
    req.setTimeout(ms, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

async function fetchText(url, headers, timeoutMs) {
  const res = await fetchWithTimeout(url, { method: 'GET', headers, redirect: 'follow' }, timeoutMs);
  const text = await res.text();
  const ct = String(res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '');
  return { status: res.status, text, contentType: ct, finalUrl: res.url || url };
}

async function fetchJsonLoose(url, headers, timeoutMs) {
  const res = await fetchWithTimeout(url, { method: 'GET', headers, redirect: 'follow' }, timeoutMs);
  const text = await res.text();
  const ct = String(res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '');
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, contentType: ct, finalUrl: res.url || url };
}

function extractOgImage(html) {
  const h = String(html || '');

  // match flexible: og:image o og:image:secure_url
  const tagMatch = h.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i);
  if (!tagMatch) return '';

  const tag = tagMatch[0];
  const contentMatch = tag.match(/content=["']([^"']+)["']/i);
  if (!contentMatch) return '';

  return decodeHtmlEntities(contentMatch[1] || '').trim();
}

function extractProfilePicFromHtmlJson(html) {
  const h = String(html || '');

  let m = h.match(/"profile_pic_url_hd"\s*:\s*"([^"]+)"/i);
  if (m && m[1]) {
    const url = unescapeIgJsonUrl(m[1]).trim();
    if (/^https?:\/\//i.test(url)) return url;
  }

  m = h.match(/"profile_pic_url"\s*:\s*"([^"]+)"/i);
  if (m && m[1]) {
    const url = unescapeIgJsonUrl(m[1]).trim();
    if (/^https?:\/\//i.test(url)) return url;
  }

  return '';
}

async function fetchFromA1(username, timeoutMs) {
  const handle = normalizeInstagramUsername(username);

  const url = `https://www.instagram.com/${encodeURIComponent(handle)}/?__a=1&__d=dis`;

  const headers = {
    'User-Agent': DEFAULT_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    'Referer': `https://www.instagram.com/${encodeURIComponent(handle)}/`,
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  const { status, json, text, contentType } = await fetchJsonLoose(url, headers, timeoutMs);

  // si IG devuelve HTML acá, está bloqueando o redirigiendo
  if (status === 404) {
    const err = new Error('Usuario inexistente');
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (status === 429 || looksRateLimited(text)) {
    const err = new Error('Rate limit');
    err.code = 'RATE_LIMIT';
    err.status = 429;
    throw err;
  }
  if (status === 403) {
    const err = new Error('Forbidden');
    err.code = 'FORBIDDEN';
    err.status = 403;
    throw err;
  }

  if (status < 200 || status >= 300) {
    const err = new Error('HTTP_ERROR');
    err.code = 'HTTP_ERROR';
    err.status = status;
    throw err;
  }

  if (!json || looksHtml(text) || (!/application\/json/i.test(contentType) && looksHtml(text))) {
    const err = new Error('Respuesta no-JSON (bloqueo)');
    err.code = 'FORBIDDEN';
    err.status = 403;
    throw err;
  }

  const user = (json && (json.graphql && json.graphql.user)) || null;
  const pic = user && (user.profile_pic_url_hd || user.profile_pic_url) ? String(user.profile_pic_url_hd || user.profile_pic_url) : '';
  const avatar = pickUrlCandidate(pic);

  if (!avatar) {
    const err = new Error('No se pudo extraer la foto (__a=1)');
    err.code = 'AVATAR_NOT_FOUND';
    err.status = 502;
    throw err;
  }

  return { username: handle, avatar };
}

async function fetchFromWebProfileInfo(username, timeoutMs) {
  const handle = normalizeInstagramUsername(username);

  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;

  const headers = {
    'User-Agent': DEFAULT_UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    'Referer': `https://www.instagram.com/${encodeURIComponent(handle)}/`,
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': IG_ASBD_ID,
    'X-IG-WWW-Claim': '0',
    'X-Requested-With': 'XMLHttpRequest',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  const { status, json, text, contentType } = await fetchJsonLoose(url, headers, timeoutMs);

  if (status === 404) {
    const err = new Error('Usuario inexistente');
    err.code = 'NOT_FOUND';
    err.status = 404;
    throw err;
  }
  if (status === 429 || looksRateLimited(text)) {
    const err = new Error('Rate limit');
    err.code = 'RATE_LIMIT';
    err.status = 429;
    throw err;
  }
  if (status === 403) {
    const err = new Error('Forbidden');
    err.code = 'FORBIDDEN';
    err.status = 403;
    throw err;
  }
  if (status < 200 || status >= 300) {
    const err = new Error('HTTP_ERROR');
    err.code = 'HTTP_ERROR';
    err.status = status;
    throw err;
  }

  if (!json || looksHtml(text) || (!/application\/json/i.test(contentType) && looksHtml(text))) {
    const err = new Error('Respuesta no-JSON (bloqueo)');
    err.code = 'FORBIDDEN';
    err.status = 403;
    throw err;
  }

  const user = json && json.data && json.data.user ? json.data.user : null;
  const pic = user && (user.profile_pic_url_hd || user.profile_pic_url) ? String(user.profile_pic_url_hd || user.profile_pic_url) : '';
  const avatar = pickUrlCandidate(pic);

  if (!avatar) {
    const err = new Error('No se pudo extraer la foto (web_profile_info)');
    err.code = 'AVATAR_NOT_FOUND';
    err.status = 502;
    throw err;
  }

  return { username: handle, avatar };
}

async function fetchInstagramAvatar(username, opts = {}) {
  const handle = normalizeInstagramUsername(username);
  const ua = String(opts.userAgent || DEFAULT_UA);
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  const debug = {
    handle,
    html: { status: null, finalUrl: null, contentType: null, og: false, jsonPic: false },
    a1:   { tried: false, status: null },
    wpi:  { tried: false, status: null }
  };

  // 1) HTML público
  const pageUrl = `https://www.instagram.com/${encodeURIComponent(handle)}/`;

  const headersHtml = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'DNT': '1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://www.instagram.com/',
    'Origin': 'https://www.instagram.com'
  };

  let htmlStatus = 0;
  let htmlText = '';
  let htmlCT = '';
  let htmlFinal = pageUrl;

  try {
    const r = await fetchText(pageUrl, headersHtml, timeoutMs);
    htmlStatus = r.status;
    htmlText = r.text;
    htmlCT = r.contentType;
    htmlFinal = r.finalUrl;
  } catch (e) {
    const err = new Error('Fallo de red consultando Instagram');
    err.code = 'NETWORK_ERROR';
    err.status = 502;
    err.debug = { ...debug, html: { ...debug.html, status: 'NETWORK_ERROR' } };
    throw err;
  }

  debug.html.status = htmlStatus;
  debug.html.contentType = htmlCT;
  debug.html.finalUrl = htmlFinal;

  if (htmlStatus === 404) {
    const err = new Error('Usuario inexistente');
    err.code = 'NOT_FOUND';
    err.status = 404;
    err.debug = debug;
    throw err;
  }

  if (htmlStatus === 429 || looksRateLimited(htmlText)) {
    const err = new Error('Instagram bloqueó por rate-limit');
    err.code = 'RATE_LIMIT';
    err.status = 429;
    err.debug = debug;
    throw err;
  }

  if (htmlStatus === 403) {
    const err = new Error('Instagram bloqueó la consulta');
    err.code = 'FORBIDDEN';
    err.status = 403;
    err.debug = debug;
    throw err;
  }

  if (htmlStatus && (htmlStatus < 200 || htmlStatus >= 300)) {
    const err = new Error('Fallo al obtener el perfil');
    err.code = 'HTTP_ERROR';
    err.status = htmlStatus;
    err.debug = debug;
    throw err;
  }

  if (/Sorry,\s*this\s*page\s*isn['’]t\s*available/i.test(htmlText) || /page isn't available/i.test(htmlText)) {
    const err = new Error('Usuario inexistente');
    err.code = 'NOT_FOUND';
    err.status = 404;
    err.debug = debug;
    throw err;
  }

  // 1.a og:image
  const og = pickUrlCandidate(extractOgImage(htmlText));
  debug.html.og = !!og;
  if (og) return { username: handle, avatar: og };

  // 1.b JSON embebido
  const jsonPic = pickUrlCandidate(extractProfilePicFromHtmlJson(htmlText));
  debug.html.jsonPic = !!jsonPic;
  if (jsonPic) return { username: handle, avatar: jsonPic };

  // 1.c challenge/bloqueo “suave”
  if (looksBlockedOrChallenge(htmlText)) {
    const err = new Error('Instagram devolvió challenge/bloqueo');
    err.code = 'FORBIDDEN';
    err.status = 403;
    err.debug = { ...debug, htmlSnippet: String(htmlText || '').slice(0, 220) };
    throw err;
  }

  // 2) fallback __a=1
  debug.a1.tried = true;
  try {
    const rA1 = await fetchFromA1(handle, timeoutMs);
    return rA1;
  } catch (e) {
    debug.a1.status = Number(e && e.status) || null;
  }

  // 3) fallback web_profile_info
  debug.wpi.tried = true;
  try {
    const rWpi = await fetchFromWebProfileInfo(handle, timeoutMs);
    return rWpi;
  } catch (e) {
    debug.wpi.status = Number(e && e.status) || null;
    // si es NOT_FOUND/RATE_LIMIT/FORBIDDEN, propagar
    if (e && (e.code === 'NOT_FOUND' || e.code === 'RATE_LIMIT' || e.code === 'FORBIDDEN')) {
      e.debug = e.debug || debug;
      throw e;
    }
  }

  const err = new Error('No se pudo extraer la foto de perfil');
  err.code = 'AVATAR_NOT_FOUND';
  err.status = 502;
  err.debug = { ...debug, htmlSnippet: String(htmlText || '').slice(0, 220) };
  throw err;
}

module.exports = {
  normalizeInstagramUsername,
  fetchInstagramAvatar
};
