// public/js/groups-reset.js
(function () {
  async function fetchNextLabel() {
    try {
      const res = await fetch('/app/grupos/api/next-reset', { cache: 'no-store' });
      if (!res.ok) throw new Error('bad status');
      const j = await res.json();
      return j.dateLabel || null;
    } catch (_) {
      return null;
    }
  }

  function tryReplaceInlineText(root, label) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    const kw = 'serán reseteados el';
    const nodes = [];
    while (true) {
      const n = walker.nextNode();
      if (!n) break;
      if (n.nodeValue && n.nodeValue.toLowerCase().includes(kw)) {
        nodes.push(n);
      }
    }
    nodes.forEach(n => {
      const before = n.nodeValue;
      const parts = before.split(/(serán reseteados el)/i);
      if (parts.length >= 3) {
        n.nodeValue = parts[1] + ' ' + label + '.';
      } else {
        n.nodeValue = `Los miembros y mensajes del grupo serán reseteados el ${label}.`;
      }
    });

    return nodes.length > 0;
  }

  function fillDataAttr(label) {
    const el = document.querySelector('[data-reset-notice]');
    if (el) {
      el.textContent = `Los miembros y mensajes del grupo serán reseteados el ${label}.`;
      return true;
    }
    return false;
  }

  async function init() {
    const label = await fetchNextLabel();
    if (!label) return;
    if (fillDataAttr(label)) return;
    tryReplaceInlineText(document.body, label);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
