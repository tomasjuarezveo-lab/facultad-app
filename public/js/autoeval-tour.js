// public/js/autoeval-tour.js
(function(){
  "use strict";

  /* ============ Helpers básicos ============ */
  function qs(s){ return document.querySelector(s); }
  function qsa(s){ return Array.from(document.querySelectorAll(s)); }
  function px(n){ return Math.round(n) + "px"; }

  function textMatchButtons(patterns){
    const candidates = qsa('button, a, [role="button"]');
    const found = [];
    for (const el of candidates){
      const t = (el.innerText || el.textContent || "").trim();
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

  /* ============ CSS (idéntico a Materias: fondo oscuro + tooltip brillante) ============ */
  function ensureCSS(){
    if (document.getElementById("tour-shared-css")) return;
    const css = `
      .tour-backdrop{
        position:fixed; inset:0; background:rgba(15, 23, 42, 0);
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
      /* Spotlight: oscurece TODO salvo el rectángulo resaltado (mantiene tu recuadro de bordes blancos) */
      #tourRectProxy{
        position:fixed; z-index:2147483652; pointer-events:none;
        border-radius:12px;
        outline:4px solid #ffffff;
        box-shadow:
          0 0 0 8px rgba(255,255,255,.90),
          0 0 40px 10px rgba(255,255,255,.65),
           0 0 0 9999px rgba(15, 23, 42, 0.23); /* <= oscurecimiento principal */
      }
      /* Los mensajes del tutorial nunca se atenúan */
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
      closeBtn.setAttribute("aria-label", "Cerrar");
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

  /* ============ Elevación SIN mover el DOM real (clones fijos) ============ */
  const __tourClones = [];
  function elevateClone(el){
    if(!el) return;
    if (el.__tourClone) return; // ya clonado
    const r = el.getBoundingClientRect();
    const clone = el.cloneNode(true);
    clone.classList.add("no-dim");
    clone.style.pointerEvents = "none";
    clone.style.position = "fixed";
    clone.style.left = px(r.left);
    clone.style.top = px(r.top);
    clone.style.width = px(r.width);
    clone.style.height = px(r.height);
    clone.style.margin = "0";
    clone.style.zIndex = "2147483666";
    clone.style.boxSizing = "border-box";
    document.body.appendChild(clone);
    el.__tourClone = clone;
    __tourClones.push({ el, clone });
  }

  function updateClones(){
    for (const pair of __tourClones){
      const el = pair.el, clone = pair.clone;
      const r = el.getBoundingClientRect();
      clone.style.left = px(r.left);
      clone.style.top = px(r.top);
      clone.style.width = px(r.width);
      clone.style.height = px(r.height);
    }
  }

  function clearClones(){
    for (const pair of __tourClones){
      if (pair.clone && pair.clone.parentNode) pair.clone.parentNode.removeChild(pair.clone);
      if (pair.el) pair.el.__tourClone = null;
    }
    __tourClones.length = 0;
  }

  /* ============ Selectores clave en Autoevaluación ============ */
  const S = {
    yearPanel: ['#yearPanel', '.year-panel'],
    search: ['.search-wrap', '#qSubjects', 'input[type="search"]', '.search-ios'],
    content: ['#subjectsGrid', '.grid-subjects', '.grid'] // donde está la grilla/lista de materias
  };

  /* ============ Pasos del tour ============ */
  const steps = [
    {
      key: 'contenido',
      title: 'Practicar con preguntas reales',
      pos: 'center', // 🡐 mensaje centrado sobre el MISMO recuadro de bordes blancos
      body: 'En esta sección podés practicar con <strong>exámenes aleatorios</strong> armados con preguntas reales. Son <strong>5 preguntas</strong>. Al finalizar ves tu <strong>puntaje</strong> y podés <strong>revisar</strong> tus respuestas y las correctas.'
    },
    {
      key: 'panel-anios',
      title: 'Elegí el año',
      pos: 'right', // 🡐 mensaje a la derecha del rectángulo de los botones 1º…Todos
      body: 'Con los botones <strong>1º, 2º, 3º, 4º, 5º</strong> y <strong>Todos</strong> filtrás por año para encontrar más rápido.'
    },
    {
      key: 'busqueda',
      title: 'Buscá una materia puntual',
      pos: 'bottom', // 🡐 mensaje debajo y centrado de la barra de búsqueda
      body: 'Escribí el nombre de la <strong>materia</strong> para filtrar la lista al instante y entrar directo a practicar.'
    }
  ];

  /* ============ Cálculo del rectángulo de cada paso ============ */
  function computeStepRect(step){
    const vw = window.innerWidth, vh = window.innerHeight;

    if (step.key === 'contenido'){
      // Usa el contenedor REAL de contenido para mantener tu recuadro de bordes blancos intacto
      for (const sel of S.content){
        const el = qs(sel);
        if (el){
          const r = el.getBoundingClientRect();
          return { top:r.top, left:r.left, width:r.width, height:r.height };
        }
      }
      // Fallback: centrado
      const w = Math.min(520, Math.round(vw*0.6)), h = 160;
      return { top: Math.round((vh - h)/2), left: Math.round((vw - w)/2), width:w, height:h };
    }

    if (step.key === 'panel-anios'){
      for (const sel of S.yearPanel){
        const el = qs(sel);
        if (el){
          const r = el.getBoundingClientRect();
          return { top:r.top, left:r.left, width:r.width, height:r.height };
        }
      }
      // Alternativa: unimos botones por texto
      const btns = textMatchButtons([/^(1[º°])$/, /^(2[º°])$/, /^(3[º°])$/, /^(4[º°])$/, /^(5[º°])$/, /^todas?$/i, /^todos?$/i]);
      const r = unionRect(btns); if (r) return r;
    }

    if (step.key === 'busqueda'){
      for (const sel of S.search){
        const el = qs(sel);
        if (el){
          const r = el.getBoundingClientRect();
          return { top:r.top, left:r.left, width:r.width, height:r.height };
        }
      }
    }

    // Fallback centro pequeño
    return { top: Math.round(vh/2-40), left: Math.round(vw/2-160), width:320, height:80 };
  }

  /* ============ Render del tooltip ============ */
  function stepContent(title, body){
    return `<h4>${title}</h4><div>${body}</div><div class="tour-sub">Tocá en cualquier lugar para continuar</div>`;
  }

  function placeTooltip(tooltip, rect, pos){
    const tw = Math.min(420, window.innerWidth - 24);
    tooltip.style.maxWidth = tw + "px";

    let top, left;
    if (pos === "center"){
      // Centrar el mensaje sobre el rectángulo
      top  = rect.top + (rect.height/2) - (tooltip.offsetHeight/2);
      left = rect.left + (rect.width/2) - (tw/2);
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

    // Limites de viewport
    top  = Math.max(16, Math.min(top, window.innerHeight - tooltip.offsetHeight - 16));
    left = Math.max(16, Math.min(left, window.innerWidth - tw - 16));

    tooltip.style.top = px(top);
    tooltip.style.left = px(left);
  }

  /* ============ Posicionar spotlight + tooltip ============ */
  function setRect(el, rect, padding=6){
    el.style.top = Math.max(8, rect.top - padding) + "px";
    el.style.left = Math.max(8, rect.left - padding) + "px";
    el.style.width = Math.max(0, rect.width + padding*2) + "px";
    el.style.height = Math.max(0, rect.height + padding*2) + "px";
    el.style.display = "block";
  }

  function placeAndShow(els, step){
    const rect = computeStepRect(step);

    // Spotlight (mantiene tu recuadro de bordes blancos)
    els.proxy.style.borderRadius = "12px";
    setRect(els.proxy, rect, 8);

    // Tooltip
    els.tooltip.innerHTML = stepContent(step.title, step.body);
    els.tooltip.style.display = "block";
    requestAnimationFrame(()=> placeTooltip(els.tooltip, rect, step.pos));
  }

  /* ============ Ciclo del tour ============ */
  function startTour(){
    ensureCSS();
    const els = ensureOverlay();

    // Elevar VISUALMENTE sin mover layout (clones):
    const elYear   = qs("#yearPanel") || qs(".year-panel");
    const elSearch = qs(".search-wrap") || qs("#qSubjects") || qs("input.search-ios");
    const elBadge  = qs(".user-badge-fixed");
    const elSalir  = qs("header form button");
    [elSearch, elBadge, elSalir].filter(Boolean).forEach(elevateClone);

    let idx = 0;
    let active = true;

    function show(i){
      (function(){ try{ if(typeof forceUndim==='function') forceUndim(); }catch(e){} var tip=document.getElementById('tourTooltip'); if(tip){ tip.classList.add('no-dim'); tip.style.position='fixed'; tip.style.zIndex='2147483669'; tip.style.opacity='1'; tip.style.filter='none'; tip.style.webkitFilter='none'; tip.style.mixBlendMode='normal'; tip.style.isolation='isolate'; tip.style.transform='translateZ(0)'; tip.style.willChange='transform'; if(tip.parentNode){ tip.parentNode.appendChild(tip);} } })();

      const step = steps[i];
      if (!step) return end();
      els.backdrop.style.display = "block";
      els.tooltip.style.display  = "block";
      els.closeBtn.style.display = "block";
      els.proxy.style.display    = "block";
      placeAndShow(els, step);
      updateClones();
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
      clearClones();            // ✅ CORREGIDO (llamada simple, sin "let")
      idx = 0;
    }

    function onRelayout(){
      if (!active) return;
      const step = steps[idx];
      if (!step) return;
      placeAndShow(els, step);
      updateClones();
    }

    els.closeBtn.addEventListener("click", function(e){ e.stopPropagation(); end(); }, { capture:false });
    els.backdrop.addEventListener("click", function(e){ e.preventDefault(); e.stopPropagation(); next(); }, { capture:true });
    els.tooltip.addEventListener("click", function(e){ e.stopPropagation(); next(); }, { capture:true });

    window.addEventListener("resize", onRelayout, true);
    window.addEventListener("scroll", onRelayout, true);

    show(0);
  }

  /* ============ Boot: escucha SIEMPRE en window ============ */
  function boot(){
    // El layout dispara: window.dispatchEvent(new CustomEvent('open-tutorial:autoevaluaciones', {bubbles:true}));
    window.addEventListener("open-tutorial:autoevaluaciones", startTour);
    // Debug opcional:
    window.__startAutoevalTour = startTour;
  }
  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
