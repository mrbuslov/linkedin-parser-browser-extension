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

  // World-identity marker. Isolated content-script world has
  // `typeof chrome === 'object'` and `chrome.runtime` populated; page
  // world does not. If this logs `hasChromeRuntime=true`, the
  // world: "MAIN" manifest entry didn't take effect and this script is
  // running in isolated world — same broken context as the queue
  // driver, no fix.
  const inIsolated = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  // eslint-disable-next-line no-console
  console.log(`[LI Tracker] page-scroll-bridge loaded — inIsolated=${inIsolated} (want false)`);

  // Instrument every message we receive. When shipped this is noisy
  // (14+ writes per profile × N profiles) but the noise IS the
  // diagnostic — if you don't see these lines, bridge never received
  // the postMessage from isolated world.
  //
  // NOTE: previous version had `if (e.source !== window) return;` as a
  // cross-origin filter. Removed 1.3.3-bridge-nosource-filter — the
  // 2026-07-12 debug showed inIsolated=false (bridge IS in page world)
  // but ZERO scroll messages received. Only remaining hypothesis: the
  // `e.source === window` check fails cross-world because isolated's
  // WindowProxy != page-world's Window identity comparison. postMessage
  // sourceOrigin still filters cross-tab noise via the sentinel
  // check below — the source filter is redundant AND buggy.
  let _bridgeSeen = 0;
  let _allSeen = 0;
  window.addEventListener('message', (e) => {
    _allSeen++;
    // First 3 messages of ANY kind — logs whether the listener fires
    // AT ALL. If we see LinkedIn's react-scheduler postMessages here
    // but not ours below, the filter path is still wrong.
    if (_allSeen <= 3) {
      // eslint-disable-next-line no-console
      console.log(`[LI Tracker/bridge] ANY msg #${_allSeen} sourceIsWindow=${e.source === window} data=`, typeof e.data === 'object' ? Object.keys(e.data || {}).join(',') : typeof e.data);
    }
    const d = e.data;
    if (!d || d.__lit !== 'scroll') return;

    _bridgeSeen++;
    if (_bridgeSeen <= 5 || _bridgeSeen % 20 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[LI Tracker/bridge] msg #${_bridgeSeen} sel=${d.selector} delta=${d.delta}`);
    }

    const el = document.querySelector(d.selector);
    if (!el) {
      // Instrumented — silent match failure is exactly how the 1.3.3
      // "Christine no-scroll" bug hid: bridge received the message,
      // querySelector returned null, page never moved, no complaint
      // in either world.
      // eslint-disable-next-line no-console
      console.warn('[LI Tracker/bridge] no match for', d.selector);
      return;
    }
    if (typeof d.delta === 'number') {
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, before + d.delta);
      // If write was a no-op AND we asked for non-zero motion, that
      // means el.scrollTop is not a scrollable property on this element
      // (usually because the element itself isn't the actual scroll
      // container). Log so callers can pick a different target.
      if (d.delta !== 0 && el.scrollTop === before) {
        // eslint-disable-next-line no-console
        console.warn(
          `[LI Tracker/bridge] scrollTop no-op on <${el.tagName.toLowerCase()}> (delta=${d.delta}, before=after=${before}) — target is not the real scroll container`,
        );
      }
    } else if (typeof d.top === 'number') {
      el.scrollTop = Math.max(0, d.top);
    }
  });

  // Announce to isolated world that the bridge is ready. Not
  // strictly necessary (isolated posts fire-and-forget) but helps
  // diagnosis if you ever wonder whether the MAIN-world script loaded.
  window.postMessage({ __lit: 'bridge-ready' }, '*');
})();
