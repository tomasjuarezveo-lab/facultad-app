/* =============================================================
   Chat Clicks + Overlay Hotfix (2025-10-08)
   - Restores clicks for: group title -> right panel, top-right (⋯), emoji toggle,
     per-message (⋯) with admin delete, and member (⋯) with "Quitar del grupo".
   - Neutralizes blocking overlays via pointer-events.
   - Uses robust delegated listeners so it keeps working after DOM updates.
   ============================================================= */
(function(){
  const ready = (fn) => (document.readyState !== 'loading') ? fn() : document.addEventListener('DOMContentLoaded', fn);

  ready(function(){
    // 1) CSS overrides: ensure non-interactive overlays don't block clicks
    const css = `
      .reset-banner-overlay,
      .tutorial-overlay,
      .tutorial-scrim,
      .glass-scrim,
      .spotlight-scrim,
      .global-scrim-blocker{ pointer-events: none !important; }
      .reset-banner-overlay .reset-banner-pill,
      .help-badge-fixed,
      .help-badge-fixed *,
      .emoji-panel, .emoji-submenu, .emoji-container,
      .member-menu, .msg-menu, .chat-top-menu{ pointer-events: auto; }
    `;
    const style = document.createElement('style');
    style.setAttribute('data-hotfix', 'chat-clicks-20251008');
    style.textContent = css;
    document.head.appendChild(style);

    // 2) Small helpers
    const q  = (sel, root=document) => root.querySelector(sel);
    const qa = (sel, root=document) => Array.from(root.querySelectorAll(sel));
    const isAdmin = !!(window.IS_ADMIN);
    const SUBJECT_ID = (typeof window.SUBJECT_ID !== 'undefined' && window.SUBJECT_ID !== null) ? window.SUBJECT_ID : null;

    // Find the message container element for a given element
    function closestMsg(el){
      return el.closest('[data-msg-id], .message-row, .chat-msg, li[data-id]') || null;
    }
    function getMsgId(node){
      if (!node) return null;
      return node.getAttribute('data-msg-id') || node.getAttribute('data-id') || null;
    }
    function openRightPanel(){
      // Try: click an existing legacy opener if present
      const legacy = q('.js-right-panel-open, [data-panel-open="right"], #openRightPanel, .open-right-panel');
      if (legacy && typeof legacy.click === 'function') { legacy.click(); }
      // Try: toggle common panel containers
      const panel = q('#rightPanel, .right-panel, .chat-right-panel, [data-panel="right"]');
      if (panel){
        panel.hidden = false;
        panel.classList.add('open','is-open','show');
        panel.style.display = '';
      }
      document.documentElement.classList.add('right-panel-open');
      document.body.classList.add('right-panel-open');
    }
    function toggleMenu(btn, menuSel){
      const wrap = btn.closest('[data-menu-wrap]') || btn.parentElement;
      const menu = (wrap && q(menuSel, wrap)) || q(menuSel, btn.parentElement || document);
      // Close others
      qa('.msg-menu.is-open, .member-menu.is-open, .chat-top-menu.is-open').forEach(m => { if (m !== menu) m.classList.remove('is-open'); });
      if (menu){
        menu.classList.toggle('is-open');
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth){ menu.style.left = 'auto'; menu.style.right = '0'; }
        if (r.bottom > window.innerHeight){ menu.style.top = 'auto'; menu.style.bottom = '100%'; }
      }
    }
    function toggleEmoji(){
      const panel = q('#emojiPanel, .emoji-panel, .emoji-submenu, .emoji-container');
      if (panel){
        panel.classList.toggle('is-open');
        if (panel.style.display === 'none') panel.style.display = '';
      }
    }
    async function adminDeleteMessage(id, node){
      if (!isAdmin){ return; }
      if (!id){ console.warn('[hotfix] No message id'); return; }
      if (!SUBJECT_ID){ console.warn('[hotfix] No SUBJECT_ID'); return; }
      try{
        const res = await fetch(`/app/grupos/${encodeURIComponent(SUBJECT_ID)}/messages/${encodeURIComponent(id)}/admin-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reason: 'admin-delete' })
        });
        if (!res.ok){ throw new Error('HTTP '+res.status); }
        if (node && node.parentNode){ node.parentNode.removeChild(node); }
      }catch(err){
        console.error('[hotfix] adminDeleteMessage failed:', err);
        alert('No se pudo eliminar el mensaje.');
      }
    }
    async function kickMember(userId, card){
      if (!isAdmin){ return; }
      if (!userId){ console.warn('[hotfix] No userId'); return; }
      if (!SUBJECT_ID){ console.warn('[hotfix] No SUBJECT_ID'); return; }
      if (!confirm('¿Quitar a este miembro del grupo?')) return;
      try{
        const res = await fetch(`/app/grupos/${encodeURIComponent(SUBJECT_ID)}/members/${encodeURIComponent(userId)}/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ reason: 'admin-kick' })
        });
        if (!res.ok){ throw new Error('HTTP '+res.status); }
        if (card && card.parentNode){ card.parentNode.removeChild(card); }
      }catch(err){
        console.error('[hotfix] kickMember failed:', err);
        alert('No se pudo quitar al miembro.');
      }
    }

    // 3) Global delegated listeners
    document.addEventListener('click', function(e){
      const target = e.target;
      // Any click outside menus closes them
      if (!target.closest('.msg-menu, .member-menu, .chat-top-menu, [data-menu-wrap]')){
        qa('.msg-menu.is-open, .member-menu.is-open, .chat-top-menu.is-open').forEach(m => m.classList.remove('is-open'));
      }

      // Find an actionable trigger (by data-click or by legacy classes)
      const btn = target.closest('[data-click], .js-open-right-panel, .js-top-more, .js-emoji-toggle, .js-msg-more, .js-admin-delete, .js-member-more, .js-kick');
      if (!btn) return;

      const action =
        btn.getAttribute('data-click') ||
        (btn.classList.contains('js-open-right-panel') ? 'open-right-panel' :
         btn.classList.contains('js-top-more')        ? 'toggle-top-menu'  :
         btn.classList.contains('js-emoji-toggle')    ? 'toggle-emoji'     :
         btn.classList.contains('js-msg-more')        ? 'msg-more'         :
         btn.classList.contains('js-admin-delete')    ? 'msg-admin-delete' :
         btn.classList.contains('js-member-more')     ? 'member-more'      :
         btn.classList.contains('js-kick')            ? 'kick-member'      : null);

      if (!action) return;

      if (action === 'open-right-panel'){
        e.preventDefault();
        openRightPanel();
        return;
      }
      if (action === 'toggle-top-menu'){
        e.preventDefault();
        toggleMenu(btn, '.chat-top-menu');
        return;
      }
      if (action === 'toggle-emoji'){
        e.preventDefault();
        toggleEmoji();
        return;
      }
      if (action === 'msg-more'){
        e.preventDefault();
        const msgNode = closestMsg(btn);
        if (msgNode) toggleMenu(btn, '.msg-menu');
        return;
      }
      if (action === 'msg-admin-delete'){
        e.preventDefault();
        if (!isAdmin) return;
        const msgNode = closestMsg(btn);
        const id = getMsgId(msgNode);
        adminDeleteMessage(id, msgNode);
        return;
      }
      if (action === 'member-more'){
        e.preventDefault();
        toggleMenu(btn, '.member-menu');
        return;
      }
      if (action === 'kick-member'){
        e.preventDefault();
        if (!isAdmin) return;
        const card = btn.closest('[data-user-id]');
        const userId = (card && card.getAttribute('data-user-id')) || btn.getAttribute('data-user-id');
        kickMember(userId, card);
        return;
      }
    }, true); // capture to beat other handlers that stopPropagation

    // 4) Also ensure group title opens right panel
    const titleBtn = document.querySelector('#groupTitle, .chat-group-title, [data-click="open-right-panel"]');
    if (titleBtn){
      titleBtn.addEventListener('click', function(ev){
        ev.preventDefault();
        openRightPanel();
      }, { passive:false });
    }

    // 5) Console hints for debugging
    console.log('%c[chat-hotfix] Ready. Admin=%s Subject=%s', 'color:#22c55e', isAdmin, SUBJECT_ID);
  });
})();
