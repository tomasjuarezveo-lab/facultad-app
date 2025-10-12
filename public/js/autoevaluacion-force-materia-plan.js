
// public/js/autoevaluacion-force-materia-plan.js
(function(){
  "use strict";
  window.ensureMateriaPlan = function(materia, plan){
    if (!materia || !plan){
      alert('Seleccioná Materia y Plan primero.');
      return false;
    }
    location.href = '/app/autoevaluacion/' + encodeURIComponent(materia) + '/' + encodeURIComponent(plan);
    return true;
  }
})();
