/**
 * public/js/grupos-fabs.js
 * Inyecta (o re-habilita) los dos FABs de la página "Grupos":
 * - Perfil (abajo-izquierda) => .user-badge-fixed
 * - Tutorial (abajo-derecha) => #helpFab.help-badge-fixed[data-help="tutorial"]
 * 
 * Se puede cargar de forma global: sólo actúa cuando la página es "grupos".
 */
(function(){
  "use strict";

  function isGrupos(){
    const path = (location.pathname||"").toLowerCase();
    const page = document.body && (document.body.dataset && document.body.dataset.page);
    const title = (document.title||"").toLowerCase();
    return (page === "grupos") || path.includes("/app/grupos") || title.includes("grupos");
  }

  function ensureStyle(){
    if (document.getElementById("grupos-fabs-style")) return;
    const css = `
      .user-badge-fixed{
        position:fixed; left:16px; bottom:18px;
        display:flex; align-items:center; gap:10px;
        padding:8px 12px; border-radius:9999px;
        background:rgba(255,255,255,.85);
        box-shadow:0 8px 24px rgba(0,0,0,.12);
        backdrop-filter: blur(10px);
        text-decoration:none; color:#0f172a; z-index:2147483000;
      }
      .user-badge-fixed .avatar{width:28px; height:28px; border-radius:9999px; overflow:hidden;}
      .user-badge-fixed .avatar img{width:100%; height:100%; object-fit:cover; display:block;}
      .user-badge-fixed .user-name{font-weight:600; font-size:14px;}

      .help-badge-fixed{
        position:fixed; right:16px; bottom:18px;
        display:flex; align-items:center; gap:8px;
        padding:10px 14px; border-radius:9999px;
        background:rgba(255,255,255,.85);
        box-shadow:0 8px 24px rgba(0,0,0,.12);
        backdrop-filter: blur(10px);
        text-decoration:none; color:#0f172a; font-weight:700; z-index:2147483000;
      }
      .help-badge-fixed svg{display:block;}
    `;
    const style = document.createElement("style");
    style.id = "grupos-fabs-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function getUserMeta(){
    const metaName = document.querySelector('meta[name="user-name"]');
    const metaAvatar = document.querySelector('meta[name="user-avatar"]');
    return {
      name: (metaName && metaName.content) || "Mi perfil",
      avatar: (metaAvatar && metaAvatar.content) || "/img/avatar-default.svg"
    };
  }

  function ensureProfile(){
    let el = document.querySelector(".user-badge-fixed");
    if (el){
      // Asegurar visibilidad por si estaba oculto
      el.style.opacity = "1";
      el.style.visibility = "visible";
      el.style.pointerEvents = "auto";
      el.style.display = "flex";
      return el;
    }
    const meta = getUserMeta();

    el = document.createElement("a");
    el.className = "user-badge-fixed";
    el.href = "/app/perfil";
    el.setAttribute("aria-label", "Perfil");
    el.title = "Perfil";

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    const img = document.createElement("img");
    img.src = meta.avatar;
    img.alt = "Foto de perfil";
    avatar.appendChild(img);

    const name = document.createElement("span");
    name.className = "user-name";
    name.textContent = meta.name;

    el.appendChild(avatar);
    el.appendChild(name);
    document.body.appendChild(el);
    return el;
  }

  function ensureHelp(){
    let el = document.getElementById("helpFab");
    if (el){
      el.classList.add("help-badge-fixed");
      el.setAttribute("data-help","tutorial");
      el.setAttribute("role","button");
      el.setAttribute("aria-label","Tutorial");
      el.title = el.title || "Tutorial";
      el.href = "#";
      show(el);
      bindHelp(el);
      return el;
    }
    el = document.createElement("a");
    el.id = "helpFab";
    el.className = "help-badge-fixed";
    el.setAttribute("data-help","tutorial");
    el.setAttribute("role","button");
    el.setAttribute("aria-label","Tutorial");
    el.title = "Tutorial";
    el.href = "#";

    // SVG idéntico al usado en Juegos (genérico de pregunta)
    el.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2Zm0 15.25a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm.1-11c2.18 0 3.9 1.52 3.9 3.5 0 1.44-.78 2.5-2.1 3.19-.73.38-1 0.69-1 1.31V14h-2v-.86c0-1.44.71-2.24 1.96-2.89.86-.45 1.24-.93 1.24-1.75 0-.86-.78-1.5-2-1.5s-2.13.72-2.13 1.84H8.1C8.1 7.21 9.75 6.25 12.1 6.25Z" /></svg><span>Tutorial</span>';

    document.body.appendChild(el);
    bindHelp(el);
    return el;
  }

  function show(el){
    el.style.opacity = "1";
    el.style.visibility = "visible";
    el.style.pointerEvents = "auto";
    el.style.display = "flex";
  }

  function bindHelp(el){
    if (el.__boundHelp) return;
    const handler = function(e){
      e.preventDefault();
      e.stopPropagation();
      try {
        document.dispatchEvent(new Event("open:tutorial", {bubbles:true}));
        document.dispatchEvent(new Event("open-tutorial:grupos", {bubbles:true}));
      } catch(_){ /* IE-safe */ 
        const ev1 = document.createEvent("Event");
        ev1.initEvent("open:tutorial", true, true);
        document.dispatchEvent(ev1);
        const ev2 = document.createEvent("Event");
        ev2.initEvent("open-tutorial:grupos", true, true);
        document.dispatchEvent(ev2);
      }
    };
    el.addEventListener("click", handler, {capture:true});
    el.addEventListener("keydown", function(e){
      if (e.key === "Enter" || e.key === " ") { handler(e); }
    }, {capture:true});
    el.__boundHelp = true;
  }

  function boot(){
    if (!isGrupos()) return;
    ensureStyle();
    ensureProfile();
    ensureHelp();
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // También reintenta al cambiar tamaño por si hay layouts que alteran visibilidad
  window.addEventListener("resize", function(){ if (isGrupos()) { ensureProfile(); ensureHelp(); }}, {passive:true});
})();
