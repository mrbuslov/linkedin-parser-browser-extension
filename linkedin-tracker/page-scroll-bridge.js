// Runs in the PAGE's own JavaScript world (manifest `world: "MAIN"`).
// Bridge between the isolated content-script queue driver and the page's
// own React state.
//
// Why this exists: Chrome content scripts run in an ISOLATED world with
// their own Element.prototype. LinkedIn's page-world React has patched
// its own Element.prototype.scrollTop setter to sync writes with the
// component's internal scroll state — so when the extension writes
// scrollTop from isolated world, the NATIVE setter runs (no React state
// update), and on the next React reconciliation the value gets reset
// back to whatever React state says (usually 0).
//
// Fix: this file runs in PAGE world (registered as world: "MAIN" in
// manifest.json). The content script posts a window message with the
// selector + delta; this bridge picks it up in page world and does
// `el.scrollTop += delta` — now going through React's patched setter,
// which correctly updates internal state and the write STICKS.
//
// Wire from isolated:
//   window.postMessage({__lit: 'scroll', selector, delta}, '*');

(function () {
  if (window.__litScrollBridgeInstalled) return;
  window.__litScrollBridgeInstalled = true;

  window.addEventListener('message', (e) => {
    // Cross-origin postMessage filter — accept only messages from THIS
    // window (same tab) with our sentinel.
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__lit !== 'scroll') return;

    try {
      const el = document.querySelector(d.selector);
      if (!el) return;
      if (typeof d.delta === 'number') {
        el.scrollTop = Math.max(0, el.scrollTop + d.delta);
      } else if (typeof d.top === 'number') {
        el.scrollTop = Math.max(0, d.top);
      }
    } catch (_) {
      // Silent — the isolated caller has no way to receive an error
      // reply here, and a thrown exception in page world would just
      // pollute LinkedIn's console.
    }
  });

  // Announce to isolated world that the bridge is ready. Not
  // strictly necessary (isolated posts fire-and-forget) but helps
  // diagnosis if you ever wonder whether the MAIN-world script loaded.
  window.postMessage({ __lit: 'bridge-ready' }, '*');
  // eslint-disable-next-line no-console
  console.log('[LI Tracker] page-scroll-bridge loaded (world:MAIN)');
})();
