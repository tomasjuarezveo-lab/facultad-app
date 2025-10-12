// public/js/autoevaluacion-tour-dim-override.js
(function(){
  const ID = 'autoevaluacion-tour-dim-override';
  if (document.getElementById(ID)) return;
  const style = document.createElement('style');
  style.id = ID;
  style.textContent = `
    .tour-backdrop,
    #tourBackdrop,
    .tutorial-backdrop {
      background: rgba(15,23,42,.58) !important;
    }
    #tourTooltip, #tourTooltip *,
    .tour-tooltip, .tour-tooltip *,
    .no-dim, .no-dim * {
      opacity: 1 !important;
      filter: none !important;
      -webkit-filter: none !important;
      mix-blend-mode: normal !important;
      isolation: isolate;
    }
  `;
  document.head.appendChild(style);
})();