// Closed settings shape: a missing key takes its default, an unknown key raises.

(function () {

const DEFAULT_SETTINGS = Object.freeze({
  messageNotifications: true,
});

function normalizeSettings(raw) {
  if (raw === null || raw === undefined) return { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`settings: expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`);
  }
  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_SETTINGS));
  if (unknown.length > 0) {
    throw new Error(`settings: unknown keys ${unknown.join(', ')} — add them to DEFAULT_SETTINGS or drop them`);
  }
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== typeof defaultValue) {
      throw new TypeError(`settings.${key}: expected ${typeof defaultValue}, got ${typeof raw[key]}`);
    }
    out[key] = raw[key];
  }
  return out;
}

const LITSettings = { DEFAULT_SETTINGS, normalizeSettings };
if (typeof globalThis !== 'undefined') globalThis.LITSettings = LITSettings;
if (typeof module !== 'undefined' && module.exports) module.exports = LITSettings;

})();
