// public/js/finales-tour.js
// Tutorial para Finales — estilo idéntico a Juegos/Autoevaluaciones:
// fondo oscuro con “agujero” (proxy con box-shadow 9999px) y tooltip que nunca se atenúa.
(function(){
  "use strict";

  /* ============ Helpers ============ */
  function qs(s){ return document.querySelector(s); }
  function px(n){ return Math.round(n) + "px"; }

  /* ============ CSS idéntico al de juegos/autoevaluaciones ============ */
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
      /* Spotlight que oscurece TODO menos el rectángulo resaltado */
      #tourRectProxy{
        position:fixed; z-index:2147483652; pointer-events:none;
        border-radius:12px;
        outline:4px solid #ffffff;
        box-shadow:
          0 0 0 8px rgba(255,255,255,.90),
          0 0 40px 10px rgba(255,255,255,.65),
          0 0 0 9999px rgba(15, 23, 42, 0.23); /* oscurecimiento principal */
      }
      /* Nunca se atenúa el tooltip ni lo que tenga esta clase */
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

  /* ============ Pasos (Finales) ============ */
  const steps = [
    {
      key: "cuadro",
      title: "Finales de cada materia",
      pos: "bottom",
      body: "En esta sección podrás visualizar las <strong>condiciones</strong> y la <strong>modalidad</strong> de los finales de todas las materias. Así vas a poder decidir <strong>cuándo rendir libre o regular</strong>, cómo prepararte y hacerlo <strong>más fácil de aprobar</strong>."
    },
    {
      key: "busqueda",
      title: "Barra de búsqueda",
      pos: "bottom",
      body: "Escribí el <strong>nombre de la materia</strong> para encontrarla <strong>más fácil y rápido</strong>."
    }
  ];

  /* ============ Localizar rectángulos (layout Finales) ============ */
  function computeStepRect(step){
    if (step.key === "cuadro"){
      // card o tabla principal
      const el = document.querySelector(".card.bg-white")
             || document.querySelector("table.min-w-full")
             || document.querySelector(".table-finales")
             || document.querySelector(".finales-wrap");
      if (el) return rectOf(el);
    }
    if (step.key === "busqueda"){
      const el = document.getElementById("searchInput")
             || document.querySelector('input[type="search"]')
             || document.querySelector(".search-input")
             || document.querySelector(".p-3.mb-4.flex.items-center")
             || document.querySelector(".searchbar");
      if (el) return rectOf(el);
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

    // Spotlight (mantiene borde blanco + glow + oscurecimiento alrededor)
    els.proxy.style.borderRadius = "12px";
    setRect(els.proxy, rect, 8);

    // Tooltip
    els.tooltip.innerHTML = stepContent(step.title, step.body);
    els.tooltip.style.display = "block";

    requestAnimationFrame(()=>{
      // “No-dim” reforzado (idéntico hack usado en juegos/autoeval)
      try{
        if (typeof forceUndim === "function") forceUndim();
      }catch(e){}
      const tip = document.getElementById("tourTooltip");
      if (tip){
        tip.classList.add("no-dim");
        tip.style.position="fixed";
        tip.style.zIndex="2147483669";
        tip.style.opacity="1";
        tip.style.filter="none";
        tip.style.webkitFilter="none";
        tip.style.mixBlendMode="normal";
        tip.style.isolation="isolate";
        tip.style.transform="translateZ(0)";
        tip.style.willChange="transform";
        if (tip.parentNode){ tip.parentNode.appendChild(tip); }
      }

      // Ubicación del tooltip
      if (step.pos === "center"){
        placeTooltip(els.tooltip, rect, "center");
      } else {
        placeTooltip(els.tooltip, rect, step.pos || "bottom");
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

  /* ============ Boot (ruta /app/finales y evento) ============ */
  function boot(){
    if (location.pathname.indexOf("/app/finales") !== 0) return;

    window.addEventListener("open-tutorial:finales", startTour);

    const fab = document.getElementById("helpFab");
    if (fab){
      fab.addEventListener("click", function(){
        setTimeout(()=>{ if (!startTour.__running) startTour(); }, 0);
      }, { capture:true });
    }

    // Debug opcional:
    window.__startFinalesTour = startTour;
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();