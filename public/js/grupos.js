(function(){
  function handleJoin(btn){
    const subjectId = btn.getAttribute('data-subject');
    if (!subjectId) return;
    btn.disabled = true;
    fetch('/app/grupos/'+subjectId+'/unirse', {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).then(r => r.json()).then(j => {
      if (j && j.ok) {
        const a = document.createElement('a');
        a.className = 'btn glass border px-4 py-2';
        a.href = '/app/grupos/'+subjectId;
        a.textContent = 'Entrar';
        btn.parentNode.replaceChild(a, btn);
      } else {
        btn.disabled = false;
        alert(j && j.error ? j.error : 'No se pudo unir');
      }
    }).catch(()=>{ btn.disabled=false; alert('Error de red'); });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('.js-join');
    if (t) {
      e.preventDefault();
      handleJoin(t);
    }
  });
})();