// public/js/correlativas-tour.js
// Tutorial para Correlativas — mismo estilo/funciones que Materias/Finales
// Click en cualquier lugar para avanzar. Botón ✕ circular fijo. Spotlight blanco con brillo.
(function(){
  function qs(s, root){ return (root||document).querySelector(s); }
  function qsa(s, root){ return Array.from((root||document).querySelectorAll(s)); }
  function px(n){ return Math.round(n) + 'px'; }

  // ====== Estilos compartidos (no toca tu tutorial-overlay.js) ======
  function ensureCSS(){
    if (document.getElementById('tour-shared-css')) return;
    const style = document.createElement('style');
    style.id = 'tour-shared-css';
    style.textContent = `
      .tour-backdrop{ position:fixed; inset:0; background: rgba(15, 23, 42, 0.13); z-index:2147483644; display:none; }
      .tour-tooltip{
        position:fixed; max-width:420px; padding:16px 18px; background:#fff; color:#111827;
        border-radius:14px; box-shadow:0 20px 50px rgba(0,0,0,.35);
        line-height:1.45; font-size:14px; display:none; user-select:none;
        z-index:2147483660 !important; isolation:isolate; mix-blend-mode:normal !important; filter:none !important;
      }
      .tour-tooltip h4{ margin:0 0 6px; font-size:15px; font-weight:800 }
      .tour-sub{ color:#9ca3af; font-size:12px; margin-top:10px }
      .tour-close{
        position:fixed; top:16px; right:16px; z-index:2147483661;
        width:44px; height:44px; border-radius:50%;
        display:flex; align-items:center; justify-content:center;
        background:#fff; color:#111827; border:none; cursor:pointer;
        box-shadow:0 10px 24px rgba(0,0,0,.25); font-weight:900; font-size:18px; line-height:1;
      }
      .tour-close:focus{ outline:2px solid rgba(0,0,0,.2) }
      /* Spotlight con borde/blanco y brillo */
      #tourRectProxy{
        position:fixed; z-index:2147483650; pointer-events:none;
        border-radius:12px;
        outline:6px solid #ffffff;
        box-shadow:
          0 0 0 12px rgba(255,255,255,.90),
          0 0 44px 14px rgba(255,255,255,.65),
          0 0 0 9999px rgba(15, 23, 42, 0.06); /* <= oscurecimiento principal */
      }
      #tourTooltip, #tourTooltip *, .tour-tooltip, .tour-tooltip *, .no-dim, .no-dim *{
        opacity:1 !important; filter:none !important; -webkit-filter:none !important; mix-blend-mode:normal !important; isolation:isolate;
      }
    `;
    document.head.appendChild(style);
  }

  // ====== Overlay mínimo (mismos IDs que el resto de secciones) ======
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
      closeBtn = document.createElement('button'); closeBtn.id='tourClose'; closeBtn.className='tour-close'; closeBtn.type='button';
      closeBtn.setAttribute('aria-label','Cerrar'); closeBtn.textContent='×';
      document.body.appendChild(closeBtn);
    }
    if (!proxy){
      proxy = document.createElement('div'); proxy.id='tourRectProxy';
      document.body.appendChild(proxy);
    }
    return {backdrop, tooltip, closeBtn, proxy};
  }

  // ====== Helpers ======
  function rectOf(el){
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top:r.top, left:r.left, width:r.width, height:r.height };
  }
  function unionRectOf(els){
    const a = els.filter(Boolean);
    if (!a.length) return null;
    let r0 = a[0].getBoundingClientRect();
    for (let i=1;i<a.length;i++){
      const b = a[i].getBoundingClientRect();
      const left = Math.min(r0.left,b.left), top = Math.min(r0.top,b.top);
      const right = Math.max(r0.right,b.right), bottom = Math.max(r0.bottom,b.bottom);
      r0 = { left, top, right, bottom, width:right-left, height:bottom-top };
    }
    return { top:r0.top, left:r0.left, width:r0.width, height:r0.height };
  }
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
        top = Math.min(window.innerHeight - tooltip.offsetHeight - 12, spotRect.top + spotRect.height + margin);
        left = Math.min(window.innerWidth - tw - 16, Math.max(16, spotRect.left + spotRect.width/2 - tw/2));
      } else if (side === 'left'){
        top = Math.min(window.innerHeight - tooltip.offsetHeight - 16, Math.max(16, spotRect.top + spotRect.height/2 - tooltip.offsetHeight/2));
        left = Math.max(16, spotRect.left - tw - margin);
      } else { // right
        top = Math.min(window.innerHeight - tooltip.offsetHeight - 16, Math.max(16, spotRect.top + spotRect.height/2 - tooltip.offsetHeight/2));
        left = Math.min(window.innerWidth - tw - 16, spotRect.left + spotRect.width + margin);
      }
      return { top, left };
    }

    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';
    document.body.offsetHeight;
    for (const side of order){
      const { top, left } = coords(side || 'bottom');
      tooltip.style.top = px(top);
      tooltip.style.left = px(left);
      const tt = tooltip.getBoundingClientRect();
      if (tt.top >= 8 && tt.left >= 8 && tt.bottom <= window.innerHeight - 8 && tt.right <= window.innerWidth - 8){
        tooltip.style.visibility = 'visible';
        return;
      }
    }
    tooltip.style.top = px(Math.max(16, spotRect.top + spotRect.height + margin));
    tooltip.style.left = px(Math.max(16, Math.min(window.innerWidth - tw - 16, spotRect.left + spotRect.width/2 - tw/2)));
    tooltip.style.visibility = 'visible';
  }
  function findByText(rx, scope){
    const root = scope || document;
    const all = root.querySelectorAll('*');
    for (const el of all){
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      if (rx.test(txt)) return el;
    }
    return null;
  }
  function firstVisibleNode(sel, root){
    const list = qsa(sel, root).filter(n => {
      const r = n.getBoundingClientRect();
      return r.width > 20 && r.height > 16;
    });
    return list[0] || null;
  }

  // ====== Pasos del tutorial (Correlativas) ======
  const steps = [
    { key:'mapa', title:'Mapa de materias y correlativas', pos:'top',
      body:'En esta sección podrás visualizar un <strong>mapa</strong> con las materias de tu carrera y plan, y sus <strong>correlativas</strong>. <br>Podés deslizarte con el mouse o el dedo, desplazarte y hacer <strong>zoom</strong> para verlas todas.' },
    { key:'materia', title:'Acciones por materia', pos:'right',
      body:'Además, podés marcar las materias que ya <strong>aprobaste</strong> y ver sus <strong>correlativas</strong> al hacer click en “Correlativas”, incluso observando visualmente los <strong>hilos</strong> que la conectan.' },
    { key:'banderas', title:'Sin correlativas / Filtro / Base', pos:'bottom',
      body:'Usá estos botones para resaltar rápidamente: <strong>sin correlativas</strong> (no tienen posteriores), <strong>materias filtro</strong> y <strong>materias base</strong>. Te ayuda a decidir en qué anotarte.' },
    { key:'anios', title:'Filtrar por año', pos:'bottom',
      body:'Seleccioná en qué <strong>año</strong> estás y se mostrarán solo las materias de tu año actual y <strong>anteriores</strong>, según lo que necesites.' },
    { key:'busqueda', title:'Buscar materia', pos:'bottom',
      body:'Buscá una materia en concreto escribiendo su <strong>nombre</strong>; se filtrarán las materias hasta encontrar la que querías.' },
    { key:'fullscreen', title:'Pantalla completa', pos:'left',
      body:'Al hacer click acá, vas a poder observar todas las materias y sus correlativas en <strong>pantalla completa</strong>. Al salir, se reactivará automáticamente la <strong>vista optimizada</strong>.' }
  ];

  // ====== Cálculo del rect por paso ======
  function computeStepRect(step){
    // NUEVO: priorizamos #contentBound / .contentBound para el paso 'mapa'
    const contentBound = qs('#contentBound') || qs('.contentBound');
    const centeredCard = qs('#correlativasMain.card.bg-white') || qs('.container .card.bg-white#correlativasMain') || qs('#correlativasMain.card') || qs('#correlativasMain');
    const mapArea = qs('#graphWrap') || qs('#mapaMaterias') || qs('.correlativas-wrap') || qs('#graphArea') || qs('#correlativasCanvas');

    if (step.key === 'mapa'){
      // prioridad: contentBound -> tarjeta central -> área del grafo
      const r = rectOf(contentBound) || rectOf(centeredCard) || rectOf(mapArea);
      return r || { top:100,left:100,width:400,height:200 };
    }

    if (step.key === 'materia'){
      const parent = mapArea || centeredCard || contentBound || document;
      const node = firstVisibleNode('.materia, .node, .subject, [data-node="materia"], .nodo-materia', parent)
               || findByText(/contabilidad\s*1|contabilidad\s*i/i, parent);
      const r = node ? rectOf(node) : rectOf(parent);
      return r || { top: Math.round(window.innerHeight/2-50), left: Math.round(window.innerWidth/2-100), width: 200, height: 100 };
    }

    if (step.key === 'banderas'){
      // Exactamente el botón "Sin correlativas"
      const wrap = qs('#flagsWrap') || qs('.flags-wrap') || document;
      let target = null;
      if (wrap){
        target = qsa('button, a', wrap).find(el => /sin\s+correlativas/i.test((el.textContent||'').trim()));
      }
      if (!target){
        target = qsa('button, a').find(el => /sin\s+correlativas/i.test((el.textContent||'').trim()));
      }
      return rectOf(target) || rectOf(wrap) || { top:80,left:20,width:150,height:36 };
    }

    if (step.key === 'anios'){
      const labels = ['Todos','1º','2º','3º','4º','5º','1°','2°','3°','4°','5°'];
      const found = labels.map(t=>findByText(new RegExp(`^\\s*${t}\\s*$`,'i'))).filter(Boolean);
      const union = unionRectOf(found);
      return union || { top:60,left:20,width:420,height:36 };
    }

    if (step.key === 'busqueda'){
      const el = qs('input[type="search"]') || qs('#searchInput') || qs('#searchMateria') || qs('.search-wrap input');
      return rectOf(el) || rectOf(qs('.search-wrap')) || { top:54,left:520,width:280,height:40 };
    }

    if (step.key === 'fullscreen'){
      const el = qs('.fullscreen-btn') || qs('[data-action="fullscreen"]') || qs('button[title*="pantalla" i]') || qs('button[aria-label*="pantalla" i]');
      if (el) return rectOf(el);
      const parent = centeredCard || mapArea || contentBound;
      if (parent){
        const r = parent.getBoundingClientRect();
        return { top:r.top+8, left:r.right-52, width:44, height:40 };
      }
    }

    // fallback genérico
    const w = Math.min(320, window.innerWidth - 32);
    const h = 100;
    return { top: Math.round(window.innerHeight/2 - h/2), left: Math.round(window.innerWidth/2 - w/2), width: w, height: h };
  }

  // ====== Render paso ======
  function showStep(els, step){
    let r = computeStepRect(step);
    const extra = 8; // padding para que el recuadro blanco sea un poco más grande
    r = { top:r.top - extra, left:r.left - extra, width:r.width + extra*2, height:r.height + extra*2 };

    const spot = els.proxy;
    spot.style.display = 'block';
    spot.style.top = px(r.top);
    spot.style.left = px(r.left);
    spot.style.width = px(r.width);
    spot.style.height = px(r.height);

    const t = els.tooltip;
    t.innerHTML = `<h4>${step.title}</h4>
                   <div>${step.body}</div>
                   <div class="tour-sub">Tocá en cualquier lugar para continuar</div>`;
    placeTooltipOutside(t, r, step.pos || 'bottom');
  }

  // ====== Control del tour ======
  function startTour(ev){
    if (window.__correlativasTourRunning) return;
    window.__correlativasTourRunning = true;

    ensureCSS();
    const els = ensureOverlay();
    els.backdrop.style.display = 'block';
    els.tooltip.style.display  = 'block';
    els.closeBtn.style.display = 'block';

    let i = 0;
    function render(){ showStep(els, steps[i]); }
    function next(){ i++; if (i>=steps.length){ stop(); return; } render(); }
    function stop(){
      window.__correlativasTourRunning = false;
      els.backdrop.style.display = 'none';
      els.tooltip.style.display  = 'none';
      els.closeBtn.style.display = 'none';
      els.proxy.style.display    = 'none';
      window.removeEventListener('resize', render, true);
      window.removeEventListener('scroll', render, true);
      document.removeEventListener('keydown', onKey);
      els.backdrop.removeEventListener('click', onAny, true);
      els.tooltip.removeEventListener('click', onAny, true);
      document.removeEventListener('click', onAny, true);
    }
    function onKey(e){ if (e.key === 'Escape') stop(); }
    function onAny(e){
      if (e.target === els.closeBtn) return;
      e.preventDefault(); e.stopPropagation(); next();
    }

    els.backdrop.addEventListener('click', onAny, true);
    els.tooltip.addEventListener('click', onAny, true);
    document.addEventListener('click', onAny, true);
    els.closeBtn.onclick = stop;

    render();
    window.addEventListener('resize', render, true);
    window.addEventListener('scroll', render, true);
    document.addEventListener('keydown', onKey);
  }

  // ====== Wire en /app/correlativas ======
  function boot(){
    if (location.pathname.indexOf('/app/correlativas')!==0) return;
    window.addEventListener('open-tutorial:correlativas', startTour);
    const fab = document.getElementById('helpFab');
    if (fab){
      fab.addEventListener('click', function(){
        setTimeout(()=>{ if (!startTour.__running) startTour(); }, 0);
      }, { capture:true });
    }
  }

  if (document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', boot); } else { boot(); }
})();