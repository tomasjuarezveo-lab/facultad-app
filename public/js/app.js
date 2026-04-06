// public/js/app.js — cliente (UI global)
// - Loader global: SOLO aparece si una acción del usuario tarda > 3s en responder
// - Se muestra únicamente para requests iniciados tras click en botón/link o submit (no background)
// - Bloqueo click derecho / click medio para no-admin

(function(){
  const body = document.body;
  const role = (body && body.dataset && body.dataset.userRole) ? String(body.dataset.userRole) : '';
  const isAdmin = role === 'admin';

  // =========================
  // ✅ Bloquear click derecho (solo no-admin)
  // =========================
  if (!isAdmin){
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      return false;
    }, true);

    document.addEventListener('auxclick', (e) => {
      e.preventDefault();
      return false;
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (e.button === 1 || e.button === 2){
        e.preventDefault();
        return false;
      }
    }, true);
  }

  // =========================
  // ✅ Loader global (solo si tarda > 3s)
  // =========================
  const loader = document.getElementById('globalLoader');

  const SHOW_DELAY_MS = 3000;      // ✅ 3 segundos exactos
  const ACTION_WINDOW_MS = 1200;   // ventana para asociar fetch con el click
  const ACTION_BUDGET_MAX = 8;     // max fetches asociados a 1 acción (por si hay varios)

  let lastUserActionAt = 0;
  let actionBudget = 0;

  let pending = 0;
  let pendingSince = 0;

  let showDelayTimer = null;
  let hardHideTimer = null;
  let showToken = 0;

  function hideNow(){
    if (!loader) return;
    loader.classList.remove('show');
    loader.setAttribute('aria-hidden', 'true');
  }

  function showNow(){
    if (!loader) return;
    loader.classList.add('show');
    loader.setAttribute('aria-hidden', 'false');
  }

  function clearShowTimer(){
    if (showDelayTimer){
      clearTimeout(showDelayTimer);
      showDelayTimer = null;
    }
    showToken += 1; // invalida callbacks viejos
  }

  function armHardHide(){
    if (hardHideTimer) clearTimeout(hardHideTimer);
    hardHideTimer = setTimeout(() => {
      pending = 0;
      pendingSince = 0;
      clearShowTimer();
      if (hardHideTimer){ clearTimeout(hardHideTimer); hardHideTimer = null; }
      hideNow();
    }, 9000);
  }

  function scheduleShow(){
    if (!loader) return;
    if (showDelayTimer) return;

    const myToken = ++showToken;
    showDelayTimer = setTimeout(() => {
      showDelayTimer = null;
      if (myToken !== showToken) return;

      if (pending > 0 && pendingSince > 0 && (Date.now() - pendingSince) >= SHOW_DELAY_MS){
        showNow();
        armHardHide();
      }
    }, SHOW_DELAY_MS);
  }

  function beginPending(){
    pending += 1;
    if (pending === 1){
      pendingSince = Date.now();
      scheduleShow();
    }
  }

  function endPending(){
    if (pending > 0) pending -= 1;

    if (pending === 0){
      pendingSince = 0;
      clearShowTimer();
      if (hardHideTimer){ clearTimeout(hardHideTimer); hardHideTimer = null; }
      hideNow();
    }
  }

  // helpers manuales (si en algún JS querés usarlo a mano)
  window.__showLoader = () => { beginPending(); };
  window.__hideLoader = () => { endPending(); };

    function showNavLoaderNow(){
    if (!loader) return;
    pending = Math.max(pending, 1);
    pendingSince = Date.now();
    clearShowTimer();
    if (hardHideTimer){ clearTimeout(hardHideTimer); hardHideTimer = null; }
    showNow();
    armHardHide();
  }

  function shouldSkipNavLoader(e, a){
    if (!a) return true;
    if (e.defaultPrevented) return true;
    if (typeof e.button === 'number' && e.button !== 0) return true;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return true;

    const rawHref = String(a.getAttribute('href') || '').trim();
    if (!rawHref || rawHref === '#') return true;
    if (rawHref.startsWith('javascript:')) return true;
    if (rawHref.startsWith('mailto:')) return true;
    if (rawHref.startsWith('tel:')) return true;

    if (a.hasAttribute('download')) return true;
    if (a.getAttribute('data-no-nav-loader') === '1') return true;

    const target = String(a.getAttribute('target') || '').trim().toLowerCase();
    if (target && target !== '_self') return true;

    let url;
    try {
      url = new URL(rawHref, location.href);
    } catch (_) {
      return true;
    }

    if (
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash
    ) {
      return true;
    }

    return false;
  }

  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    if (shouldSkipNavLoader(e, a)) return;
    showNavLoaderNow();
  }, true);

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form || (form.getAttribute && form.getAttribute('data-no-nav-loader') === '1')) return;
    showNavLoaderNow();
  }, true);

  function isInteractiveClickTarget(t){
    if (!t || !t.closest) return false;
    // ✅ No disparar loader por clicks dentro del menú de configuración (perfil abre drawer + fetch agenda)
    if (t.closest('#cwSettingsMenu')) return false;
    // ✅ Tampoco por click en el botón de abrir el menú
    if (t.closest('#cwSettingsBtn')) return false;

    const btn = t.closest('button');
    if (btn && !btn.disabled) return true;

    const a = t.closest('a[href]');
    if (a && a.getAttribute('href') && a.getAttribute('href') !== '#') return true;

    const rb = t.closest('[role="button"]');
    if (rb) return true;

    // opcional: si querés marcar manualmente elementos que disparan carga
    const marked = t.closest('[data-loader="1"]');
    if (marked) return true;

    return false;
  }

  // ✅ Solo consideramos “acción” si el click fue en botón/link (no cualquier click)
  document.addEventListener('click', (e) => {
    if (!isInteractiveClickTarget(e.target)) return;
    lastUserActionAt = Date.now();
    actionBudget = ACTION_BUDGET_MAX;
  }, true);

  // submit (forms)
  document.addEventListener('submit', (e) => {
    lastUserActionAt = Date.now();
    actionBudget = ACTION_BUDGET_MAX;
  }, true);

  function canTrackAsUserAction(){
    return actionBudget > 0 && (Date.now() - lastUserActionAt) <= ACTION_WINDOW_MS;
  }

  // =========================
  // ✅ Hook fetch() condicional:
  // SOLO cuenta requests disparados inmediatamente tras click/submit
  // =========================
  if (window.fetch){
    const _fetch = window.fetch.bind(window);
    window.fetch = function(...args){
      const shouldTrack = canTrackAsUserAction();
      if (shouldTrack){
        actionBudget -= 1;
        beginPending();
      }

      try{
        const p = _fetch(...args);
        return Promise.resolve(p).finally(() => {
          if (shouldTrack) endPending();
        });
      } catch (err){
        if (shouldTrack) endPending();
        throw err;
      }
    };
  }

  function resetAll(){
    pending = 0;
    pendingSince = 0;
    clearShowTimer();
    if (hardHideTimer){ clearTimeout(hardHideTimer); hardHideTimer = null; }
    hideNow();
  }

  window.addEventListener('pageshow', resetAll);
  window.addEventListener('load', resetAll);
})();