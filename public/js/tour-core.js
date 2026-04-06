// public/js/tour-core.js
// Core compartido para TODOS los tours: CSS canónico + helper forceUndim
(function(){
  function installTourCSS(){
    // 1) Borrar estilos viejos que puedan pisar
    ['tour-shared-css','tour-css','tour-materias-css','tour-juegos-css','autoeval-tour-css']
      .forEach(id => { const n = document.getElementById(id); if (n) n.remove(); });

    // 2) Inyectar el CSS canónico (idéntico a Autoevaluaciones)
    const css = `
      .tour-backdrop{
        position:fixed; inset:0; background: rgba(15,23,42,0);
        z-index:2147483640; display:none;
      }
      .tour-tooltip{
        position:fixed; max-width:420px; padding:16px 18px; background:#fff; color:#111827;
        border-radius:14px; box-shadow:0 20px 50px rgba(0,0,0,.35);
        line-height:1.45; font-size:14px; display:none; user-select:none;
        z-index:2147483665 !important; isolation:isolate; mix-blend-mode:normal !important; filter:none !important; opacity:1 !important;
      }
      .tour-tooltip h4{ margin:0 0 6px; font-size:15px; font-weight:800 }
      .tour-sub{ color:#6b7280; font-size:12px; margin-top:8px }
      .no-dim, .no-dim *{
        opacity:1 !important; filter:none !important; mix-blend-mode:normal !important; isolation:isolate !important;
      }
      .tour-close{
        position:fixed; top:16px; right:16px; z-index:2147483664;
        width:40px; height:40px; border-radius:50%; background:#fff; color:#111827; border:none; cursor:pointer;
        box-shadow:0 10px 24px rgba(0,0,0,.25); font-weight:800; display:none; line-height:40px;
      }
      /* Spotlight con "agujero": oscurece TODO salvo el rectángulo resaltado */
      #tourRectProxy{
        position:fixed; z-index:2147483652; pointer-events:none;
        border-radius:12px;
        outline:4px solid #ffffff;
        box-shadow:
          0 0 0 8px rgba(255,255,255,.90),
          0 0 40px 10px rgba(255,255,255,.65),
          0 0 0 9999px rgba(15, 23, 42, 0.51);
      }
      /* Defensa ante globales raros */
      html, body, #app { mix-blend-mode:normal !important; isolation:auto !important; }
    `;
    const style = document.createElement('style');
    style.id = 'tour-shared-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Mantiene el tooltip brillante incluso si otro CSS intenta atenuarlo
  function forceUndim(){
    const tip = document.getElementById('tourTooltip');
    if (!tip) return;
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

  // Exponer helpers globales
  window.installTourCSS = installTourCSS;
  window.forceUndim = forceUndim;

  // Instalar CSS apenas carga el core (seguro)
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', installTourCSS);
  } else {
    installTourCSS();
  }
})();