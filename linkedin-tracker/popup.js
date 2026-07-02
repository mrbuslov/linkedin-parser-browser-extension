const SENT_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const SUPPORT_URL = 'https://github.com/mrbuslov/linkedin-parser-browser-extension/issues/new';
const DAY_MS = 86400000;
const AGE_YELLOW_DAYS = 7;
const AGE_RED_DAYS = 14;

function relativeTime(ts) {
  if (!ts) return null;
  const diffMs = Date.now() - ts;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderScanInfo(container, state) {
  container.innerHTML = '';
  if (!state || !state.lastScannedAt) {
    container.append(el('span', { className: 'scan-info-text muted' }, ['Never scanned']));
    return;
  }
  const when = relativeTime(state.lastScannedAt);
  if (state.lastError) {
    container.append(
      el('span', { className: 'scan-info-text error' }, [`Last scan ${when} failed: ${state.lastError}`])
    );
  } else {
    const count = state.lastCount != null ? ` · ${state.lastCount} captured` : '';
    container.append(
      el('span', { className: 'scan-info-text muted' }, [`Last scan ${when}${count}`])
    );
  }
}

const $ = (id) => document.getElementById(id);
const ageDays = (ts) => Math.floor((Date.now() - ts) / DAY_MS);
const ageClassFromDays = (d) => d >= AGE_RED_DAYS ? 'age-red' : d >= AGE_YELLOW_DAYS ? 'age-yellow' : '';

let searchQuery = '';

// Defensive view-side correction for legacy records where `name` and
// `headline` got swapped (an old extractor stored an accessibility text
// node like "Daniil StankevichFullstack developer | …" as the name, and
// the real name as headline). fixSwappedNameHeadline detects and undoes
// this — and we run it on every row before rendering so all tabs
// (Pending / Accepted / Marked / Declined block) get the correction.
function viewItem(item) {
  const fixed = LITPopupLogic.fixSwappedNameHeadline(item);
  return { ...item, name: fixed.name, headline: fixed.headline };
}

function matchesSearch(item) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (item.name || '').toLowerCase().includes(q)
    || (item.headline || '').toLowerCase().includes(q)
    || (item.email || '').toLowerCase().includes(q)
    || (item.phone || '').toLowerCase().includes(q)
    || (item.website || '').toLowerCase().includes(q)
    || (item.address || '').toLowerCase().includes(q);
}

// One-shot toast at the bottom of the popup. Used for "Copied!" feedback after
// the user clicks a contact-copy icon. Kept inline (no library) — we only need
// a single transient line of text.
let toastTimer = null;
function showToast(text) {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    document.body.append(node);
  }
  node.textContent = text;
  node.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1200);
}

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied`);
  } catch {
    showToast('Copy failed');
  }
}

function contactButton(emoji, value, label) {
  if (!value) return null;
  const btn = el('button', {
    className: 'contact-copy',
    type: 'button',
    title: `Copy ${label}: ${value}`,
  }, [emoji]);
  btn.setAttribute('aria-label', `Copy ${label}`);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyToClipboard(value, label);
  });
  return btn;
}

function contactButtons(item) {
  const buttons = [
    contactButton('📧', item.email, 'email'),
    contactButton('📞', item.phone, 'phone'),
    contactButton('🌐', item.website, 'website'),
  ].filter(Boolean);
  if (buttons.length === 0) return null;
  return el('span', { className: 'contact-copies' }, buttons);
}

// "🤝 N" chip — opens LinkedIn's connection-of search in a new tab.
// Color logic: solid blue when the list of mutuals has NOT been captured
// (CTA — click to navigate, the search-mutuals content script will save
// the list when LinkedIn renders it); white/outlined when we've already
// captured the list locally.
function mutualsChip(item) {
  if (!item.mutualsUrl) return null;
  const labelText = item.mutualsCount != null ? `🤝 ${item.mutualsCount}` : '🤝';
  const collected = Array.isArray(item.mutualsCollected) && item.mutualsCollected.length > 0;
  const a = el('a', {
    className: collected ? 'mutuals-chip collected' : 'mutuals-chip',
    href: item.mutualsUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
  }, [labelText]);
  a.title = collected
    ? `${item.mutualsCollected.length} mutual(s) saved locally${item.mutualsText ? ' — ' + item.mutualsText : ''}`
    : (item.mutualsText
        ? `${item.mutualsText} — click to capture the list locally`
        : 'Open the LinkedIn search to capture mutuals locally');
  return a;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// Profile link that navigates the current active tab instead of opening a new one.
// Cmd/Ctrl-click still opens in a new tab (browser-native, via the href fallback).
// For email-keyed entries (mailto:foo@bar) we render a non-navigating span — no
// /in/ profile exists to open, and we don't want to fire the user's email client.
function profileLink(url, text) {
  if (typeof url === 'string' && url.startsWith('mailto:')) {
    return el('span', { className: 'name email' }, [text]);
  }
  const a = el('a', { className: 'name', href: url }, [text]);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.button === 1) return; // let browser handle new-tab
    e.preventDefault();
    chrome.tabs.update({ url });
    window.close();
  });
  return a;
}

function statusBadge(verified) {
  if (verified === 'accepted') {
    const b = el('span', { className: 'status-badge accepted' }, ['✓']);
    b.title = 'accepted';
    return b;
  }
  if (verified === 'declined') {
    const b = el('span', { className: 'status-badge declined' }, ['✗']);
    b.title = 'declined';
    return b;
  }
  const b = el('span', { className: 'status-badge unverified' }, ['?']);
  b.title = 'unverified';
  return b;
}

function renderPending(rawItems) {
  const items = rawItems.map(viewItem);
  const list = $('pending-list');
  list.innerHTML = '';
  const filtered = items.filter(matchesSearch);
  $('pending-empty').hidden = items.length > 0;
  $('pending-summary').textContent = items.length === 0
    ? ''
    : searchQuery
      ? `${filtered.length} of ${items.length} match`
      : `${items.length} pending · sorted newest first`;

  // Newest first: invitations sent recently appear at the top. Old
  // long-pending ones drift to the bottom (and the row's age class still
  // visually flags them, regardless of position).
  const sorted = filtered.slice().sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  for (const item of sorted) list.append(renderPendingRow(item));
}

function isMarked(item) {
  // welcomeMessageSent kept for backwards-compat with older storage entries
  return Boolean(item.marked || item.welcomeMessageSent);
}

function renderAcceptedRow(item, { primaryAction, primaryLabel }) {
  const sinceAccepted = ageDays(item.acceptedAt);
  const isDeclined = item.status === 'declined';

  const actions = [];
  if (!isDeclined) {
    const actionBtn = el('button', { className: 'primary' }, [primaryLabel]);
    actionBtn.addEventListener('click', () => primaryAction(item.profileUrl));
    actions.push(actionBtn);
  }
  actions.push(deleteButton(item));

  const rowClasses = ['row', ageClassFromDays(sinceAccepted)];
  if (isDeclined) rowClasses.push('declined');

  const nameNode = item.profileUrl && item.profileUrl.startsWith('mailto:')
    ? el('span', { className: 'name email' }, [item.name])
    : el('a', { className: 'name', href: item.profileUrl, target: '_blank' }, [item.name]);

  return el('li', { className: rowClasses.filter(Boolean).join(' ') }, [
    item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
    el('div', { className: 'row-body' }, [
      el('div', { className: 'name-row' }, [
        nameNode,
        favoriteButton(item),
        infoButton(item),
        statusBadge(item.status),
        contactButtons(item),
        mutualsChip(item),
      ]),
      (() => { const h = LITPopupLogic.cleanHeadline(item.headline, item.name); return h ? el('div', { className: 'headline' }, [h]) : null; })(),
      item.location ? el('div', { className: 'location' }, [item.location]) : null,
      el('div', { className: 'meta' }, [
        el('span', {}, [`Accepted ${sinceAccepted}d ago`]),
        el('span', {}, [`was pending ${item.daysPending}d`]),
      ]),
      actions.length > 0 ? el('div', { className: 'row-actions' }, actions) : null,
    ]),
  ]);
}

function renderDeclinedWarning(declinedCount, connectionsScanState) {
  const banner = $('declined-warning');
  if (!banner) return;
  banner.hidden = !LITPopupLogic.shouldShowDeclinedWarning(declinedCount, connectionsScanState);
}

function renderAccepted(rawItems, connectionsScanState) {
  const items = rawItems.map(viewItem);
  const list = $('accepted-list');
  const declinedList = $('declined-list');
  const declinedBlock = $('declined-block');
  list.innerHTML = '';
  declinedList.innerHTML = '';

  const unmarked = items.filter((x) => !isMarked(x));
  const active = unmarked.filter((x) => x.status !== 'declined');
  const declined = unmarked.filter((x) => x.status === 'declined');
  const visible = active.filter(matchesSearch);
  const declinedVisible = declined.filter(matchesSearch);

  $('accepted-empty').hidden = unmarked.length > 0;
  $('accepted-summary-text').textContent = active.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${active.length} match`
      : `${active.length} to handle`;
  $('mark-all').hidden = active.length === 0;

  const sorted = visible.slice().sort((a, b) => b.acceptedAt - a.acceptedAt);
  for (const item of sorted) {
    list.append(renderAcceptedRow(item, {
      primaryAction: (url) => setMarked(url, true),
      primaryLabel: 'Mark',
    }));
  }

  declinedBlock.hidden = declined.length === 0;
  $('declined-summary').textContent = declined.length === 0
    ? "Didn't accept"
    : searchQuery
      ? `Didn't accept (${declinedVisible.length} of ${declined.length})`
      : `Didn't accept (${declined.length})`;
  const declinedSorted = declinedVisible.slice().sort((a, b) => b.acceptedAt - a.acceptedAt);
  for (const item of declinedSorted) {
    declinedList.append(renderAcceptedRow(item, {
      primaryAction: (url) => setMarked(url, true),
      primaryLabel: 'Mark',
    }));
  }

  renderDeclinedWarning(declined.length, connectionsScanState);
}

function renderMarked(rawItems) {
  const items = rawItems.map(viewItem);
  const list = $('marked-list');
  list.innerHTML = '';

  const all = items.filter(isMarked);
  const visible = all.filter(matchesSearch);
  $('marked-empty').hidden = all.length > 0;
  $('marked-summary').textContent = all.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${all.length} match`
      : `${all.length} marked`;

  const sorted = visible.slice().sort((a, b) => (b.markedAt || b.acceptedAt) - (a.markedAt || a.acceptedAt));
  for (const item of sorted) {
    list.append(renderAcceptedRow(item, {
      primaryAction: (url) => setMarked(url, false),
      primaryLabel: 'Unmark',
    }));
  }
}

// Favorites tab: aggregates `favorite: true` records from all three stores,
// v2: everything lives in one `contacts` dict; favorites is a filter on
// `favorite === true`. Rendering choice per row: 'pending' status → Pending
// row shape (age color + sentDateRelative); 'accepted'/'declined' → Accepted
// row shape (Mark button); anything else → contacts-only row shape.
// Viewed tab — profiles with status='visited' (opened but never invited /
// connected). Sorted by most recent visit. Reuses the contacts-only
// row renderer since these entries look the same shape.
function renderViewed(contacts) {
  const list = $('viewed-list');
  list.innerHTML = '';

  const viewed = Object.values(contacts)
    .filter((r) => r.status === 'visited')
    .map(viewItem);
  const visible = viewed.filter(matchesSearch);
  $('viewed-empty').hidden = viewed.length > 0;
  $('viewed-summary').textContent = viewed.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${viewed.length} match`
      : `${viewed.length} viewed`;

  const sorted = visible.slice()
    .sort((a, b) => (b.visitedAt || b.firstSeenAt || 0) - (a.visitedAt || a.firstSeenAt || 0));
  for (const item of sorted) {
    list.append(renderContactOnlyRow(item));
  }
}

function renderFavorites(contacts) {
  const list = $('favorites-list');
  list.innerHTML = '';

  const favs = Object.values(contacts).filter((r) => r.favorite).map(viewItem);
  const visible = favs.filter(matchesSearch);
  $('favorites-empty').hidden = favs.length > 0;
  $('favorites-summary').textContent = favs.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${favs.length} match`
      : `${favs.length} favorited`;

  const sorted = visible.slice().sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));
  for (const item of sorted) {
    if (item.status === 'accepted' || item.status === 'declined') {
      list.append(renderAcceptedRow(item, {
        primaryAction: (url) => setMarked(url, !isMarked(item)),
        primaryLabel: isMarked(item) ? 'Unmark' : 'Mark',
      }));
    } else if (item.status === 'pending') {
      list.append(renderPendingRow(item));
    } else {
      list.append(renderContactOnlyRow(item));
    }
  }
}

// Pull the per-row render out of renderPending() so the Favorites tab can
// reuse it without re-running the whole search/sort/summary pipeline.
function renderPendingRow(item) {
  const days = ageDays(item.firstSeenAt);
  return el('li', { className: `row ${ageClassFromDays(days)}` }, [
    item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
    el('div', { className: 'row-body' }, [
      el('div', { className: 'name-row' }, [
        profileLink(item.profileUrl, item.name),
        favoriteButton(item),
        infoButton(item),
        contactButtons(item),
        mutualsChip(item),
      ]),
      (() => { const h = LITPopupLogic.cleanHeadline(item.headline, item.name); return h ? el('div', { className: 'headline' }, [h]) : null; })(),
      el('div', { className: 'meta' }, [
        el('span', {}, [`Pending ${days}d`]),
        item.sentDateRelative ? el('span', {}, [item.sentDateRelative]) : null,
      ]),
      el('div', { className: 'row-actions' }, [deleteButton(item)]),
    ]),
  ]);
}

// Contacts-only row (favorited person who never appeared in pending/accepted
// — e.g. a 3rd-degree profile the user visited). Minimal but functional.
function renderContactOnlyRow(item) {
  return el('li', { className: 'row' }, [
    item.avatar ? el('img', { className: 'avatar', src: item.avatar, alt: '' }) : null,
    el('div', { className: 'row-body' }, [
      el('div', { className: 'name-row' }, [
        profileLink(item.profileUrl, item.name),
        favoriteButton(item),
        infoButton(item),
        contactButtons(item),
        mutualsChip(item),
      ]),
      (() => { const h = LITPopupLogic.cleanHeadline(item.headline, item.name); return h ? el('div', { className: 'headline' }, [h]) : null; })(),
      item.location ? el('div', { className: 'location' }, [item.location]) : null,
      el('div', { className: 'row-actions' }, [deleteButton(item)]),
    ]),
  ]);
}

// One-shot v1 → v2 schema migration. Runs on every popup load; idempotent
// (LITSchema.isV2 short-circuits when schemaVersion=2 already). The
// service worker also runs this on startup — this is belt-and-suspenders.
async function ensureSchemaV2() {
  const stored = await dbGet(null);
  if (LITSchema.isV2(stored)) return;
  const migrated = LITSchema.migrateToV2(stored);
  migrated._backup_v1._migratedAt = Date.now();
  await dbSet(migrated);
  await dbDelete(LITSchema.LEGACY_STORE_KEYS);
  console.log('[LI Tracker] popup migrated storage to v2.');
}

// One-shot migration: walk every record and undo any name/headline swap.
// Idempotent: no write when nothing to fix.
async function migrateSwappedNames() {
  const { contacts = {} } = await dbGet('contacts');
  let changed = false;
  for (const rec of Object.values(contacts)) {
    const fixed = LITPopupLogic.fixSwappedNameHeadline(rec);
    if (fixed.name !== rec.name || fixed.headline !== rec.headline) {
      rec.name = fixed.name;
      rec.headline = fixed.headline;
      changed = true;
    }
  }
  if (changed) {
    await dbSet({ contacts });
    console.log('[LI Tracker] migration cleaned name/headline swap in contacts.');
  }
}

async function loadData() {
  await ensureSchemaV2();
  await migrateSwappedNames();

  const { contacts = {}, scanHistory = [], scanState = {} } =
    await dbGet(['contacts', 'scanHistory', 'scanState']);

  const pending  = Object.values(contacts).filter((r) => r.status === 'pending');
  const accepted = Object.values(contacts).filter((r) => r.status === 'accepted' || r.status === 'declined');

  renderPending(pending);
  renderAccepted(accepted, scanState.connections);
  renderMarked(accepted);
  renderFavorites(contacts);
  renderViewed(contacts);
  renderScanInfo($('pending-scan-info'), scanState.sent);
  renderScanInfo($('accepted-scan-info'), scanState.connections);

  const lastScan = scanHistory[scanHistory.length - 1];
  const stats = `pending: ${pending.length} · accepted: ${accepted.filter((r) => r.status === 'accepted').length} · scans: ${scanHistory.length}`;
  $('stats-line').textContent = lastScan
    ? `${stats} · last scan ${new Date(lastScan.timestamp).toLocaleString()}`
    : stats;
}

async function setMarked(profileUrl, value) {
  const { contacts = {} } = await dbGet('contacts');
  if (!contacts[profileUrl]) return;
  contacts[profileUrl].marked = value;
  contacts[profileUrl].markedAt = value ? Date.now() : null;
  if (!value) contacts[profileUrl].welcomeMessageSent = false;
  await dbSet({ contacts });
}

// Permanently remove an entry by its profileUrl. One dict, one delete.
async function deleteEntry(profileUrl, displayName) {
  const ok = window.confirm(
    `Delete "${displayName || profileUrl}" from the tracker?\n\n`
    + 'Removes this entry from Pending / Accepted / Marked / Favorites. '
    + 'Cannot be undone. If LinkedIn still has the actual connection, a '
    + 'future /connections/ scan will re-add them.'
  );
  if (!ok) return;
  const { contacts = {} } = await dbGet('contacts');
  if (!contacts[profileUrl]) return;
  delete contacts[profileUrl];
  await dbSet({ contacts });
  showToast('Deleted');
}

function deleteButton(item) {
  const btn = el('button', { className: 'danger', type: 'button' }, ['Delete']);
  btn.addEventListener('click', () => deleteEntry(item.profileUrl, item.name));
  return btn;
}

function infoButton(item) {
  const btn = el('button', {
    className: 'info-btn',
    type: 'button',
    title: 'Show full info',
  }, ['ⓘ']);
  btn.setAttribute('aria-label', 'Show full info');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openDetailView(item.profileUrl);
  });
  return btn;
}

// Star toggle. Filled ★ = favorited, outline ☆ = not. Click toggles the
// `favorite` boolean on whichever store(s) hold this profileUrl (a person
// can live in sentInvitations OR accepted, plus contacts in parallel — we
// flip ALL of them so reads are consistent regardless of which store the
// renderer pulled from).
function favoriteButton(item) {
  const fav = !!item.favorite;
  const btn = el('button', {
    className: fav ? 'fav-btn favorited' : 'fav-btn',
    type: 'button',
    title: fav ? 'Remove from favorites' : 'Add to favorites',
  }, [fav ? '★' : '☆']);
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(fav));
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFavorite(item.profileUrl);
  });
  return btn;
}

async function toggleFavorite(profileUrl) {
  const { contacts = {} } = await dbGet('contacts');
  const rec = contacts[profileUrl];
  if (!rec) return;
  const next = !rec.favorite;
  rec.favorite = next;
  rec.favoritedAt = next ? Date.now() : null;
  await dbSet({ contacts });
  // The list-panel re-render is triggered by the DB_CHANGED broadcast
  // (loadData reads fresh contacts). Detail panel is rendered once on
  // open() and won't pick up the new favorite state unless we refresh
  // it explicitly here.
  await refreshDetailView();
}

// ---------- Detail view ----------
//
// Click ⓘ on any row → the list panel hides, a full-width detail panel
// renders every stored field for that profile. Back button returns to the
// previously-active tab. Implemented as a separate <section id="detail-panel">
// — same `.panel` slot system the tabs use, plus a `showing-detail` body
// class that hides the tab switcher while a detail is open.

let detailReturnTab = 'pending';
let currentDetailUrl = null;

async function openDetailView(profileUrl) {
  detailReturnTab = activeTabName();
  currentDetailUrl = profileUrl;
  const { contacts = {} } = await dbGet('contacts');
  const item = contacts[profileUrl];
  if (!item) return;
  renderDetail(item);
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.remove('active');
    if (panel.id !== 'detail-panel') panel.hidden = true;
  }
  const detail = $('detail-panel');
  detail.hidden = false;
  detail.classList.add('active');
  document.body.classList.add('showing-detail');
}

function closeDetailView() {
  currentDetailUrl = null;
  document.body.classList.remove('showing-detail');
  const detail = $('detail-panel');
  detail.hidden = true;
  detail.classList.remove('active');
  for (const panel of document.querySelectorAll('.panel')) {
    if (panel.id === 'detail-panel') continue;
    panel.hidden = false;
  }
  switchTab(detailReturnTab);
}

// Re-fetch the current detail-view record from storage and re-render. Used
// after in-place mutations (e.g. favorite toggle) so the panel reflects
// fresh field values without closing/reopening. No-op when detail view is
// not currently showing.
async function refreshDetailView() {
  if (!currentDetailUrl) return;
  const { contacts = {} } = await dbGet('contacts');
  const item = contacts[currentDetailUrl];
  if (!item) return;
  renderDetail(item);
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const day = 86400000;
  if (diff < day) return 'today';
  const days = Math.floor(diff / day);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function field(label, value, opts = {}) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  const valNode = typeof value === 'string' || typeof value === 'number'
    ? el('span', { className: 'field-value' + (opts.mono ? ' mono' : '') }, [String(value)])
    : value;
  const children = [el('div', { className: 'field-label' }, [label]), valNode];
  if (opts.copy && typeof value === 'string') {
    const btn = el('button', { className: 'copy-link', type: 'button' }, ['Copy']);
    btn.addEventListener('click', () => copyToClipboard(value, label));
    children.push(btn);
  }
  return el('div', { className: 'detail-field' }, children);
}

function renderDetail(item) {
  const fixed = LITPopupLogic.fixSwappedNameHeadline(item);
  const name = fixed.name;
  const headline = LITPopupLogic.cleanHeadline(fixed.headline, name);
  const panel = $('detail-panel');
  panel.innerHTML = '';

  const header = el('div', { className: 'detail-header' }, [
    (() => {
      const back = el('button', { className: 'detail-back', type: 'button', title: 'Back' }, ['←']);
      back.setAttribute('aria-label', 'Back');
      back.addEventListener('click', closeDetailView);
      return back;
    })(),
    el('div', { className: 'detail-title-wrap' }, [
      item.avatar ? el('img', { className: 'detail-avatar', src: item.avatar, alt: '' }) : null,
      el('div', { className: 'detail-title-text' }, [
        el('div', { className: 'detail-name' }, [
          name || '(no name)',
          favoriteButton(item),
        ]),
        item.status ? statusBadge(item.status) : null,
      ]),
    ]),
  ]);
  panel.append(header);

  // ABOUT section
  const about = el('div', { className: 'detail-section' }, [
    el('h4', {}, ['About']),
    field('Headline', headline),
    field('Location', item.location),
    field('Country', item.country),
  ].filter(Boolean));
  if (about.querySelectorAll('.detail-field').length > 0) panel.append(about);

  // CONTACT section
  const contactRows = [
    field('Email', item.email, { copy: true, mono: true }),
    field('Phone', item.phone ? `${item.phone}${item.phoneLabel ? ' (' + item.phoneLabel + ')' : ''}` : '', { copy: !!item.phone, mono: true }),
    field('Website', item.website ? `${item.website}${item.websiteLabel ? ' (' + item.websiteLabel + ')' : ''}` : '', { copy: !!item.website, mono: true }),
    field('Address', item.address),
    field('Birthday', item.birthday),
    field('Connected since', item.connectedSinceText),
  ].filter(Boolean);
  if (contactRows.length > 0) {
    panel.append(el('div', { className: 'detail-section' }, [
      el('h4', {}, ['Contact info']),
      ...contactRows,
    ]));
  } else {
    panel.append(el('div', { className: 'detail-section muted' }, [
      el('h4', {}, ['Contact info']),
      el('p', { className: 'hint' }, ['Open the LinkedIn "Contact info" overlay on this profile to capture email/phone/website here.']),
    ]));
  }

  // MUTUALS section
  if (item.mutualsUrl || (item.mutualsCollected && item.mutualsCollected.length)) {
    const collected = Array.isArray(item.mutualsCollected) ? item.mutualsCollected : [];
    const sec = el('div', { className: 'detail-section' }, [
      el('h4', {}, [`Mutual connections${item.mutualsCount != null ? ` (${item.mutualsCount})` : ''}`]),
      item.mutualsText ? el('p', { className: 'hint' }, [item.mutualsText]) : null,
      item.mutualsUrl ? (() => {
        const a = el('a', { href: item.mutualsUrl, target: '_blank', className: 'text-action' }, ['Open on LinkedIn →']);
        return a;
      })() : null,
      collected.length > 0
        ? el('div', { className: 'mutuals-collected-meta' }, [`${collected.length} saved locally · captured ${relTime(item.mutualsCollectedAt)}`])
        : null,
      collected.length > 0 ? el('ul', { className: 'mutuals-collected-list' }, collected.map((m) => {
        const link = el('a', { href: m.profileUrl, target: '_blank', className: 'mutual-row' }, [
          m.avatar ? el('img', { className: 'mutual-avatar', src: m.avatar, alt: '' }) : null,
          el('span', { className: 'mutual-name' }, [m.name]),
        ]);
        return el('li', {}, [link]);
      })) : null,
    ].filter(Boolean));
    panel.append(sec);
  }

  // ACTIVITY section — only if we have any captured posts
  const recent = Array.isArray(item.recentActivity) ? item.recentActivity : [];
  if (recent.length > 0 || item.lastActivityAt || item.lastPostAt) {
    const activitySection = el('div', { className: 'detail-section' }, [
      el('h4', {}, ['Recent activity']),
      item.lastActivityAt ? field('Last activity', `${fmtDate(item.lastActivityAt)} · ${relTime(item.lastActivityAt)}`) : null,
      item.lastPostAt     ? field('Last own post', `${fmtDate(item.lastPostAt)} · ${relTime(item.lastPostAt)}`) : null,
      recent.length > 0 ? el('ul', { className: 'activity-list' }, recent.map((c) => {
        const snippet = (c.text || '').slice(0, 280) + ((c.text || '').length > 280 ? '…' : '');
        const typeLabel = c.type === 'post' ? 'post' : c.type === 'share' ? 'share' : c.type;
        const meta = el('div', { className: 'activity-meta' }, [
          el('span', { className: `activity-type activity-type-${c.type}` }, [typeLabel]),
          el('span', { className: 'activity-time' }, [c.postedAtText || '']),
          c.author ? el('span', { className: 'activity-author' }, [`· ${c.author}`]) : null,
        ].filter(Boolean));
        const link = el('a', { href: c.url, target: '_blank', className: 'activity-link' }, ['Open ↗']);
        return el('li', { className: 'activity-row' }, [
          meta,
          snippet ? el('p', { className: 'activity-text' }, [snippet]) : null,
          link,
        ].filter(Boolean));
      })) : null,
    ].filter(Boolean));
    panel.append(activitySection);
  }

  // CONNECTION section (status + dates)
  panel.append(el('div', { className: 'detail-section' }, [
    el('h4', {}, ['Connection']),
    field('Status', item.status),
    field('Accepted at', item.acceptedAt ? `${fmtDate(item.acceptedAt)} · ${relTime(item.acceptedAt)}` : null),
    field('Days pending before accept', item.daysPending != null ? item.daysPending : null),
    field('First seen', item.firstSeenAt ? `${fmtDate(item.firstSeenAt)} · ${relTime(item.firstSeenAt)}` : null),
    field('Last visited', item.visitedAt ? `${fmtDate(item.visitedAt)} · ${relTime(item.visitedAt)}` : null),
    field('Marked at', item.markedAt ? `${fmtDate(item.markedAt)} · ${relTime(item.markedAt)}` : null),
  ].filter(Boolean)));

  // TECHNICAL section
  panel.append(el('div', { className: 'detail-section' }, [
    el('h4', {}, ['Technical']),
    field('Profile URL', item.profileUrl, { copy: true, mono: true }),
    field('Member ID', item.memberId, { mono: true }),
    field('Vanity name', item.vanityName, { mono: true }),
    field('Connected on (LinkedIn)', item.connectedOnText),
    field('Captured contact info', item.contactsCapturedAt ? `${fmtDate(item.contactsCapturedAt)} · ${relTime(item.contactsCapturedAt)}` : null),
  ].filter(Boolean)));

  // ACTIONS section
  const openLi = el('a', { href: item.profileUrl, target: '_blank', className: 'cta' }, ['Open LinkedIn profile']);
  const del = el('button', { className: 'danger', type: 'button' }, ['Delete this entry']);
  del.addEventListener('click', async () => {
    await deleteEntry(item.profileUrl, name);
    closeDetailView();
  });
  panel.append(el('div', { className: 'detail-section detail-actions' }, [
    openLi,
    del,
  ]));
}

async function markAllAccepted() {
  const { contacts = {} } = await dbGet('contacts');
  const now = Date.now();
  let changed = 0;
  for (const item of Object.values(contacts)) {
    if (item.status !== 'accepted') continue;
    if (isMarked(item)) continue;
    item.marked = true;
    item.markedAt = now;
    changed++;
  }
  if (changed === 0) return;
  await dbSet({ contacts });
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCsv() {
  const { contacts = {} } = await dbGet('contacts');
  const rows = [[
    'status', 'name', 'profileUrl', 'headline',
    'location', 'country',
    'firstSeenAt', 'acceptedAt', 'declinedAt', 'daysPending', 'welcomeSent',
    'marked', 'favorite',
    'email', 'phone', 'phoneLabel', 'website', 'address', 'birthday',
    'lastActivityAt', 'lastPostAt',
  ]];
  const iso = (ts) => (ts ? new Date(ts).toISOString() : '');
  for (const r of Object.values(contacts)) {
    rows.push([
      r.status || '', r.name || '', r.profileUrl || '', r.headline || '',
      r.location || '', r.country || '',
      iso(r.firstSeenAt), iso(r.acceptedAt), iso(r.declinedAt), r.daysPending || 0, r.welcomeMessageSent || false,
      r.marked || false, r.favorite || false,
      r.email || '', r.phone || '', r.phoneLabel || '',
      r.website || '', r.address || '', r.birthday || '',
      r.lastActivityAt || '', r.lastPostAt || '',
    ]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.csv`);
}

async function exportJson() {
  const data = await dbGet(null);
  // Payload version 2: unified `contacts` store shape. Importers ≥1.3.0
  // handle both v1 (three-store) and v2 payloads via the migration path.
  const payload = { exportedAt: new Date().toISOString(), version: 2, data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.json`);
}

// Download only the CURRENT tab's list as JSON. Matches what the user
// actually sees on screen — one contacts dict, filtered by status.
async function exportCurrentTab() {
  const tab = activeTabName();
  const { contacts = {} } = await dbGet('contacts');
  const all = Object.values(contacts);

  let items;
  switch (tab) {
    case 'pending':
      items = all.filter((r) => r.status === 'pending');
      break;
    case 'accepted':
      // Accepted tab renders items that are NOT marked, both active + declined.
      items = all.filter((r) => (r.status === 'accepted' || r.status === 'declined') && !isMarked(r));
      break;
    case 'marked':
      items = all.filter((r) => isMarked(r));
      break;
    case 'favorites':
      items = all.filter((r) => r.favorite);
      break;
    default:
      // Settings has no list. Give the user something graceful rather
      // than a zero-byte file: full backup, same as the Settings button.
      return exportJson();
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 2,
    tab,
    count: items.length,
    items,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `linkedin-tracker-${tab}-${date}.json`);
}

async function importJson(file) {
  const status = $('import-status');
  status.classList.remove('error');
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const data = parsed?.data;
    if (!data || typeof data !== 'object') throw new Error('Missing `data` object — not a valid backup');
    // Backup version detection: v1 payload wrappers carry legacy
    // sentInvitations/accepted keys in `data` — migrate them to v2
    // before writing so imports from any old backup land cleanly.
    const isLegacy = LITSchema.isLegacyPayload(parsed);
    const finalData = isLegacy ? LITSchema.migrateToV2(data) : data;
    if (isLegacy) finalData._backup_v1._migratedAt = Date.now();
    await dbClear();
    await dbSet(finalData);
    const contactCount = Object.keys(finalData.contacts || {}).length;
    status.textContent = isLegacy
      ? `Imported ${contactCount} contacts (auto-migrated from legacy v1 backup).`
      : `Imported ${contactCount} contacts.`;
    loadData();
  } catch (e) {
    status.classList.add('error');
    status.textContent = `Import failed: ${e.message}`;
  }
}

function switchTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === `${name}-panel`);
  }
  // The per-tab Download button only makes sense on list tabs. Settings
  // has no list; the full-backup button in that panel serves that need.
  const btn = $('tab-download');
  if (btn) btn.hidden = name === 'settings';
}

// Maps each popup tab to the LinkedIn page it scans. Marked and Settings have
// no scan target — for those tabs the button is hidden.
const TAB_SCAN_TARGETS = {
  pending:  { url: SENT_URL,        source: 'sent',        gotoLabel: 'Go to Sent page' },
  accepted: { url: CONNECTIONS_URL, source: 'connections', gotoLabel: 'Go to Connections page' },
};

function activeTabName() {
  return document.querySelector('.tab.active')?.dataset.tab || 'pending';
}

async function updateScanButton() {
  const btn = $('open-sent');
  const hint = $('scan-hint');
  const target = TAB_SCAN_TARGETS[activeTabName()];

  btn.classList.remove('scanning', 'mode-scan', 'mode-goto');
  btn.disabled = false;

  if (!target) {
    // Marked / Settings — no scan applies, hide the button entirely
    btn.hidden = true;
    hint.hidden = true;
    return;
  }
  btn.hidden = false;

  const { scanInProgress } = await dbGet('scanInProgress');
  const isScanningThisSource = scanInProgress === target.source;
  hint.hidden = !isScanningThisSource;

  btn.dataset.target = target.url;
  btn.dataset.source = target.source;

  if (isScanningThisSource) {
    btn.classList.add('scanning', 'mode-scan');
    btn.textContent = 'Stop';
    btn.title = 'Click to cancel the scan';
    btn.dataset.mode = 'stop';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onTargetPage = tab?.url?.startsWith(target.url);
  document.body.classList.toggle('is-on-sent', onTargetPage && target.source === 'sent');

  if (onTargetPage) {
    btn.classList.add('mode-scan');
    btn.textContent = 'Scan';
    btn.title = 'Start a scan of this page';
    btn.dataset.mode = 'scan';
  } else {
    btn.classList.add('mode-goto');
    btn.textContent = target.gotoLabel;
    btn.title = `Open ${target.gotoLabel.replace(/^Go to /, '')} on LinkedIn`;
    btn.dataset.mode = 'goto';
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'DB_CHANGED') return;
  const keys = msg.keys || [];
  const all = keys.includes('*');
  if (all || keys.includes('scanInProgress')) updateScanButton();
  if (all || keys.includes('contacts') || keys.includes('scanState')) loadData();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchTab(tab.dataset.tab);
    updateScanButton();
  });
});

$('open-sent').addEventListener('click', async () => {
  const btn = $('open-sent');
  const targetUrl = btn.dataset.target;
  if (!targetUrl) return;
  if (btn.dataset.mode === 'goto') {
    chrome.tabs.create({ url: targetUrl });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith(targetUrl)) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SCAN' });
  }
});

$('empty-open-sent').addEventListener('click', () => chrome.tabs.create({ url: SENT_URL }));
$('declined-warning-scan').addEventListener('click', () => chrome.tabs.create({ url: CONNECTIONS_URL }));
$('mark-all').addEventListener('click', markAllAccepted);
$('open-support').addEventListener('click', () => chrome.tabs.create({ url: SUPPORT_URL }));

const CONTACT_DETAIL_FIELDS = [
  'email', 'phone', 'phoneLabel',
  'website', 'websiteLabel', 'extraWebsites',
  'address', 'birthday', 'connectedSinceText',
  'contactsCapturedAt',
];

function stripContactFields(record) {
  let touched = false;
  for (const f of CONTACT_DETAIL_FIELDS) {
    if (record[f] !== undefined) { delete record[f]; touched = true; }
  }
  return touched;
}

async function forgetAllContactDetails() {
  const status = $('forget-status');
  status.classList.remove('error');
  const ok = window.confirm(
    'Wipe captured email/phone/website/address/birthday from every saved contact?\n\n'
    + 'Names, headlines, profile URLs and accepted/marked status are NOT affected. This cannot be undone.'
  );
  if (!ok) return;
  const { contacts = {} } = await dbGet('contacts');
  let touched = 0;
  for (const r of Object.values(contacts)) if (stripContactFields(r)) touched++;
  if (touched === 0) {
    status.textContent = 'No contact details were stored.';
    return;
  }
  await dbSet({ contacts });
  status.textContent = `Cleared contact details from ${touched} record(s).`;
  loadData();
}

$('forget-contacts').addEventListener('click', forgetAllContactDetails);
$('search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  loadData();
});
$('export-csv').addEventListener('click', exportCsv);
$('export-json').addEventListener('click', exportJson);
$('tab-download').addEventListener('click', exportCurrentTab);
$('import-json').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importJson(file);
});

loadData();
updateScanButton();

// ===========================================================================
// Bulk Visit Queue tab — DISABLED for 1.3.0 store submission. See the
// note in background.js near the disabled SW glue. The whole block below
// is dead-code-eliminated via `if (false) { ... }`. Re-enable in 1.3.1
// by (1) restoring the tabs/alarms/idle/webNavigation permissions in
// manifest.json, (2) uncommenting the 🤖 tab button + <section id=
// "visits-panel"> + consent modal in popup.html, (3) re-adding the two
// <script src="core/humanizer.js"> / <script src="core/visit-queue.js">
// imports in popup.html, (4) removing the `if (false)` wrapper below,
// (5) restoring the SW glue in background.js.
// ===========================================================================
if (false) {
const VISITS_DEFAULT_SETTINGS = () => ({
  windowStart: $('visits-window-start').value || '09:00',
  windowEnd:   $('visits-window-end').value   || '21:00',
  tzOffsetMin: -new Date().getTimezoneOffset(),
  dailyCap:    Math.max(1, Math.min(50, Number($('visits-daily-cap').value) || 20)),
  skipRecentDays:  Math.max(0, Number($('visits-skip-days').value) || 0),
  skipFirstDegree: $('visits-skip-1st').checked,
  batchSize:       3,
  betweenMeanSec:  90,
  warmupDays:      Math.max(0, Number($('visits-warmup').value) || 0),
  clickContactInfo: $('visits-click-contact-info').checked,
});

function visitsRandSeed() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] | 0;
}

async function visitsCurrentContacts() {
  const { contacts = {} } = await dbGet('contacts');
  return contacts;
}

function renderVisitsZone(queue) {
  const emoji = $('visits-zone-emoji');
  const label = $('visits-zone-label');
  const count = $('visits-zone-count');
  if (!queue) {
    emoji.textContent = '🟢';
    label.textContent = 'Safe';
    count.textContent = 'no active queue';
    return;
  }
  const now = Date.now();
  const cap = LITVisitQueue.effectiveDailyCap(queue, now, LITHumanizer);
  const visited = LITVisitQueue.todayVisited(queue, now);
  const zone = LITHumanizer.safetyZone({ todayVisited: visited, dailyCap: cap });
  emoji.textContent = zone.emoji;
  label.textContent = zone.label;
  count.textContent = `${visited} / ${cap} today · ${zone.remaining} left`;
}

function renderVisitsStatus(queue) {
  const st = $('visits-status');
  const panic = $('visits-panic');
  if (!queue) {
    st.textContent = 'Idle';
    st.className = 'visits-status';
    panic.hidden = true;
    return;
  }
  st.textContent = queue.status;
  st.className = `visits-status ${queue.status}`;
  panic.hidden = queue.status !== 'running';
}

function renderVisitsQueue(queue) {
  const block = $('visits-queue-block');
  const list = $('visits-list');
  const progress = $('visits-progress');
  const inputBlock = $('visits-input-block');
  const pauseBtn = $('visits-pause-btn');
  const resumeBtn = $('visits-resume-btn');
  const cancelBtn = $('visits-cancel-btn');
  const clearHistoryBtn = $('visits-clear-history-btn');

  if (!queue) {
    block.hidden = true;
    inputBlock.hidden = false;
    return;
  }

  block.hidden = false;
  const isActive = queue.status === 'running' || queue.status === 'paused';
  inputBlock.hidden = isActive; // active queue → can't start a new one until cleared
  pauseBtn.hidden = queue.status !== 'running';
  resumeBtn.hidden = queue.status !== 'paused';
  cancelBtn.hidden = queue.status === 'completed';
  clearHistoryBtn.hidden = queue.status !== 'completed';

  const visited = queue.items.filter((i) => i.status === 'visited').length;
  const skipped = queue.items.filter((i) => i.status === 'skipped').length;
  const failed  = queue.items.filter((i) => i.status === 'failed').length;
  const total = queue.items.length;
  progress.textContent = `${visited} visited · ${skipped} skipped · ${failed} failed · ${total} total`;

  list.innerHTML = '';
  const ICON = {
    queued:   '○', running: '●', visited: '✓',
    skipped:  '⊘', failed:  '✕',
  };
  for (const item of queue.items) {
    const li = el('li', { className: item.status === 'visited' ? 'done' : item.status });
    li.appendChild(el('span', { className: 'visits-list-icon' }, [ICON[item.status] || '?']));
    const short = item.url.replace('https://www.linkedin.com/in/', '');
    li.appendChild(el('span', { className: 'visits-list-url' }, [short]));
    if (item.skipReason) {
      li.appendChild(el('span', { className: 'visits-list-reason' }, [item.skipReason]));
    } else if (item.error) {
      li.appendChild(el('span', { className: 'visits-list-reason' }, [item.error]));
    }
    list.appendChild(li);
  }
}

async function renderVisitsPanel() {
  const { visitQueue } = await dbGet('visitQueue');
  renderVisitsZone(visitQueue);
  renderVisitsStatus(visitQueue);
  renderVisitsQueue(visitQueue);
  renderVisitsHistory();
}

async function visitsPreview() {
  const raw = $('visits-textarea').value;
  const preview = $('visits-preview');
  preview.classList.remove('error');
  if (!raw.trim()) {
    preview.textContent = 'Paste some URLs first.';
    preview.classList.add('error');
    return;
  }
  let parsed;
  try {
    parsed = LITVisitQueue.parseUrlBlob(raw);
  } catch (e) {
    preview.textContent = `Parse error: ${e.message}`;
    preview.classList.add('error');
    return;
  }
  const contacts = await visitsCurrentContacts();
  const settings = VISITS_DEFAULT_SETTINGS();
  let tempQueue;
  try {
    tempQueue = LITVisitQueue.buildQueue({
      rawInput: raw, contacts, settings, now: Date.now(), seed: 1,
    });
  } catch (e) {
    preview.textContent = e.message;
    preview.classList.add('error');
    return;
  }
  const dry = LITVisitQueue.dryRunPreview({
    queue: tempQueue, now: Date.now(), humanizer: LITHumanizer,
  });
  const skips = Object.entries(dry.alreadySkipped)
    .map(([r, n]) => `<li>${n} × ${r}</li>`).join('');
  preview.innerHTML = `
    <b>${dry.willVisit} will be visited</b> · ${dry.totalItems} total
    ${skips ? `<ul>${skips}</ul>` : ''}
    <div style="margin-top:6px">
      Approx. ${dry.estimatedMinutes} min of active work,
      spread across ${dry.daysNeeded} day(s) at ${dry.perDayCap}/day cap.
      ${dry.warmupActive ? '<br><b>Warmup active</b> — first 7 days at 30% cap.' : ''}
    </div>
    ${parsed.invalid.length ? `<div style="margin-top:6px;color:#a01d15">Invalid: ${parsed.invalid.length} entries ignored (${parsed.invalid.slice(0,3).join(', ')}…)</div>` : ''}
  `;
  $('visits-start-btn').hidden = dry.willVisit === 0;
}

async function visitsStart() {
  // Consent gate — first-time users see a modal with the honest
  // risk disclosure. Consent is persisted (visitConsentAt timestamp)
  // and never re-prompted after that.
  const { visitConsentAt } = await dbGet('visitConsentAt');
  if (!visitConsentAt) {
    _pendingVisitStart = true;
    $('visits-consent-modal').hidden = false;
    return;
  }
  await _visitsStartConfirmed();
}

let _pendingVisitStart = false;

async function _visitsStartConfirmed() {
  const raw = $('visits-textarea').value;
  if (!raw.trim()) return;
  const contacts = await visitsCurrentContacts();
  const settings = VISITS_DEFAULT_SETTINGS();
  const seed = visitsRandSeed();
  let queue;
  try {
    queue = LITVisitQueue.buildQueue({
      rawInput: raw, contacts, settings, now: Date.now(), seed,
    });
  } catch (e) {
    $('visits-preview').textContent = e.message;
    $('visits-preview').classList.add('error');
    return;
  }
  queue.status = 'running'; // flip from idle → running
  await dbSet({ visitQueue: queue });
  await chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_START' });
  $('visits-textarea').value = '';
  $('visits-preview').innerHTML = '';
  $('visits-start-btn').hidden = true;
  renderVisitsPanel();
}

async function renderVisitsHistory() {
  const block = $('visits-history-block');
  const list = $('visits-history-list');
  const { visitQueueHistory = [] } = await dbGet('visitQueueHistory');
  if (!visitQueueHistory.length) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  list.innerHTML = '';
  for (const entry of visitQueueHistory) {
    const li = el('li');
    const date = new Date(entry.completedAt).toLocaleString();
    li.appendChild(el('span', { className: 'visits-history-date' }, [date]));
    li.appendChild(el('span', { className: 'visits-history-stats' }, [
      `${entry.visitedCount} visited · ${entry.skippedCount} skipped · ${entry.failedCount} failed · ${entry.itemCount} total`,
    ]));
    list.appendChild(li);
  }
}

async function visitsPause()  { await chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_PAUSE' });  renderVisitsPanel(); }
async function visitsResume() { await chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_RESUME' }); renderVisitsPanel(); }
async function visitsCancel() {
  if (!confirm('Cancel the queue? Remaining items will be marked as skipped.')) return;
  await chrome.runtime.sendMessage({ type: 'VISIT_QUEUE_CANCEL' });
  renderVisitsPanel();
}
async function visitsClearHistory() {
  await dbDelete(['visitQueue']);
  renderVisitsPanel();
}

$('visits-preview-btn').addEventListener('click', visitsPreview);
$('visits-start-btn').addEventListener('click', visitsStart);
$('visits-clear-btn').addEventListener('click', () => {
  $('visits-textarea').value = '';
  $('visits-preview').innerHTML = '';
  $('visits-start-btn').hidden = true;
});
$('visits-pause-btn').addEventListener('click', visitsPause);
$('visits-resume-btn').addEventListener('click', visitsResume);
$('visits-cancel-btn').addEventListener('click', visitsCancel);
$('visits-panic-stop').addEventListener('click', visitsCancel);
$('visits-clear-history-btn').addEventListener('click', visitsClearHistory);

// Consent modal — persist visitConsentAt once accepted, gate visitsStart
// on it until then.
$('visits-consent-check').addEventListener('change', (e) => {
  $('visits-consent-accept').disabled = !e.target.checked;
});
$('visits-consent-cancel').addEventListener('click', () => {
  $('visits-consent-modal').hidden = true;
  $('visits-consent-check').checked = false;
  $('visits-consent-accept').disabled = true;
  _pendingVisitStart = false;
});
$('visits-consent-accept').addEventListener('click', async () => {
  if (!$('visits-consent-check').checked) return;
  await dbSet({ visitConsentAt: Date.now() });
  $('visits-consent-modal').hidden = true;
  if (_pendingVisitStart) {
    _pendingVisitStart = false;
    await _visitsStartConfirmed();
  }
});

// Live re-render when the SW pushes a queue change
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'VISIT_QUEUE_CHANGED') renderVisitsPanel();
  if (msg?.type === 'DB_CHANGED' && (msg.keys || []).includes('visitQueue')) renderVisitsPanel();
});

// First render + rerender whenever the Visits tab is opened
renderVisitsPanel();
document.querySelector('.tab[data-tab="visits"]').addEventListener('click', renderVisitsPanel);
} // end if(false) — bulk-visit-queue disabled block
