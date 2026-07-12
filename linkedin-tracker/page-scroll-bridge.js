// Runs in page world (manifest world:"MAIN"). Isolated CS writes
// scrollTop don't stick on LinkedIn profile pages — React's scroll
// state binding resets them. This bridge does the write from page
// world instead. Isolated hands us commands via a data-attribute on
// a hidden <div> (cross-world postMessage is silently dropped
// between isolated and world:"MAIN" in this Chrome build).

(function () {
  if (window.__litScrollBridgeInstalled) return;
  window.__litScrollBridgeInstalled = true;

  const CMD_ATTR = 'data-lit-scroll-cmd';
  let lastSeq = 0;

  function processFromElement(carrier) {
    if (!carrier) return;
    const raw = carrier.getAttribute(CMD_ATTR);
    if (!raw) return;
    const cmd = JSON.parse(raw);
    if (typeof cmd.seq !== 'number' || cmd.seq <= lastSeq) return;
    lastSeq = cmd.seq;

    const el = document.querySelector(cmd.selector);
    if (!el) {
      // eslint-disable-next-line no-console
      console.warn('[LI Tracker/bridge] no match for', cmd.selector);
      return;
    }
    if (typeof cmd.delta === 'number') {
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, before + cmd.delta);
      if (cmd.delta !== 0 && el.scrollTop === before) {
        // eslint-disable-next-line no-console
        console.warn(`[LI Tracker/bridge] scrollTop no-op on <${el.tagName.toLowerCase()}> (delta=${cmd.delta}) — wrong target`);
      }
    } else if (typeof cmd.top === 'number') {
      el.scrollTop = Math.max(0, cmd.top);
    }
  }

  function boot() {
    if (!document.body) {
      // document_start runs before <body> exists.
      document.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.target && m.target.hasAttribute && m.target.hasAttribute(CMD_ATTR)) {
          processFromElement(m.target);
        }
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [CMD_ATTR],
      subtree: true,
    });
  }
  boot();
})();
