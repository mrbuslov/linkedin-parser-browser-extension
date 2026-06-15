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
      : `${items.length} pending · sorted oldest first`;

  const sorted = filtered.slice().sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  for (const item of sorted) list.append(renderPendingRow(item));
}

function isMarked(item) {
  // welcomeMessageSent kept for backwards-compat with older storage entries
  return Boolean(item.marked || item.welcomeMessageSent);
}

function renderAcceptedRow(item, { primaryAction, primaryLabel }) {
  const sinceAccepted = ageDays(item.acceptedAt);
  const isDeclined = item.verified === 'declined';

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
        statusBadge(item.verified),
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
  const active = unmarked.filter((x) => x.verified !== 'declined');
  const declined = unmarked.filter((x) => x.verified === 'declined');
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
// dedupes by profileUrl. When a person lives in both `accepted` and
// `contacts` we prefer the accepted record (richer — has acceptedAt,
// verified, etc); when they're in sentInvitations + contacts, sentInvitations
// wins. Each row uses the same row-renderer as the source tab would, so the
// UI is consistent (Mark/Unmark/Delete buttons all work).
function renderFavorites(sentInvitations, accepted, contacts) {
  const list = $('favorites-list');
  list.innerHTML = '';

  const byUrl = new Map();
  // Order matters: later writes win for the same URL. accepted has the richest
  // data; sentInvitations is next; contacts is the lowest-priority fallback.
  for (const [src, store] of [['contact', contacts], ['pending', sentInvitations], ['accepted', accepted]]) {
    for (const item of Object.values(store)) {
      if (!item.favorite) continue;
      byUrl.set(item.profileUrl, { ...item, _source: src });
    }
  }

  const all = Array.from(byUrl.values()).map(viewItem);
  const visible = all.filter(matchesSearch);
  $('favorites-empty').hidden = all.length > 0;
  $('favorites-summary').textContent = all.length === 0
    ? ''
    : searchQuery
      ? `${visible.length} of ${all.length} match`
      : `${all.length} favorited`;

  const sorted = visible.slice().sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));
  for (const item of sorted) {
    if (item._source === 'accepted') {
      list.append(renderAcceptedRow(item, {
        primaryAction: (url) => setMarked(url, !isMarked(item)),
        primaryLabel: isMarked(item) ? 'Unmark' : 'Mark',
      }));
    } else if (item._source === 'pending') {
      list.append(renderPendingRow(item));
    } else {
      // contacts-only entry — no Pending/Accepted bucket, render a simpler row.
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

// One-shot migration: walk every record across the three stores and undo
// any name/headline swap. Runs once per popup open. Idempotent: if all
// records are already clean, no write happens. We persist the corrected
// data so downstream consumers (CSV export, /sent/ diff, /connections/
// merge) all see the clean shape too.
async function migrateSwappedNames() {
  const { sentInvitations = {}, accepted = {}, contacts = {} } =
    await dbGet(['sentInvitations', 'accepted', 'contacts']);
  const patch = {};
  for (const [storeName, store] of [
    ['sentInvitations', sentInvitations],
    ['accepted',        accepted],
    ['contacts',        contacts],
  ]) {
    let changed = false;
    for (const rec of Object.values(store)) {
      const fixed = LITPopupLogic.fixSwappedNameHeadline(rec);
      if (fixed.name !== rec.name || fixed.headline !== rec.headline) {
        rec.name = fixed.name;
        rec.headline = fixed.headline;
        changed = true;
      }
    }
    if (changed) patch[storeName] = store;
  }
  if (Object.keys(patch).length > 0) {
    await dbSet(patch);
    console.log(`[LI Tracker] migration cleaned name/headline swap in: ${Object.keys(patch).join(', ')}`);
  }
}

// One-shot cleanup of pre-1.2.5 auto-marked records. The brand-new accepted
// branch used to set `marked: true, autoMarked: true` on any "first time we
// see this connection" profile visit — including freshly accepted invites
// whose pending phase we missed. Those entries got silently buried in the
// Marked tab. Now they land in Accepted; this migration unsticks the
// pre-existing legacy records so the user doesn't have to Unmark each by
// hand. Idempotent: only flips records where BOTH `autoMarked === true`
// AND `marked === true` (so a user who explicitly marked an entry that
// happened to also be autoMarked is left alone).
async function migrateAutoMarkedToUnmarked() {
  const { accepted = {} } = await dbGet('accepted');
  let changed = 0;
  for (const rec of Object.values(accepted)) {
    if (rec.autoMarked === true && rec.marked === true) {
      rec.marked = false;
      rec.markedAt = null;
      // Clear autoMarked so this migration is permanently idempotent — a
      // second pass finds nothing to do. If the user later re-marks the
      // entry explicitly, it stays manually-marked (no autoMarked flag).
      delete rec.autoMarked;
      changed++;
    }
  }
  if (changed > 0) {
    await dbSet({ accepted });
    console.log(`[LI Tracker] migration: unmarked ${changed} legacy auto-marked records`);
  }
}

async function loadData() {
  await migrateSwappedNames();
  await migrateAutoMarkedToUnmarked();

  const { sentInvitations = {}, accepted = {}, contacts = {}, scanHistory = [], scanState = {} } =
    await dbGet(['sentInvitations', 'accepted', 'contacts', 'scanHistory', 'scanState']);

  renderPending(Object.values(sentInvitations));
  renderAccepted(Object.values(accepted), scanState.connections);
  renderMarked(Object.values(accepted));
  renderFavorites(sentInvitations, accepted, contacts);
  renderScanInfo($('pending-scan-info'), scanState.sent);
  renderScanInfo($('accepted-scan-info'), scanState.connections);

  const lastScan = scanHistory[scanHistory.length - 1];
  const stats = `pending: ${Object.keys(sentInvitations).length} · accepted: ${Object.keys(accepted).length} · scans: ${scanHistory.length}`;
  $('stats-line').textContent = lastScan
    ? `${stats} · last scan ${new Date(lastScan.timestamp).toLocaleString()}`
    : stats;
}

async function setMarked(profileUrl, value) {
  const { accepted = {} } = await dbGet('accepted');
  if (!accepted[profileUrl]) return;
  accepted[profileUrl].marked = value;
  accepted[profileUrl].markedAt = value ? Date.now() : null;
  if (!value) accepted[profileUrl].welcomeMessageSent = false;
  await dbSet({ accepted });
}

// Permanently remove an entry by its profileUrl across every store it lives
// in (sentInvitations, accepted, contacts). Used by per-row Delete and the
// cleanup flow for stale duplicates. Confirm dialog gates the action so a
// stray click can't nuke a contact.
async function deleteEntry(profileUrl, displayName) {
  const ok = window.confirm(
    `Delete "${displayName || profileUrl}" from the tracker?\n\n`
    + 'Removes this entry from Pending / Accepted / Marked / Contacts. '
    + 'Cannot be undone. If LinkedIn still has the actual connection, a '
    + 'future /connections/ scan will re-add them.'
  );
  if (!ok) return;
  const { sentInvitations = {}, accepted = {}, contacts = {} } =
    await dbGet(['sentInvitations', 'accepted', 'contacts']);
  const patch = {};
  if (sentInvitations[profileUrl]) { delete sentInvitations[profileUrl]; patch.sentInvitations = sentInvitations; }
  if (accepted[profileUrl])        { delete accepted[profileUrl];        patch.accepted        = accepted; }
  if (contacts[profileUrl])        { delete contacts[profileUrl];        patch.contacts        = contacts; }
  if (Object.keys(patch).length > 0) await dbSet(patch);
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
  const stored = await dbGet(['sentInvitations', 'accepted', 'contacts']);
  const cur =
       stored.sentInvitations?.[profileUrl]?.favorite
    || stored.accepted?.[profileUrl]?.favorite
    || stored.contacts?.[profileUrl]?.favorite
    || false;
  const next = !cur;
  const now = Date.now();
  const patch = {};
  for (const storeName of ['sentInvitations', 'accepted', 'contacts']) {
    const store = stored[storeName] || {};
    if (!store[profileUrl]) continue;
    store[profileUrl].favorite = next;
    store[profileUrl].favoritedAt = next ? now : null;
    patch[storeName] = store;
  }
  if (Object.keys(patch).length === 0) return;
  await dbSet(patch);
}

// ---------- Detail view ----------
//
// Click ⓘ on any row → the list panel hides, a full-width detail panel
// renders every stored field for that profile. Back button returns to the
// previously-active tab. Implemented as a separate <section id="detail-panel">
// — same `.panel` slot system the tabs use, plus a `showing-detail` body
// class that hides the tab switcher while a detail is open.

let detailReturnTab = 'pending';

async function openDetailView(profileUrl) {
  detailReturnTab = activeTabName();
  const { sentInvitations = {}, accepted = {}, contacts = {} } =
    await dbGet(['sentInvitations', 'accepted', 'contacts']);
  const item = accepted[profileUrl] || sentInvitations[profileUrl] || contacts[profileUrl];
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
        item.verified ? statusBadge(item.verified) : null,
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
    field('Status', item.verified || (item.connected ? 'connected' : null)),
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
  const { accepted = {} } = await dbGet('accepted');
  const now = Date.now();
  let changed = 0;
  for (const item of Object.values(accepted)) {
    if (isMarked(item)) continue;
    if (item.verified === 'declined') continue;
    item.marked = true;
    item.markedAt = now;
    changed++;
  }
  if (changed === 0) return;
  await dbSet({ accepted });
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
  const { sentInvitations = {}, accepted = {}, contacts = {} } =
    await dbGet(['sentInvitations', 'accepted', 'contacts']);
  const rows = [[
    'status', 'verified', 'name', 'profileUrl', 'headline',
    'firstSeenAt', 'acceptedAt', 'daysPending', 'welcomeSent',
    'email', 'phone', 'phoneLabel', 'website', 'address', 'birthday',
    'lastActivityAt', 'lastPostAt',
  ]];
  // contacts holds the captured contact-info modal fields. We join them in
  // by profileUrl so even accepted rows where the user opened the overlay
  // get their email/phone exported alongside.
  const contactOf = (url) => contacts[url] || {};
  const pickActivity = (rec, c) => [
    rec.lastActivityAt || c.lastActivityAt || '',
    rec.lastPostAt     || c.lastPostAt     || '',
  ];
  for (const x of Object.values(sentInvitations)) {
    const c = contactOf(x.profileUrl);
    rows.push(['pending', '', x.name, x.profileUrl, x.headline,
      new Date(x.firstSeenAt).toISOString(), '', '', '',
      x.email || c.email || '', x.phone || c.phone || '', x.phoneLabel || c.phoneLabel || '',
      x.website || c.website || '', x.address || c.address || '', x.birthday || c.birthday || '',
      ...pickActivity(x, c)]);
  }
  for (const x of Object.values(accepted)) {
    const c = contactOf(x.profileUrl);
    rows.push(['accepted', x.verified || '', x.name, x.profileUrl, x.headline,
      new Date(x.firstSeenAt).toISOString(), new Date(x.acceptedAt).toISOString(),
      x.daysPending, x.welcomeMessageSent,
      x.email || c.email || '', x.phone || c.phone || '', x.phoneLabel || c.phoneLabel || '',
      x.website || c.website || '', x.address || c.address || '', x.birthday || c.birthday || '',
      ...pickActivity(x, c)]);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.csv`);
}

async function exportJson() {
  const data = await dbGet(null);
  const payload = { exportedAt: new Date().toISOString(), version: 1, data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `linkedin-tracker-${new Date().toISOString().slice(0, 10)}.json`);
}

async function importJson(file) {
  const status = $('import-status');
  status.classList.remove('error');
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const data = parsed?.data;
    if (!data || typeof data !== 'object') throw new Error('Missing `data` object — not a valid backup');
    await dbClear();
    await dbSet(data);
    status.textContent = `Imported ${Object.keys(data).length} keys.`;
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
  if (all || keys.includes('sentInvitations') || keys.includes('accepted') || keys.includes('scanState')) loadData();
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
  const { contacts = {}, accepted = {} } = await dbGet(['contacts', 'accepted']);
  let touched = 0;
  for (const r of Object.values(contacts)) if (stripContactFields(r)) touched++;
  for (const r of Object.values(accepted)) if (stripContactFields(r)) touched++;
  if (touched === 0) {
    status.textContent = 'No contact details were stored.';
    return;
  }
  await dbSet({ contacts, accepted });
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
$('import-json').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importJson(file);
});

loadData();
updateScanButton();
