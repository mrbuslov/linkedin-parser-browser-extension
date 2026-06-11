// Smoke test: every content_script bundle declared in manifest.json must
// load into a single shared global scope without a SyntaxError or
// top-level identifier collision.
//
// REGRESSION GUARD. This is the THIRD time we've shipped a bug like:
//   profile.js:1 Uncaught SyntaxError: Identifier 'cleanHeadline' has
//   already been declared
//   profile.js:1 Uncaught SyntaxError: Identifier 'parseMutualsCount' has
//   already been declared
// — caused by declaring `const X = ...` in one content-script file when
// another file in the same bundle declared `function X(...)`. Both files
// load into the SAME global scope, so the `const` collides with the
// `function` and the file fails to parse — silently breaking every
// downstream feature (status detection, contact-info save, popup
// communication). This test runs each bundle through Node's `vm` module
// in a fresh sandbox, exactly the way Chrome runs them in order, and
// fails loudly the moment a collision returns.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(__dirname, '../linkedin-tracker');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function loadBundle(jsFiles) {
  // Minimal stubs for browser APIs that load-time code touches. We DON'T
  // need them to work — we just need them present so script parsing/exec
  // doesn't throw on missing references. Anything more would defeat the
  // point of this smoke test (which is: did the file PARSE).
  // A no-op DOM stub that responds to every method profile.js + core/* hit
  // during their immediate module-load execution path. We DON'T need any of
  // these calls to do real work — the smoke test only verifies parseability
  // and identifier-scope sanity, not runtime behaviour.
  const stubEl = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => '',
    setAttribute: () => {},
    removeAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    closest: () => null,
    children: [],
    childNodes: [],
    textContent: '',
    parentElement: null,
    insertAdjacentElement: () => {},
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    dataset: {},
    style: {},
  };
  const sandbox = {
    globalThis: {},
    self: {},
    window: {},
    document: {
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      body: stubEl,
      head: stubEl,
      documentElement: stubEl,
      createElement: () => stubEl,
      readyState: 'loading',
    },
    chrome: {
      runtime: { sendMessage: () => Promise.resolve({}), onMessage: { addListener: () => {} } },
      tabs: { query: () => Promise.resolve([]), update: () => {}, create: () => {}, sendMessage: () => Promise.resolve({}) },
    },
    location: { href: 'https://www.linkedin.com/in/test/', pathname: '/in/test/' },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    URL,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const file of jsFiles) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    try {
      vm.runInContext(source, sandbox, { filename: file });
    } catch (e) {
      // The test is scoped to parse-time errors only: SyntaxError
      // (malformed source) AND identifier-collision SyntaxError (when
      // one script declares `const X` while a prior script declared
      // `function X` in the same global scope). Both are what production
      // would catch the moment Chrome loads the content-script bundle.
      //
      // Runtime errors thrown by code that runs immediately at module
      // load (e.g. `tick()` at the end of profile.js calling
      // `document.querySelectorAll` on a sandbox stub) are out of
      // scope — production runs with a real DOM. Propagate SyntaxError,
      // drop the rest.
      if (e instanceof SyntaxError) throw e;
    }
  }
  return sandbox;
}

for (const cs of manifest.content_scripts) {
  describe(`content_scripts bundle: ${cs.matches.join(', ')}`, () => {
    it('loads all js files into one shared scope without SyntaxError or identifier collision', () => {
      expect(() => loadBundle(cs.js)).not.toThrow();
    });

    it('LITPopupLogic.parseMutualsCount is the SOLE owner of that identifier (no shadowing const)', () => {
      // This is a targeted check for the exact class of bugs that hit us:
      // file A defines `function X` and file B does `const X = ...`. If
      // the bundle includes popup-logic.js, the global `parseMutualsCount`
      // must be exactly the function from popup-logic.js.
      if (!cs.js.includes('core/popup-logic.js')) return;
      const sandbox = loadBundle(cs.js);
      expect(typeof sandbox.parseMutualsCount).toBe('function');
      // It must be reachable through the namespace too, and be the same fn.
      expect(sandbox.LITPopupLogic).toBeDefined();
      expect(sandbox.LITPopupLogic.parseMutualsCount).toBe(sandbox.parseMutualsCount);
    });

    it('LITPopupLogic.cleanHeadline is the SOLE owner (regression guard)', () => {
      if (!cs.js.includes('core/popup-logic.js')) return;
      const sandbox = loadBundle(cs.js);
      expect(typeof sandbox.cleanHeadline).toBe('function');
      expect(sandbox.LITPopupLogic.cleanHeadline).toBe(sandbox.cleanHeadline);
    });
  });
}
