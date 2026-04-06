// public/js/emoji-picker.js
import { EMOJI_CATEGORIES } from "/public/js/emoji-data.js";
(function(){
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", init); } else { init(); }
  function init(){
    const picker    = document.getElementById("emojiPicker");
    const grid      = document.getElementById("emojiGrid");
    const tabsBar   = document.getElementById("emojiTabs");
    const input     = document.getElementById("msgText");
    const toggleBtn = document.getElementById("emojiBtn");
    if (!picker || !grid || !tabsBar) return;

    tabsBar.innerHTML = "";
    EMOJI_CATEGORIES.forEach((cat, i) => {
      const b = document.createElement("button");
      b.className = "emoji-tab" + (i === 0 ? " is-active" : "");
      b.type = "button"; b.setAttribute("data-cat", cat.id); b.textContent = cat.label;
      b.addEventListener("click", () => { tabsBar.querySelectorAll(".emoji-tab").forEach(x=>x.classList.remove("is-active")); b.classList.add("is-active"); renderGrid(cat); });
      tabsBar.appendChild(b);
    });

    grid.addEventListener("click", (e)=>{
      const el = e.target.closest(".emoji"); if(!el) return;
      const emo = el.textContent || ""; insertAtCursor(input, emo);
    });

    renderGrid(EMOJI_CATEGORIES[0]);

    if (toggleBtn) {
      toggleBtn.addEventListener("click", (ev)=>{ ev.preventDefault(); ev.stopPropagation(); toggle(); });
    }
    document.addEventListener("click", (ev)=>{
      if (!picker.contains(ev.target) && ev.target !== toggleBtn) { close(); }
    });

    function renderGrid(cat){
      grid.innerHTML = "";
      cat.emojis.forEach(e => { const d = document.createElement("div"); d.className = "emoji"; d.textContent = e; grid.appendChild(d); });
    }
    function insertAtCursor(input, text){
      if (!input) return;
      const start = input.selectionStart ?? input.value.length;
      const end   = input.selectionEnd   ?? input.value.length;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const pos = start + text.length; input.setSelectionRange(pos, pos); input.focus();
    }
    function open(){ picker.classList.add("open"); picker.setAttribute("aria-hidden","false"); if (toggleBtn) toggleBtn.setAttribute("aria-expanded","true"); }
    function close(){ picker.classList.remove("open"); picker.setAttribute("aria-hidden","true"); if (toggleBtn) toggleBtn.setAttribute("aria-expanded","false"); }
    function toggle(){ picker.classList.contains("open") ? close() : open(); }
  }
})();
