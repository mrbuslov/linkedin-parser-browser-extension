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

// LinkedIn's internal SVG icon ids. Each contact-info section starts with one
// of these icons, and these ids are pulled from a shared icon library used
// across the whole LinkedIn UI — renaming one would break hundreds of pages,
// so they're effectively frozen. Way more stable than class names (which
// rotate every build) or even label text (which localizes). We use these as
// the PRIMARY signal; label text is the fallback only if no icon is found.
const ICON_MAP = {
  'envelope-medium':      'email',
  'phone-handset-small':  'phone',
  'link-medium':          'website',
  'globe-medium':         'website',
  'calendar-medium':      'birthday',
  'people-medium':        'connectedSince',
  'house-medium':         'address',
  'map-marker-medium':    'address',
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

// Find the contact-info section containing the value paragraphs. Strategy:
//
//   1) PRIMARY — walk every <svg> with a known id (envelope-medium for email,
//      phone-handset-small for phone, etc) and find the enclosing section.
//      The icon id is the most stable signal LinkedIn ships; class names
//      rotate every build, label text localizes, but the icon library is
//      shared across the whole UI and effectively frozen.
//
//   2) FALLBACK — if no recognized icon is in the modal (LinkedIn might
//      ship a contact card without icons one day), iterate <p> tags and
//      match against the localized label text via LABEL_MAP.
//
// For each (field, valueP-list) pair we hand off to the value extractor.
function discoverSections(root) {
  const sections = []; // [{ field, valueParagraphs: <p>[] }]

  // PRIMARY: walk SVGs.
  for (const svg of root.querySelectorAll('svg[id]')) {
    const field = ICON_MAP[svg.id];
    if (!field) continue;
    // The icon and the label/value paragraphs are siblings inside a row
    // wrapper. The row wrapper is the icon's parentElement. Inside there's
    // a sub-container with <p>Label</p><p>Value</p>(<p>Value 2</p>…). The
    // first <p> is the label and the rest are values.
    const row = svg.parentElement;
    if (!row) continue;
    const allPs = row.querySelectorAll('p');
    if (allPs.length < 2) continue;
    sections.push({ field, valueParagraphs: Array.from(allPs).slice(1) });
  }

  if (sections.length > 0) return sections;

  // FALLBACK: walk <p>s and label-match.
  const ps = root.querySelectorAll('p');
  for (let i = 0; i < ps.length; i++) {
    const labelRaw = normalizeLabel(ps[i].textContent);
    const field = LABEL_MAP[labelRaw];
    if (!field) continue;
    const valueP = ps[i].nextElementSibling;
    if (!valueP || valueP.tagName !== 'P') continue;
    // Collect any consecutive <p> siblings as multi-value (websites).
    const values = [valueP];
    let n = valueP.nextElementSibling;
    while (n && n.tagName === 'P') {
      const nLabel = normalizeLabel(n.textContent);
      if (LABEL_MAP[nLabel]) break;  // hit the next label
      values.push(n);
      n = n.nextElementSibling;
    }
    sections.push({ field, valueParagraphs: values });
  }
  return sections;
}

function parseContactsModal(doc) {
  const docArg = doc || (typeof document !== 'undefined' ? document : null);
  if (!docArg) return null;
  const root = docArg.querySelector(MODAL_SELECTOR);
  if (!root) return null;

  const out = {};
  const seenWebsites = [];

  for (const { field, valueParagraphs } of discoverSections(root)) {
    const valueP = valueParagraphs[0];
    if (!valueP) continue;

    if (field === 'email') {
      const a = valueP.querySelector('a[href^="mailto:" i]');
      if (a) {
        const raw = a.getAttribute('href') || '';
        out.email = raw.replace(/^mailto:/i, '').trim().toLowerCase();
      }
      continue;
    }

    if (field === 'website') {
      // A profile can have multiple websites — each as its own value <p>
      // inside the same section. Iterate all value paragraphs.
      for (const wp of valueParagraphs) {
        const a = wp.querySelector('a[href]');
        if (!a) continue;
        const url = (typeof LITUrl !== 'undefined' && LITUrl.decodeLinkedInRedirect)
          ? LITUrl.decodeLinkedInRedirect(a.getAttribute('href') || '')
          : (a.getAttribute('href') || '');
        const { label } = splitTrailingLabel(wp.textContent);
        seenWebsites.push({ url, label });
      }
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
