// Parser for the LinkedIn "Contact info" overlay.
//
// The user clicks "Contact info" on a profile page and LinkedIn renders a
// modal listing whatever fields the profile owner published: email, phone,
// websites, address, birthday, "connected since". The modal's classes are
// fully obfuscated, but LinkedIn marks the root container with a stable
// Server-Driven UI identifier:
//
//   data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay"
//
// Inside, each field is a section with a `componentkey` attribute (a UUID).
// Each section contains two <p> tags: the first is the localized label
// ("Email", "Phone", "Website", "Address", "Birthday", "Connected since"),
// the second is the value. Value can be plain text, or contain an <a> for
// email/website links.
//
// We only run when the modal is in the DOM (querySelector cheap, no-op miss).
// Returns null when the modal isn't present, OR when present but empty.

const LABEL_MAP = {
  // English
  'email':            'email',
  'phone':            'phone',
  'website':          'website',
  'websites':         'website',
  'address':          'address',
  'birthday':         'birthday',
  'connected':        'connectedSince',
  'connected since':  'connectedSince',
  // Russian
  'эл. почта':        'email',
  'электронная почта':'email',
  'почта':            'email',
  'телефон':          'phone',
  'веб-сайт':         'website',
  'сайт':             'website',
  'адрес':            'address',
  'день рождения':    'birthday',
  'подключены с':     'connectedSince',
  // Ukrainian
  'електронна пошта': 'email',
  'веб-сайт ':        'website',
  'веб-сторінка':     'website',
  'адреса':           'address',
  'день народження':  'birthday',
  'у контактах з':    'connectedSince',
};

const MODAL_SELECTOR =
  '[data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay"]';

// "value (parenthesizedLabel)" → ["value", "parenthesizedLabel"]. Used for the
// "Phone" and "Website" rows where LinkedIn appends a usage label like
// "+375…  (Home)" or "t.me  (Blog)". Anchor links carry the same trailing
// "(Type)" outside the <a>, so we parse it from the row's full text.
function splitTrailingLabel(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { value: m[1].trim(), label: m[2].trim() };
  return { value: t, label: '' };
}

function normalizeLabel(raw) {
  return (raw || '').toLowerCase().replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();
}

function parseContactsModal(doc) {
  const docArg = doc || (typeof document !== 'undefined' ? document : null);
  if (!docArg) return null;
  const root = docArg.querySelector(MODAL_SELECTOR);
  if (!root) return null;

  const out = {};
  const seenWebsites = [];

  for (const section of root.querySelectorAll('[componentkey]')) {
    const ps = section.querySelectorAll('p');
    if (ps.length < 2) continue;

    const labelRaw = normalizeLabel(ps[0].textContent);
    const field = LABEL_MAP[labelRaw];
    if (!field) continue;

    const valueP = ps[1];

    if (field === 'email') {
      const a = valueP.querySelector('a[href^="mailto:" i]');
      if (a) {
        const raw = a.getAttribute('href') || '';
        out.email = raw.replace(/^mailto:/i, '').trim().toLowerCase();
      }
      continue;
    }

    if (field === 'website') {
      const a = valueP.querySelector('a[href]');
      if (!a) continue;
      const url = (typeof LITUrl !== 'undefined' && LITUrl.decodeLinkedInRedirect)
        ? LITUrl.decodeLinkedInRedirect(a.getAttribute('href') || '')
        : (a.getAttribute('href') || '');
      const { label } = splitTrailingLabel(valueP.textContent);
      seenWebsites.push({ url, label });
      continue;
    }

    if (field === 'phone') {
      const { value, label } = splitTrailingLabel(valueP.textContent);
      out.phone = value;
      if (label) out.phoneLabel = label;
      continue;
    }

    if (field === 'address') {
      out.address = (valueP.textContent || '').trim();
      continue;
    }

    if (field === 'birthday') {
      out.birthday = (valueP.textContent || '').trim();
      continue;
    }

    if (field === 'connectedSince') {
      out.connectedSinceText = (valueP.textContent || '').trim();
      continue;
    }
  }

  if (seenWebsites.length > 0) {
    out.website = seenWebsites[0].url;
    if (seenWebsites[0].label) out.websiteLabel = seenWebsites[0].label;
    if (seenWebsites.length > 1) out.extraWebsites = seenWebsites.slice(1);
  }

  return Object.keys(out).length ? out : null;
}

const LITContactsModal = { parseContactsModal, splitTrailingLabel, MODAL_SELECTOR };
if (typeof globalThis !== 'undefined') globalThis.LITContactsModal = LITContactsModal;
if (typeof module !== 'undefined' && module.exports) module.exports = LITContactsModal;
