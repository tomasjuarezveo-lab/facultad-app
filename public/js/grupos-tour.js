// public/js/grupos-tour.js
// Tutorial para Grupos — spotlight idéntico a Juegos/Autoevaluaciones
// y tooltip siempre sin atenuar.

(function(){
  "use strict";

  function qs(s){ return document.querySelector(s); }
  function px(n){ return Math.round(n) + "px"; }

  function onGrupos(){ return location.pathname.indexOf("/app/grupos") === 0; }

  function ensureCSS(){
    if (document.getElementById("tour-shared-css")) return;
    const css = `
      .tour-backdrop{
        position:fixed; inset:0; background:rgba(15, 23, 42, 0.16);
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
      #tourRectProxy{
        position:fixed; z-index:2147483652; pointer-events:none;
        border-radius:12px;
        outline:4px solid #ffffff;
        box-shadow:
          0 0 0 8px rgba(255,255,255,.90),
          0 0 40px 10px rgba(255,255,255,.65),
          0 0 0 9999px rgba(15, 23, 42, 0.06);
      }
      .no-dim, .no-dim *{
        opacity:1 !important; filter:none !important; mix-blend-mode:normal !important; isolation:isolate !important;
      }
    `;
    const style = document.createElement("style");
    style.id = "tour-shared-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

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
    return { top:r.top, left:r.left, width:r.width, height:r.height };
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

    top  = Math.max(16, Math.min(top,  window.innerHeight - tooltip.offsetHeight - 16));
    left = Math.max(16, Math.min(left, window.innerWidth  - tw                  - 16));

    tooltip.style.top  = px(top);
    tooltip.style.left = px(left);
  }

  // Pasos
  const steps = [
    { key:"principal", title:"Unite a grupos de chat", pos:"top",
      body:"En esta sección podés unirte a <strong>grupos de chat de las materias</strong> que vayas a rendir. Podés <strong>preguntar, compartir información</strong> y enterarte de novedades con quienes vayan a rendir en la misma mesa que vos. Así podés <strong>comunicarte</strong> con otros e incluso <strong>calmar los nervios</strong> antes del examen.",
      target:".list, #groupsList" },
    { key:"tabs", title:"Mis grupos y Explorar", pos:"bottom",
      body:"Al hacer clic en <strong>Explorar</strong> vas a poder <strong>buscar la materia</strong> que pensás rendir y unirte de inmediato al grupo. Una vez lo hagas, el grupo aparecerá en <strong>Mis grupos</strong> para que accedas más fácil y rápido.",
      target:".tabs-wrap, .anio-bar" },
    { key:"buscar", title:"Buscar grupo", pos:"bottom",
      body:"Escribí el <strong>nombre del grupo</strong> que buscás y aparecerá al instante.",
      target:".searchbar, #liveSearch" }
  ];

  function findTarget(selList){
    if (!selList) return null;
    const parts = selList.split(",").map(s=>s.trim());
    for (const s of parts){
      const el = qs(s);
      if (el) return el;
    }
    return null;
  }

  function computeStepRect(step){
    const el = findTarget(step.target);
    if (el) return rectOf(el);
    const w = Math.min(420, window.innerWidth - 32), h = 120;
    return { top: Math.round((window.innerHeight-h)/2), left: Math.round((window.innerWidth-w)/2), width:w, height:h };
  }

  function stepContent(title, body){
    return `<h4>${title}</h4><div>${body}</div><div class="tour-sub">Tocá en cualquier lugar para continuar</div>`;
  }

  function placeAndShow(els, step){
    const rect = computeStepRect(step);
    els.proxy.style.borderRadius = "12px";
    setRect(els.proxy, rect, 8);

    els.tooltip.innerHTML = stepContent(step.title, step.body);
    els.tooltip.style.display = "block";

    requestAnimationFrame(()=>{ placeTooltip(els.tooltip, rect, step.pos||"bottom"); });
  }

  function startTour(){
    if (!onGrupos()) return;
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

    function next(){ idx++; if (idx>=steps.length) return end(); show(idx); }

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

  function boot(){
    if (!onGrupos()) return;
    window.addEventListener("open-tutorial:grupos", startTour);
    const fab = document.getElementById("helpFab");
    if (fab){
      fab.addEventListener("click", function(){
        setTimeout(()=>{ if (!startTour.__running) startTour(); }, 0);
      }, { capture:true });
    }
    window.__startGruposTour = startTour;
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();