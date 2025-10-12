// public/js/juegos-tour.js
// Tutorial para Juegos — spotlight idéntico a Autoevaluaciones (fondo oscuro con “agujero”)
// y tooltip siempre sin atenuar.

(function(){
  "use strict";

  /* ============ Helpers ============ */
  function qs(s){ return document.querySelector(s); }
  function px(n){ return Math.round(n) + "px"; }

  /* ============ CSS igual al de autoevaluaciones (clave: proxy con sombra 9999px) ============ */
  function ensureCSS(){
    if (document.getElementById("tour-shared-css")) return;
    const css = `
      .tour-backdrop{
        position:fixed; inset:0; background:rgba(15,23,42,0);
        z-index:2147483640; display:none;
      }
      .tour-tooltip{
        position:fixed; max-width:420px; padding:16px 18px; background:#fff; color:#111827;
        border-radius:14px; box-shadow:0 20px 50px rgba(0,0,0,.35);
        line-height:1.45; font-size:14px; display:none; user-select:none;
        z-index:2147483665 !important; isolation:isolate; mix-blend-mode:normal !important; filter:none !important;
      }
      .tour-tooltip h4{ margin:0 0 6px; font-size:15px; font-weight:800 }
      .tour-sub{ color:#6b7280; font-size:12px; margin-top:8px }
      .tour-close{
        position:fixed; top:16px; right:16px; z-index:2147483664;
        width:40px; height:40px; border-radius:50%; background:#fff; color:#111827; border:none; cursor:pointer;
        box-shadow:0 10px 24px rgba(0,0,0,.25); font-weight:800; display:none; line-height:40px;
      }
      /* Spotlight que oscurece TODO menos el rectángulo resaltado (mismo efecto que autoeval) */
      #tourRectProxy{
        position:fixed; z-index:2147483652; pointer-events:none;
        border-radius:12px;
        outline:4px solid #ffffff;
        box-shadow:
          0 0 0 8px rgba(255,255,255,.90),
          0 0 40px 10px rgba(255,255,255,.65),
          0 0 0 9999px rgba(15, 23, 42, 0.23); /* <= oscurecimiento principal */
      }
      /* Nunca se atenua el tooltip ni lo que tenga esta clase */
      .no-dim, .no-dim *{
        opacity:1 !important; filter:none !important; mix-blend-mode:normal !important; isolation:isolate !important;
      }
    `;
    const style = document.createElement("style");
    style.id = "tour-shared-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ============ Overlay (backdrop + tooltip + botón + proxy) ============ */
  function ensureOverlay(){
    let backdrop = qs("#tourBackdrop");
    let tooltip  = qs("#tourTooltip");
    let closeBtn = qs("#tourClose");
    let proxy    = qs("#tourRectProxy");

    if (!backdrop){
      backdrop = document.createElement("div");
      backdrop.id = "tourBackdrop";
      backdrop.className = "tour-backdrop";
      document.body.appendChild(backdrop);
    }
    if (!tooltip){
      tooltip = document.createElement("div");
      tooltip.id = "tourTooltip";
      tooltip.className = "tour-tooltip no-dim";
      document.body.appendChild(tooltip);
    }
    if (!closeBtn){
      closeBtn = document.createElement("button");
      closeBtn.id = "tourClose";
      closeBtn.className = "tour-close";
      closeBtn.setAttribute("aria-label","Cerrar");
      closeBtn.textContent = "×";
      document.body.appendChild(closeBtn);
    }
    if (!proxy){
      proxy = document.createElement("div");
      proxy.id = "tourRectProxy";
      document.body.appendChild(proxy);
    }
    return {backdrop, tooltip, closeBtn, proxy};
  }

  /* ============ Geometría ============ */
  function setRect(el, rect, padding=8){
    el.style.top    = Math.max(8, rect.top - padding) + "px";
    el.style.left   = Math.max(8, rect.left - padding) + "px";
    el.style.width  = Math.max(0, rect.width  + padding*2) + "px";
    el.style.height = Math.max(0, rect.height + padding*2) + "px";
    el.style.display = "block";
  }

  function rectOf(el){
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top:r.top, left:r.left, width:r.width, height:r.height, right:r.right, bottom:r.bottom };
  }

  function placeTooltip(tooltip, rect, pos){
    const tw = Math.min(420, window.innerWidth - 24);
    tooltip.style.maxWidth = tw + "px";
    let top, left;

    if (pos === "center"){
      top  = rect.top + (rect.height/2) - (tooltip.offsetHeight/2);
      left = rect.left + (rect.width/2)  - (tw/2);
    } else if (pos === "right"){
      top  = rect.top;
      left = rect.left + rect.width + 24;
    } else if (pos === "bottom"){
      top  = rect.top + rect.height + 12;
      left = rect.left + (rect.width/2) - (tw/2);
    } else {
      top  = rect.top + rect.height + 12;
      left = rect.left;
    }

    // límites viewport
    top  = Math.max(16, Math.min(top,  window.innerHeight - tooltip.offsetHeight - 16));
    left = Math.max(16, Math.min(left, window.innerWidth  - tw                  - 16));

    tooltip.style.top  = px(top);
    tooltip.style.left = px(left);
  }

  /* ============ Pasos (tus textos originales) ============ */
  const steps = [
    { key:'ruleta',   title:'La ruleta de materias', pos:'right',
      body:'En esta sección podés seleccionar las materias en la <strong>ruleta</strong> haciendo clic en el nombre y luego presionar <strong>Girar</strong>. Una vez que se detenga, vas a recibir una <strong>pregunta aleatoria</strong> de la materia en la que cayó. Es un excelente método para <strong>jugar y aprender</strong>, ideal para cuando estás cansado de leer y querés <strong>distraerte del estudio</strong> pero <strong>seguir avanzando</strong> a la vez.' },
    { key:'puntos',   title:'Mis puntos', pos:'bottom',
      body:'En <strong>Mis puntos</strong> ves tu puntaje acumulado: por cada <strong>respuesta correcta</strong> ganás <strong>1 punto</strong>. ¡Sumá todos los que puedas y superá tu propio récord!' },
    { key:'materias', title:'Cantidad de materias', pos:'bottom',
      body:'Elegí cuántas <strong>materias</strong> querés incluir en la ruleta (2, 3, 4 o 5). <br><strong>Recomendación:</strong> configurá la misma cantidad de materias que estés practicando para rendir. Así <strong>variás el estudio</strong> y mantenés el entrenamiento entretenido.' }
  ];

  /* ============ Localizar rectángulos según tu layout de Juegos ============ */
  function getRouletteRect(){
    const el = document.querySelector('.wheel')
           || document.querySelector('.wheel-stage')
           || document.querySelector('#wheelSvg')
           || document.querySelector('.wheel-svg')
           || document.querySelector('#ruleta')
           || document.querySelector('.ruleta')
           || document.querySelector('[data-wheel]')
           || document.querySelector('[data-ruleta]');
    if (!el) return null;
    return rectOf(el);
  }

  function computeStepRect(step){
    if (step.key === 'ruleta'){
      const rr = getRouletteRect(); if (rr) return rr;
    }
    if (step.key === 'puntos'){
      const el = qs('.points-badge'); if (el) return rectOf(el);
    }
    if (step.key === 'materias'){
      const el = qs('#countWrap') || qs('.count-wrap'); if (el) return rectOf(el);
    }
    // Fallback centrado
    const w = Math.min(520, Math.round(window.innerWidth*0.6)), h = 120;
    return { top: Math.round((window.innerHeight - h)/2), left: Math.round((window.innerWidth - w)/2), width:w, height:h };
  }

  /* ============ Render tooltip ============ */
  function stepContent(title, body){
    return `<h4>${title}</h4><div>${body}</div><div class="tour-sub">Tocá en cualquier lugar para continuar</div>`;
  }

  /* ============ Posicionar spotlight + tooltip ============ */
  function placeAndShow(els, step){
    const rect = computeStepRect(step);

    // Spotlight igual a autoeval (mantiene tu borde blanco con glow + oscurecimiento alrededor)
    els.proxy.style.borderRadius = "12px";
    setRect(els.proxy, rect, 8);   // padding leve para el halo

    // Tooltip
    els.tooltip.innerHTML = stepContent(step.title, step.body);
    els.tooltip.style.display = "block";

    requestAnimationFrame(()=>{
      // “No-dim” reforzado (idéntico hack usado en autoeval)
      try{
        if (typeof forceUndim === 'function') forceUndim();
      }catch(e){}
      const tip = document.getElementById('tourTooltip');
      if (tip){
        tip.classList.add('no-dim');
        tip.style.position='fixed';
        tip.style.zIndex='2147483669';
        tip.style.opacity='1';
        tip.style.filter='none';
        tip.style.webkitFilter='none';
        tip.style.mixBlendMode='normal';
        tip.style.isolation='isolate';
        tip.style.transform='translateZ(0)';
        tip.style.willChange='transform';
        if (tip.parentNode){ tip.parentNode.appendChild(tip); }
      }

      // Ubicación del tooltip
      if (step.key === 'materias'){
        // centrado bajo el bloque de botones (manteniendo tu comportamiento anterior)
        const tb = els.tooltip.getBoundingClientRect();
        let left = rect.left + (rect.width - tb.width)/2;
        let top  = rect.bottom + 14;
        const vw = Math.max(document.documentElement.clientWidth, window.innerWidth||0);
        const vh = Math.max(document.documentElement.clientHeight, window.innerHeight||0);
        if (left < 12) left = 12;
        if (left + tb.width > vw - 12) left = Math.max(12, vw - tb.width - 12);
        if (top + tb.height > vh - 12) top = Math.max(12, rect.top - tb.height - 14);
        els.tooltip.style.left = left + 'px';
        els.tooltip.style.top  = top  + 'px';
        els.tooltip.style.right = 'auto';
        els.tooltip.style.bottom = 'auto';
      } else if (step.pos === 'center'){
        placeTooltip(els.tooltip, rect, 'center');
      } else {
        placeTooltip(els.tooltip, rect, step.pos || 'bottom');
      }
    });
  }

  /* ============ Ciclo del tour ============ */
  function startTour(){
    if (startTour.__running) return;
    startTour.__running = true;

    ensureCSS();
    const els = ensureOverlay();

    let idx = 0;
    let active = true;

    function show(i){
      const step = steps[i];
      if (!step) return end();
      els.backdrop.style.display = "block";
      els.tooltip.style.display  = "block";
      els.closeBtn.style.display = "block";
      els.proxy.style.display    = "block";
      placeAndShow(els, step);
    }

    function next(){ idx++; if (idx >= steps.length) return end(); show(idx); }

    function end(){
      active = false;
      els.backdrop.style.display = "none";
      els.tooltip.style.display  = "none";
      els.closeBtn.style.display = "none";
      els.proxy.style.display    = "none";
      window.removeEventListener("resize", onRelayout, true);
      window.removeEventListener("scroll", onRelayout, true);
      idx = 0;
      startTour.__running = false;
    }

    function onRelayout(){
      if (!active) return;
      const step = steps[idx];
      if (!step) return;
      placeAndShow(els, step);
    }

    els.closeBtn.addEventListener("click", function(e){ e.stopPropagation(); end(); }, { capture:false });
    els.backdrop.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); next(); }, { capture:true });
    els.tooltip.addEventListener("click", function(e){ e.stopPropagation(); next(); }, { capture:true });

    window.addEventListener("resize", onRelayout, true);
    window.addEventListener("scroll", onRelayout, true);

    show(0);
  }

  /* ============ Boot (mantengo tu fallback por FAB) ============ */
  function boot(){
    if (location.pathname.indexOf('/app/juegos') !== 0) return;

    // Si el layout emite un evento específico para juegos, escuchalo
    window.addEventListener('open-tutorial:juegos', startTour);

    // Fallback: enganchar el FAB de ayuda
    const fab = document.getElementById('helpFab');
    if (fab){
      fab.addEventListener('click', function(){
        setTimeout(()=>{ if (!startTour.__running) startTour(); }, 0);
      }, { capture:true });
    }

    // Debug opcional:
    window.__startJuegosTour = startTour;
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();