// public/js/tutorial-overlay.js
// v6.2 - agrega/quita 'tour-active' en <body> al abrir/cerrar; z-index máximo; tooltips 100% visibles
(function(){
  // ---------- Helpers base ----------
  function qs(s){ return document.querySelector(s); }
  function qsa(s){ return Array.from(document.querySelectorAll(s)); }
  function pick(selList){
    for (const sel of selList){
      const el = qs(sel);
      if (el) return el;
    }
    return null;
  }
  // extra helper para buscar por texto/aria-label
  function pickByText(rx, scope){
    const root = scope || document;
    const candidates = root.querySelectorAll('a,button,[role="button"],[aria-label]');
    for (const el of candidates){
      const label = (el.getAttribute('aria-label') || '').trim();
      const text  = (el.innerText || el.textContent || '').trim();
      if (rx.test(label) || rx.test(text)) return el;
    }
    return null;
  }
  function textMatchButtons(patterns){
    const candidates = qsa('button, a, [role="button"], .btn, .chip, .tag, [class*="btn"], [class*="chip"], [class*="tag"]');
    const found = [];
    for (const el of candidates){
      const t = (el.innerText || el.textContent || '').trim();
      if (!t) continue;
      for (const rx of patterns){
        if (rx.test(t)) { found.push(el); break; }
      }
    }
    return found;
  }
  function unionRect(els){
    if (!els || els.length === 0) return null;
    let r0 = els[0].getBoundingClientRect();
    let r = { top:r0.top, left:r0.left, right:r0.right, bottom:r0.bottom };
    for (let i=1;i<els.length;i++){
      const ri = els[i].getBoundingClientRect();
      r.top = Math.min(r.top, ri.top);
      r.left = Math.min(r.left, ri.left);
      r.right = Math.max(r.right, ri.right);
      r.bottom = Math.max(r.bottom, ri.bottom);
    }
    return { top:r.top, left:r.left, width:(r.right - r.left), height:(r.bottom - r.top) };
  }
  function nextMenuButton(afterEl){
    if (!afterEl) return null;
    const parent = afterEl.parentElement;
    if (!parent) return null;
    const items = Array.from(parent.querySelectorAll('a,button,[role="tab"],[role="button"]'));
    const idx = items.indexOf(afterEl);
    if (idx >= 0 && idx + 1 < items.length) return items[idx + 1];
    const gp = parent.parentElement;
    if (gp){
      const all = Array.from(gp.querySelectorAll('a,button,[role="tab"],[role="button"]'));
      const j = all.indexOf(afterEl);
      if (j >= 0 && j + 1 < all.length) return all[j + 1];
    }
    return null;
  }

  // ---------- CSS (tooltip arriba de todo, spotlight duro) ----------
  function ensureCSS(){
    if (document.getElementById('tour-shared-css')) return;
    const css = `
      .tour-backdrop{
        position:fixed; inset:0; background: rgba(15, 23, 42, 0);
        z-index:2147483644; display:none;
      }
      .tour-tooltip{
        position:fixed; max-width:420px; padding:16px 18px; background:#fff; color:#111827;
        border-radius:14px; box-shadow:0 20px 50px rgba(0,0,0,.35);
        line-height:1.45; font-size:14px; display:none; user-select:none;
        z-index:2147483660 !important; /* MÁXIMO Z-INDEX para estar por encima del fondo */
        isolation:isolate; mix-blend-mode:normal !important; filter:none !important; opacity:1 !important;
         z-index:2147483660 !important; mix-blend-mode: normal !important; filter: none !important; -webkit-filter:none !important; isolation:isolate; pointer-events:auto; }
      .tour-tooltip h4{ margin:0 0 6px; font-size:15px; font-weight:800 }
      .tour-sub{ color:#6b7280; font-size:12px; margin-top:8px }
      .no-dim{ isolation:isolate; mix-blend-mode:normal !important; filter:none !important; }
      .tour-close{
        position:fixed; top:16px; right:16px; z-index:2147483661;
        width:40px; height:40px; border-radius:50%; background:#fff; color:#111827; border:none; cursor:pointer;
        box-shadow:0 10px 24px rgba(0,0,0,.25); font-weight:800; display:none; line-height:40px;
      }
      /* Spotlight DURO (único) */
      #tourRectProxy{
        position:fixed; z-index:2147483650; pointer-events:none;
        border-radius:12px; /* se ajusta dinámicamente según el paso */
        outline:4px solid #ffffff;
        box-shadow:
          0 0 0 8px rgba(255,255,255,.90),
          0 0 40px 10px rgba(255,255,255,.65),
          0 0 24px 10px rgba(15,23,42,.25);
      }
      `;
    const style = document.createElement('style');
    style.id = 'tour-shared-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- Overlay ----------
  function ensureOverlay(){
    let backdrop = qs('#tourBackdrop');
    let tooltip  = qs('#tourTooltip');
    let closeBtn = qs('#tourClose');
    let proxy    = qs('#tourRectProxy');
    if (!backdrop){
      backdrop = document.createElement('div'); backdrop.id='tourBackdrop'; backdrop.className='tour-backdrop';
      document.body.appendChild(backdrop);
    }
    if (!tooltip){
      tooltip = document.createElement('div'); tooltip.id='tourTooltip'; tooltip.className='tour-tooltip no-dim';
      document.body.appendChild(tooltip);
    }
    if (!closeBtn){
      closeBtn = document.createElement('button'); closeBtn.id='tourClose'; closeBtn.className='tour-close'; closeBtn.setAttribute('aria-label','Cerrar'); closeBtn.textContent='×';
      document.body.appendChild(closeBtn);
    }
    if (!proxy){
      proxy = document.createElement('div'); proxy.id='tourRectProxy';
      document.body.appendChild(proxy);
    }
    return {backdrop, tooltip, closeBtn, proxy};
  }

  // Utilidad: chequear solapamiento entre rects
  function intersects(a, b, pad=0){
    return !(
      a.left > b.left + b.width + pad ||
      a.left + a.width + pad < b.left ||
      a.top > b.top + b.height + pad ||
      a.top + a.height + pad < b.top
    );
  }

  // Coloca tooltip SIEMPRE fuera; prueba lados y aplica fallback si aún solapa.
  function placeTooltipOutside(tooltip, spotRect, pref){
    const tw = Math.min(420, window.innerWidth - 24);
    tooltip.style.maxWidth = tw + 'px';

    const margin = 18;
    const sides = ['top','bottom','right','left'];
    const order = [pref, ...sides.filter(s => s !== pref)];

    function coords(side){
      let top, left;
      if (side === 'top'){
        top = Math.max(16, spotRect.top - tooltip.offsetHeight - margin);
        left = Math.min(window.innerWidth - tw - 16, Math.max(16, spotRect.left + spotRect.width/2 - tw/2));
      } else if (side === 'bottom'){
        top = Math.min(window.innerHeight - tooltip.offsetHeight - 16, spotRect.top + spotRect.height + margin);
        left = Math.min(window.innerWidth - tw - 16, Math.max(16, spotRect.left + spotRect.width/2 - tw/2));
      } else if (side === 'left'){
        top = Math.min(window.innerHeight - tooltip.offsetHeight - 16, Math.max(16, spotRect.top + spotRect.height/2 - tooltip.offsetHeight/2));
        left = Math.max(16, spotRect.left - tw - (margin + 6));
      } else { // right
        top = Math.min(window.innerHeight - tooltip.offsetHeight - 16, Math.max(16, spotRect.top + spotRect.height/2 - tooltip.offsetHeight/2));
        left = Math.min(window.innerWidth - tw - 16, spotRect.left + spotRect.width + (margin + 6));
      }
      return {top,left,width:tw,height:tooltip.offsetHeight};
    }

    for (const side of order){
      const r = coords(side);
      if (!intersects(r, spotRect, 6)){
        tooltip.style.top = r.top + 'px';
        tooltip.style.left = r.left + 'px';
        return;
      }
    }
    // Fallback duro: esquina superior izquierda con padding
    tooltip.style.top = '16px';
    tooltip.style.left = '16px';
  }

  function setRect(el, rect, padding=6){
    el.style.top = Math.max(8, rect.top - padding) + 'px';
    el.style.left = Math.max(8, rect.left - padding) + 'px';
    el.style.width = Math.max(0, rect.width + padding*2) + 'px';
    el.style.height = Math.max(0, rect.height + padding*2) + 'px';
    el.style.display = 'block';
  }

  // Rect anclado (viewport) con escala y desplazamiento opcional
  function anchoredRect(position, scaleX=1, scaleY=1, dx=0, dy=0){
    const m = 16;
    const baseW = 92, baseH = 92;
    let rect;
    if (position === 'bottom-left'){
      rect = { top: window.innerHeight - baseH - m, left: m, width: baseW, height: baseH, _viaAnchor:true };
    } else if (position === 'top-right'){
      rect = { top: m, left: Math.max(8, window.innerWidth - baseW - m), width: baseW, height: baseH, _viaAnchor:true };
    } else {
      rect = { top: window.innerHeight/2 - 40, left: window.innerWidth/2 - 160, width: 320, height: 80, _viaAnchor:true };
    }
    if (scaleX !== 1 || scaleY !== 1){
      const nw = rect.width * scaleX;
      const nh = rect.height * scaleY;
      const cx = rect.left + rect.width/2;
      const cy = rect.top + rect.height/2;
      rect.left = cx - nw/2;
      rect.top  = cy - nh/2;
      rect.width = nw;
      rect.height = nh;
    }
    rect.left = Math.max(0, rect.left + dx);
    rect.top  = Math.max(0, rect.top + dy);
    return rect;
  }

  // Ajustes por paso
  const MENU_KEYS = new Set(['menu-materias','menu-autoeval','menu-juegos','menu-correl','menu-finales','menu-profes','menu-grupos']);
  function tweakRectForKey(rect, key){
    const r = { ...rect };
    if (MENU_KEYS.has(key)){
      r.left = Math.max(0, r.left - 10);
    }
    if (key === 'usuario'){
      const scale = 0.30;
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      r.width  = r.width * scale;
      r.height = r.height * scale;
      r.left   = Math.max(0, cx - r.width/2 - 20);
      r.top    = Math.max(0, cy - r.height/2 + 18);
      r._forceCircle = true;
    }
    if (key === 'logout'){
      if (r._viaAnchor){
        const scaleX = 2.2, scaleY = 0.8;
        const cx = r.left + r.width/2, cy = r.top + r.height/2;
        r.width  = r.width * scaleX; r.height = r.height * scaleY;
        r.left   = Math.max(0, cx - r.width/2 - 140);
        r.top    = Math.max(0, cy - r.height/2);
      }
      r._forcePill = true;
    }
    return r;
  }

  function computeStepRect(step){
    let el = pick(step.targets);

    if (step.key === 'menu'){
      el = pick(S.menu) || el;
      if (el){
        const r = el.getBoundingClientRect();
        return { top:r.top, left:r.left, width:r.width, height:r.height };
      }
    }

    if (step.key === 'menu-materias'){
      el = pick(['nav.ios-dock a[aria-label="Materias"]']) || el;
    }
    if (step.key === 'menu-autoeval'){
      const materiasEl = pick(['nav.ios-dock a[aria-label="Materias"]']);
      const rightOfMaterias = nextMenuButton(materiasEl);
      el = rightOfMaterias || pick(['nav.ios-dock a[aria-label="Autoeval."]']) || el;
    }
    if (step.key === 'menu-juegos')    el = pick(['nav.ios-dock a[aria-label="Juegos"]']) || el;
    if (step.key === 'menu-correl')    el = pick(['nav.ios-dock a[aria-label="Correlativas"]']) || el;
    if (step.key === 'menu-finales')   el = pick(['nav.ios-dock a[aria-label="Finales"]']) || el;
    if (step.key === 'menu-profes')    el = pick(['nav.ios-dock a[aria-label="Profesores"]']) || el;
    if (step.key === 'menu-grupos')    el = pick(['nav.ios-dock a[aria-label="Grupos"]']) || el;

    if (step.key === 'filtro-anio'){
      const btns = textMatchButtons([/^(1[º°])$/, /^(2[º°])$/, /^(3[º°])$/, /^(4[º°])$/, /^(5[º°])$/, /^todas?$/i]);
      const r = unionRect(btns);
      if (r) return tweakRectForKey(r, step.key);
    }
    if (step.key === 'usuario'){
      const base = anchoredRect('bottom-left', 1, 1, 0, 0);
      return tweakRectForKey(base, step.key);
    }
    if (step.key === 'logout'){
      // v5 logic restaurada: buscar botón real y solo caer a anclaje si no aparece
      let target = pick(S.logout);
      if (!target) target = pickByText(/^(salir|cerrar sesi[oó]n|logout)$/i);
      if (target){
        const bb = target.getBoundingClientRect();
        // NO desplazamos ni reescalamos si es un elemento real (solo forma 'pill')
        const rect = { top:bb.top, left:bb.left, width:bb.width, height:bb.height };
        rect._forcePill = true;
        return rect;
      }
      // Fallback: anclado top-right con tweak horizontal
      const fb = anchoredRect('top-right', 1, 1, 0, 0);
      return tweakRectForKey(fb, step.key);
    }
    if (step.key === 'help'){
      el = pick(['.help-badge-fixed','#helpFab','#layoutTutorialBtn','[data-help="tutorial"]','.tutorial-btn','#tutorialBtn']) || el;
    }

    if (!el){
      const w = Math.min(320, window.innerWidth - 32);
      const h = 80;
      return { top: window.innerHeight/2 - h/2, left: window.innerWidth/2 - w/2, width:w, height:h };
    }
    const r = el.getBoundingClientRect();
    return tweakRectForKey({ top:r.top, left:r.left, width:r.width, height:r.height }, step.key);
  }

  function stepContent(title, body){
    return `<h4>${title}</h4><div>${body}</div><div class="tour-sub">Tocá en cualquier lugar para continuar</div>`;
  }

  const S = {
    menu: ['nav.ios-dock', '#mainMenu', '.menu-principal', '.nav-bottom', '.tabbar', '.menu-fixed-bottom', '.cw-bottom-menu'],
    materias: ['nav.ios-dock a[aria-label="Materias"]', '#menuMaterias', '[data-nav="materias"]', 'a[href*="materias"]', '.menu-item-materias'],
    autoeval: ['nav.ios-dock a[aria-label="Autoeval."]', '#menuAuto', '[data-nav="autoevaluaciones"]', 'a[href*="autoevaluaciones"]', '.menu-item-autoevaluaciones', '.menu-item-auto'],
    juegos: ['nav.ios-dock a[aria-label="Juegos"]', '#menuJuegos', '[data-nav="juegos"]', 'a[href*="juegos"]', '.menu-item-juegos', '.tab-juegos'],
    correlativas: ['nav.ios-dock a[aria-label="Correlativas"]', '#menuCorrelativas', '[data-nav="correlativas"]', 'a[href*="correlativas"]', '.menu-item-correlativas'],
    finales: ['nav.ios-dock a[aria-label="Finales"]', '#menuFinales', '[data-nav="finales"]', '.menu-item-finales'],
    profes: ['nav.ios-dock a[aria-label="Profesores"]', '#menuProfes', '[data-nav="profes"]', 'a[href*="profes"]', 'a[href*="profesores"]', '.menu-item-profes'],
    grupos: ['nav.ios-dock a[aria-label="Grupos"]', '#menuGrupos', '[data-nav="grupos"]', '.menu-item-grupos'],
    anios: ['#yearFilters', '.filters-year', 'nav.year-filters', '.filtros-anio'],
    search: ['#q', '.search-ios', '#searchBox', 'input[type="search"]', 'input.search'],
    usuario: ['#userCard', '.sidebar-user', '.account-chip', '.user-profile-mini', '.user-box'],
    logout: ['#btnLogout','a[href*="logout"]','a[href*="salir"]','.btn-logout','.salir','[data-action="logout"]','[aria-label*="logout" i]','[aria-label*="salir" i]'],
    help: ['#helpFab', '#layoutTutorialBtn', '[data-help="tutorial"]', '.help-badge-fixed', '.tutorial-btn', '#tutorialBtn']
  };

  // Pasos (incluye el de menú principal al inicio)
  const steps = [
    { key:'menu',           title:'Menú principal',    targets:S.menu,       pos:'top',    body:'Bienvenido a CleverWave. En el menú principal podés desplazarte por todas las secciones de la app.' },
    { key:'menu-materias',  title:'Materias',          targets:S.materias,   pos:'top',    body:'Seleccioná la materia que deseás para acceder a sus contenidos, novedades y seguimiento.' },
    { key:'menu-autoeval',  title:'Autoevaluaciones',  targets:S.autoeval,   pos:'top',    body:'Practicá con exámenes de 5 preguntas para prepararte para parciales o finales.' },
    { key:'menu-juegos',    title:'Juegos',            targets:S.juegos,     pos:'top',    body:'Aprovechá tu tiempo libre con preguntas aleatorias de distintas materias al mismo tiempo.' },
    { key:'menu-correl',    title:'Correlativas',      targets:S.correlativas,pos:'top',   body:'Visualizá las correlatividades para entender el recorrido académico recomendado.' },
    { key:'menu-finales',   title:'Finales',           targets:S.finales,    pos:'top',    body:'Consultá modalidades y requisitos de final para planificar tus mesas con tiempo.' },
    { key:'menu-profes',    title:'Profesores',        targets:S.profes,     pos:'top',    body:'Explorá calificaciones de otros alumnos, el Top 5 del mes y dejá tu propia valoración.' },
    { key:'menu-grupos',    title:'Grupos',            targets:S.grupos,     pos:'top',    body:'Unite a grupos de chat por materia para rendir acompañado, compartir información y pedir ayuda.' },
    { key:'filtro-anio',    title:'Filtro por año',    targets:S.anios,      pos:'bottom', body:'Elegí 1º, 2º, 3º, 4º, 5º o “Todas” para filtrar rápidamente la materia que buscás.' },
    { key:'busqueda',       title:'Barra de búsqueda', targets:S.search,     pos:'bottom', body:'Escribí el nombre de la materia para encontrarla al instante.' },
    { key:'usuario',        title:'Tus datos',         targets:S.usuario,    pos:'right',  body:'Acá ves tu nombre y foto de perfil.' },
    { key:'logout',         title:'Cerrar sesión',     targets:S.logout,     pos:'left',   body:'Al hacer clic, cerrarás tu sesión y podrás volver a ingresar cuando quieras.' },
    { key:'help',           title:'Ayuda',             targets:S.help,       pos:'left',   body:'Si tenés dudas, repetí el tutorial de esta sección las veces que necesites.' }
  ];

  function ensureReady(maxTries=60){
    return new Promise(resolve=>{
      let tries = 0;
      (function wait(){
        const hasAny = !!(pick(S.menu) || pick(S.materias) || pick(S.autoeval) || pick(S.juegos) || pick(S.correlativas));
        if (hasAny) return resolve();
        tries++;
        if (tries >= maxTries) return resolve();
        requestAnimationFrame(wait);
      })();
    });
  }

  function placeAndShow(els, step){
    const rect = computeStepRect(step);

    // Ajuste de forma del spotlight por paso:
    if (rect._forceCircle){
      els.proxy.style.borderRadius = '9999px';
    } else if (rect._forcePill){
      els.proxy.style.borderRadius = '18px';
    } else {
      els.proxy.style.borderRadius = '12px';
    }

    setRect(els.proxy, rect, 8);
    els.tooltip.innerHTML = stepContent(step.title, step.body);

    // Siempre colocar el tooltip afuera y al frente (sin oscurecer)
    requestAnimationFrame(()=> {
      placeTooltipOutside(els.tooltip, rect, step.pos);
      els.tooltip.style.zIndex = 2147483655; // por si algún CSS externo pisa z-index
    });
  }

  function startTour(){
    ensureCSS();
    // >>> Añadimos la marca global para que el CSS baje la toolbar y buscador detrás del overlay
    document.body.classList.add('tour-active');

    const els = ensureOverlay();
    const dockWrap = document.querySelector('.ios-dock-wrap');
    dockWrap && dockWrap.classList.add('tour-elevate');
    let idx = 0;
    let active = true;

    function show(i){
      const step = steps[i];
      if (!step) return end();
      els.backdrop.style.display = 'block';
      els.tooltip.style.display = 'block';
      els.closeBtn.style.display = 'block';
      placeAndShow(els, step);
    }
    function next(){
      idx++;
      if (idx >= steps.length) return end();
      show(idx);
    }
    function end(){
      const dockWrap = document.querySelector('.ios-dock-wrap');
      dockWrap && dockWrap.classList.remove('tour-elevate');
      active = false;
      els.backdrop.style.display = 'none';
      els.tooltip.style.display = 'none';
      els.closeBtn.style.display = 'none';
      els.proxy.style.display = 'none';
      // >>> Quitamos la marca global al cerrar el tutorial
      document.body.classList.remove('tour-active');
      window.removeEventListener('resize', onRelayout, true);
      window.removeEventListener('scroll', onRelayout, true);
      idx = 0;
    }
    function onRelayout(){
      if (!active) return;
      const step = steps[idx];
      if (!step) return;
      placeAndShow(els, step);
    }

    els.closeBtn.addEventListener('click', function onClose(e){ e.stopPropagation(); end(); }, { once:false });
    els.backdrop.addEventListener('click', function onBg(e){ e.preventDefault(); e.stopPropagation(); next(); }, { capture:true });
    els.tooltip.addEventListener('click', function onTip(e){ e.stopPropagation(); next(); }, { capture:true });

    window.addEventListener('resize', onRelayout, true);
    window.addEventListener('scroll', onRelayout, true);

    show(0);
  }

  async function boot(){
    const isMaterias = () =>
      (document.body?.dataset?.page === 'materias') ||
      location.pathname.toLowerCase().includes('/app/materias') ||
      document.title.toLowerCase().includes('materias');
    if (!isMaterias()) return;
    await ensureReady();

    window.startMateriasTour = startTour;
    document.addEventListener('open:tutorial', startTour);
    document.addEventListener('open-tutorial:materias', startTour);

    const helpBtn = pick(['.help-badge-fixed','#helpFab','#layoutTutorialBtn','[data-help="tutorial"]','.tutorial-btn','#tutorialBtn']);
    if (helpBtn){
      const handler = (e) => { e.preventDefault?.(); e.stopPropagation?.(); e.stopImmediatePropagation?.(); startTour(); };
      helpBtn.addEventListener('click', handler, { capture:true, passive:false });
      helpBtn.addEventListener('keydown', (e)=>{
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(e); }
      }, { capture:true, passive:false });
      if (helpBtn.hasAttribute('href')){
        helpBtn.dataset.hrefOriginal = helpBtn.getAttribute('href');
        helpBtn.setAttribute('href', '#');
        helpBtn.removeAttribute('data-route');
        helpBtn.setAttribute('role','button');
      }
    }
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();