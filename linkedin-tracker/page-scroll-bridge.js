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
// Cross-world channel: DOM attribute + MutationObserver.
//
// Earlier attempts used `window.postMessage` from isolated → bridge in
// world:"MAIN". Diagnosed empirically 2026-07-12: bridge received ZERO
// scroll postMessages from isolated during a 32s queue run despite
// isolated firing ~200 postMessage calls. World:"MAIN" content scripts
// are more isolated than the docs suggest — the shared window's message
// queue does not deliver posts from other worlds to their listeners.
// DOM mutations, however, ALWAYS cross world boundaries (there is only
// one DOM). Isolated writes a JSON command to a data-attribute on
// <html>; bridge MutationObserves that attribute, parses, executes the
// scroll write against the resolved element via el.scrollTop. React's
// patched setter fires, state syncs, write STICKS.
//
// Wire from isolated:
//   document.documentElement.setAttribute(
//     'data-lit-scroll-cmd',
//     JSON.stringify({ selector, delta, seq })
//   );
//
// `seq` is a monotonic counter — bridge processes each seq exactly once
// so that MutationObserver batching (multiple attribute writes coalesced
// into one callback) doesn't cause double-processing.

(function () {
  if (window.__litScrollBridgeInstalled) return;
  window.__litScrollBridgeInstalled = true;

  const inIsolated = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  // eslint-disable-next-line no-console
  console.log(`[LI Tracker] page-scroll-bridge loaded — inIsolated=${inIsolated} (want false)`);

  const CMD_ATTR = 'data-lit-scroll-cmd';
  let lastSeq = 0;
  let obsCallbacks = 0;

  function processFromElement(carrier) {
    if (!carrier) return;
    const raw = carrier.getAttribute(CMD_ATTR);
    if (!raw) return;
    const cmd = JSON.parse(raw);
    if (typeof cmd.seq !== 'number' || cmd.seq <= lastSeq) return;
    lastSeq = cmd.seq;

    obsCallbacks++;
    if (obsCallbacks <= 5 || obsCallbacks % 20 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[LI Tracker/bridge] cmd #${cmd.seq} sel=${cmd.selector} delta=${cmd.delta}`);
    }

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
        console.warn(
          `[LI Tracker/bridge] scrollTop no-op on <${el.tagName.toLowerCase()}> (delta=${cmd.delta}, before=after=${before}) — element is not the real scroll container`,
        );
      }
    } else if (typeof cmd.top === 'number') {
      el.scrollTop = Math.max(0, cmd.top);
    }
  }

  // Observe body subtree for our attribute — isolated inserts a
  // dedicated <div id="__lit-scroll-bus"> and sets the attribute
  // there, but we don't hard-code that ID: any element in the subtree
  // that carries CMD_ATTR is honored. If the target elmt is somewhere
  // else next iteration, the same observer catches it.
  function boot() {
    if (!document.body) {
      // body might not exist yet at document_start — retry on
      // DOMContentLoaded.
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
