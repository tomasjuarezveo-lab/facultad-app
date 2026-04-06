
// public/js/juegos-force-materia-plan.js
// Úsalo cuando la ruleta se detiene: llama goToMateriaPlan(materia, plan)
(function(){
  "use strict";
  window.goToMateriaPlan = function(materia, plan){
    if (!materia || !plan){
      alert('La ruleta debe definir Materia y Plan.');
      return false;
    }
    // Navega a la pantalla de juego de esa materia/plan
    location.href = '/app/juegos/' + encodeURIComponent(materia) + '/' + encodeURIComponent(plan);
    return true;
  }
})();
