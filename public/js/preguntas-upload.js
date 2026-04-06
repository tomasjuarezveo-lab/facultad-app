// public/js/preguntas-upload.js — DB version
(function(){
  "use strict";
  const $ = (s)=>document.querySelector(s);
  const materiaSel = $('#materia');
  const planSel    = $('#plan');
  const form       = $('#formUp');

  async function loadMeta(){
    try{
      const res = await fetch('/app/preguntas/meta', { credentials:'same-origin' });
      if (!res.ok) throw new Error('No se pudo cargar meta');
      const j = await res.json();
      if (!j || !j.ok) throw new Error('Meta inválida');

      // Materias (si SSR no las puso o para refrescar)
      if (!(materiaSel.options && materiaSel.options.length > 1)){
        const materias = Array.isArray(j.materias) ? j.materias : [];
        materiaSel.innerHTML = materias.length
          ? '<option value="">Seleccioná...</option>' + materias.map(m => `<option value="${m}">${m}</option>`).join('')
          : '<option value="">(No se encontraron materias)</option>';
      }

      materiaSel.addEventListener('change', ()=>{
        fillPlanes(j, materiaSel.value);
      }, { once:false });

      // Preselect tras redirect
      const params = new URLSearchParams(location.search);
      const m = params.get('materia'); const p = params.get('plan');
      if (m){
        materiaSel.value = m;
        fillPlanes(j, m, p);
      }
    } catch(e){
      console.error(e);
      if (!(materiaSel.options && materiaSel.options.length)) {
        materiaSel.innerHTML = '<option value="">(Error cargando materias)</option>';
      }
      if (!(planSel.options && planSel.options.length)) {
        planSel.innerHTML    = '<option value="">(Error cargando planes)</option>';
        planSel.disabled = true;
      }
    }
  }

  function fillPlanes(meta, materia, preselect){
    const planesMap = meta.planesByMateria || {};
    const globals   = meta.planesGlobal || [];
    const planes    = (planesMap[materia] && planesMap[materia].length) ? planesMap[materia] : globals;
    planSel.disabled = !(planes && planes.length);
    planSel.innerHTML = planes && planes.length
      ? '<option value="">Seleccioná...</option>' + planes.map(p => `<option value="${p}">${p}</option>`).join('')
      : '<option value="">(No se encontraron planes)</option>';
    if (preselect){ planSel.value = preselect; }
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    loadMeta();
    form && form.addEventListener('submit', function(ev){
      const m = (materiaSel.value || '').trim();
      const p = (planSel.value || '').trim();
      const f = (document.getElementById('archivo').files[0]);
      if (!m || !p || !f){
        ev.preventDefault();
        alert('Completá Materia, Plan y el Archivo');
      }
    }, { capture:true });
  });
})();
