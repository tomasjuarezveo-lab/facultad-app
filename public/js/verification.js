// public/js/verification.js 
(function(){
  const body = document.body || document.querySelector('body');
  if (!body) return;

  const isAuthHtml = document.documentElement.classList.contains('auth-html');
  const path = location.pathname || '';
  if (isAuthHtml || /^\/(login|register)(\/|$)/i.test(path)) return;

  const role = (body.getAttribute('data-user-role') || '').toLowerCase();
  if (role === 'admin') return; // admin nunca bloqueado

  const POLL_MS  = 1000;

  let overlayEl = null;
  let inputEl   = null;
  let btnEl     = null;
  let msgEl     = null;

  // ===== Estilos inline (idénticos a tu snippet, con ajustes solicitados) =====
  const wrapStyle = `
    position: fixed; inset: 0; z-index: 999999;
    display: none; align-items: center; justify-content: center;
  `;
  const backdropStyle = `
    position: absolute; inset: 0;
    background: rgba(2,6,23,.55);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  `;
  const cardStyle = `
    position: relative;
    width: min(92vw, 460px);
    background: #F5F8FB;
    border: 1px solid rgba(15,23,42,.12);
    border-radius: 16px;
    box-shadow: 0 24px 60px rgba(15,23,42,.25), inset 0 1px 0 rgba(255,255,255,.9);
    /* padding top extra para alojar título izq y brand der en la misma fila */
    padding: 56px 16px 16px 16px;
    color: #0f172a;
  `;
  // Fila de marca (logo + "Verificación") fija arriba a la derecha
  const brandRowStyle = `
    position: absolute; top: 14px; right: 16px;
    display: flex; align-items: center; gap: 8px;
  `;
  // Mitad de tamaño (de 28px -> 14px)
  const logoStyle = `
    width: 14px; height: 14px; border-radius: 4px;
    background: #F8C160; color: #fff; font-weight: 900; font-size: 10px;
    display: inline-flex; align-items: center; justify-content: center;
    box-shadow: 0 6px 18px rgba(248,193,96,.45);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  const brandTextStyle = `
    font-weight: 800; font-size: 12px; color:#475569; letter-spacing:.02em;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  // Título arriba a la izquierda, alineado con la fila de marca
  const titleStyle = `
    position: absolute; top: 14px; left: 16px;
    font-size: 16px; font-weight: 900; margin: 0; letter-spacing: -.02em;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  const subStyle = `
    font-size: 14px; color:#475569; margin: 0 0 15px;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  const firstTimeStyle = `
    font-size: 12px; color:#475569; margin: 15px 0 12px;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  const formRowStyle = `
    display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center;
  `;
  const inputStyle = `
    height: 42px; border-radius: 12px; background: #fff;
    border: 1px solid rgba(15,23,42,.12);
    padding: 0 12px; font-size: 16px; outline: none;
    letter-spacing: 0.2em; text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  `;
  const btnPrimaryStyle = `
    height: 42px; border-radius: 12px; font-weight: 800; font-size: 14px;
    padding: 0 16px; border: 1px solid #F8C160; cursor: pointer;
    background: #F8C160; color: #fff; box-shadow: 0 8px 20px rgba(248,193,96,.35);
  `;
  const errPillStyle = `
    margin-top: 10px;
    background: #fee2e2; color: #991b1b;
    border: 1px solid #fecaca; border-radius: 10px;
    padding: 8px 10px; font-size: 13px;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  const helpStyle = `
    margin-top: 10px; font-size: 12px; color:#64748b;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  // Acciones: logout a la izquierda, espacio, (fab wa va por separado abajo a la derecha)
  const actionsStyle = `
    margin-top: 12px; display: flex; justify-content: flex-start;
  `;
  // Botón "Cerrar sesión" más pequeño
  const btnGhostStyle = `
    height: 36px; border-radius: 10px; font-weight: 800; font-size: 12px;
    padding: 0 12px; border: 1px solid rgba(15,23,42,.18); cursor: pointer;
    background: transparent; color: #0f172a;
  `;
  // FAB de WhatsApp (abajo a la derecha del card)
  const waFabStyle = `
    position: absolute; right: 14px; bottom: 14px;
    width: 44px; height: 44px; border-radius: 9999px;
    display: inline-flex; align-items: center; justify-content: center;
    background: #25D366; color: #fff; border: none; cursor: pointer;
    box-shadow: 0 10px 24px rgba(37,211,102,.35);
  `;
  const waIconStyle = `
    width: 22px; height: 22px; display:block;
  `;

  function ensureOverlay(){
    if (overlayEl) return overlayEl;

    // Wrapper
    overlayEl = document.createElement('div');
    overlayEl.setAttribute('style', wrapStyle);

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.setAttribute('style', backdropStyle);
    backdrop.setAttribute('aria-hidden', 'true');

    // Card
    const card = document.createElement('div');
    card.setAttribute('style', cardStyle);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'vwTitle');

    // Brand row (arriba a la derecha)
    const brandRow = document.createElement('div');
    brandRow.setAttribute('style', brandRowStyle);

    const logo = document.createElement('div');
    logo.setAttribute('style', logoStyle);
    logo.textContent = '✓';

    const brandText = document.createElement('div');
    brandText.setAttribute('style', brandTextStyle);
    brandText.textContent = 'Verificación';

    brandRow.appendChild(logo);
    brandRow.appendChild(brandText);

    // Title (arriba a la izquierda)
    const title = document.createElement('h2');
    title.id = 'vwTitle';
    title.setAttribute('style', titleStyle);
    title.textContent = 'Verificá tu cuenta';

    const sub = document.createElement('p');
    sub.setAttribute('style', subStyle);
    sub.innerHTML = 'Solicitá tu código de acceso por WhatsApp  y seguí utilizando <b>CleverWave</b> por 30 días más.';

    // Mensaje SIEMPRE visible (debajo del recuadro del código)
    const firstTime = document.createElement('p');
    firstTime.setAttribute('style', firstTimeStyle);
    firstTime.textContent = 'Aprovechá tu primer mes gratis, escribile al agente por WhatsApp y te dará el código 100% gratis.';
    firstTime.style.display = 'block';

    // Form row
    const formRow = document.createElement('div');
    formRow.setAttribute('style', formRowStyle);

    inputEl = document.createElement('input');
    inputEl.id = 'vwCode';
    inputEl.setAttribute('style', inputStyle);
    inputEl.type = 'text';
    inputEl.inputMode = 'text';        // teclado alfanumérico
    inputEl.placeholder = 'CÓDIGO';
    inputEl.setAttribute('aria-label', 'Código de verificación');
    inputEl.autocomplete = 'one-time-code';
    inputEl.autocapitalize = 'characters';
    inputEl.spellcheck = false;

    btnEl = document.createElement('button');
    btnEl.id = 'vwSubmit';
    btnEl.setAttribute('style', btnPrimaryStyle);
    btnEl.textContent = 'Verificar';

    formRow.appendChild(inputEl);
    formRow.appendChild(btnEl);

    // Error pill
    msgEl = document.createElement('p');
    msgEl.id = 'vwError';
    msgEl.setAttribute('style', errPillStyle);
    msgEl.hidden = true;
    msgEl.textContent = 'El código no es válido o ya fue usado.';

    // Help
    const help = document.createElement('div');
    help.setAttribute('style', helpStyle);
    help.textContent = '¿Aún no recibiste tu código? Escríbenos a claverwave@gmail.com';

    // Actions: logout a la izquierda (más pequeño)
    const actions = document.createElement('div');
    actions.setAttribute('style', actionsStyle);

    const logoutBtn = document.createElement('button');
    logoutBtn.id = 'vwLogout';
    logoutBtn.setAttribute('style', btnGhostStyle);
    logoutBtn.textContent = 'Cerrar sesión';

    actions.appendChild(logoutBtn);

    // FAB WhatsApp (abajo derecha DENTRO del card)
    const waBtn = document.createElement('a');
    waBtn.setAttribute('style', waFabStyle);
    waBtn.setAttribute('target', '_blank');
    waBtn.setAttribute('rel', 'noopener');
    // Número: +54 221 599 5987 -> 542215995987
    const waMsg = encodeURIComponent('Hola agente, necesito un código de acceso para CleverWave.');
    waBtn.href = `https://wa.me/542215995987?text=${waMsg}`;
    // Icono simple (SVG)
    waBtn.innerHTML = `
      <svg viewBox="0 0 32 32" style="${waIconStyle}" aria-hidden="true" focusable="false">
        <path d="M19.11 17.8c-.27-.13-1.6-.79-1.85-.88-.25-.09-.43-.13-.6.13-.18.27-.69.88-.85 1.06-.16.18-.31.2-.58.07-.27-.13-1.12-.41-2.14-1.31-.79-.7-1.32-1.56-1.48-1.82-.16-.27-.02-.41.12-.54.13-.13.27-.31.4-.47.13-.16.18-.27.27-.45.09-.18.04-.34-.02-.47-.07-.13-.6-1.44-.83-1.98-.22-.53-.45-.46-.6-.47l-.52-.01c-.18 0-.47.07-.71.34-.25.27-.94.92-.94 2.25 0 1.32.96 2.6 1.09 2.78.13.18 1.89 2.89 4.58 4.04.64.28 1.14.45 1.53.58.64.2 1.22.17 1.68.1.51-.08 1.6-.65 1.83-1.28.23-.63.23-1.17.16-1.28-.07-.11-.24-.18-.51-.31zM16.02 4C9.94 4 5 8.95 5 15.02c0 1.95.51 3.79 1.41 5.38L5 27l6.78-1.78c1.54.84 3.31 1.31 5.19 1.31 6.07 0 11.02-4.95 11.02-11.02S22.09 4 16.02 4zm0 19.92c-1.71 0-3.3-.5-4.64-1.36l-.33-.21-4.02 1.06 1.08-3.92-.22-.35a9.4 9.4 0 0 1-1.45-4.96c0-5.2 4.23-9.43 9.43-9.43 5.2 0 9.43 4.23 9.43 9.43 0 5.2-4.23 9.43-9.43 9.43z" fill="currentColor"/>
      </svg>
    `;

    // Compose card
    card.appendChild(brandRow);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(formRow);
    card.appendChild(firstTime);
    card.appendChild(msgEl);
    card.appendChild(help);
    card.appendChild(actions);
    card.appendChild(waBtn);

    // Compose overlay
    overlayEl.appendChild(backdrop);
    overlayEl.appendChild(card);
    document.body.appendChild(overlayEl);

    // Eventos
    btnEl.addEventListener('click', submitCode);
    inputEl.addEventListener('keydown', (e)=>{ if(e.key==='Enter') submitCode(); });
    logoutBtn.addEventListener('click', ()=>{ location.href = '/logout'; });

    // Focus ring manual
    const baseInputStyle = inputStyle;
    const focusRing = ' box-shadow: 0 0 0 4px rgba(248,193,96,.18); border-color:#F8C160;';
    inputEl.addEventListener('focus', ()=> inputEl.setAttribute('style', baseInputStyle + focusRing));
    inputEl.addEventListener('blur',  ()=> inputEl.setAttribute('style', baseInputStyle));

    return overlayEl;
  }

  function showOverlay(){
    ensureOverlay();
    overlayEl.style.display = 'flex';
    setTimeout(()=> inputEl?.focus(), 60);
  }
  function hideOverlay(){
    if (!overlayEl) return;
    overlayEl.style.display = 'none';
    msgEl.textContent = 'El código no es válido o ya fue usado.';
    msgEl.hidden = true;
    inputEl.value = '';
  }

  async function getStatus(){
    const r = await fetch('/api/verify/status', { credentials: 'include' });
    if (!r.ok) throw new Error('status http ' + r.status);
    return r.json(); // { enabled, remainingMs, serverNow, allowedUntil }
  }

  async function submitCode(){
    const code = (inputEl.value || '').trim();
    if (!code) { 
      msgEl.textContent = 'Ingresá el código';
      msgEl.hidden = false;
      return; 
    }
    btnEl.disabled = true;
    msgEl.hidden = true;

    try{
      const r = await fetch('/api/verify/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code })
      });
      const j = await r.json();
      if (j && j.ok){
        // Éxito: oculto y recargo
        hideOverlay();
        try { localStorage.setItem('cw_verify_last_ok', String(Date.now())); } catch {}
        location.reload();
      } else {
        msgEl.textContent = (j && j.error) ? j.error : 'No se pudo validar el código.';
        msgEl.hidden = false;
      }
    }catch(e){
      msgEl.textContent = 'Error de red. Intentá de nuevo.';
      msgEl.hidden = false;
    }finally{
      btnEl.disabled = false;
    }
  }

  async function tick(){
    try{
      const st = await getStatus();
      if (!st.enabled) {
        hideOverlay();
        return;
      }
      const remaining = Number(st.remainingMs || 0);
      if (remaining <= 0) showOverlay(); else hideOverlay();
    }catch(_){
      // en caso de error de red mantenemos estado actual
    }
  }

  function init(){
    tick();
    setInterval(tick, POLL_MS);
  }

  init();
})();