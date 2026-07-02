// Pure state-transition function for a single profile visit.
//
// v2 (unified `contacts` store): every profile lives in ONE dict keyed by
// profileUrl. Each entry has a `status` field:
//   'pending'  — invite sent, awaiting response
//   'accepted' — 1st-degree connection
//   'declined' — invite withdrawn/rejected OR we later saw them as
//                not-connected without canonical /connections/ proof
//   'visited'  — we saw the profile but never invited and it's not a connection
//
// Invariants preserved from v1:
//   - `connectedOnText` guard: an entry whose status has been canonically
//     confirmed via the /connections/ scan is NEVER downgraded by a
//     transient profile-page read that says "not_connected".
//   - Cross-URL dedup by memberId: if the same LinkedIn member appears
//     under a NEW URL (person changed their vanity), we merge histories
//     and drop the stale URL.
//   - "One record per profileUrl" is now trivial — one dict, one key.
//   - Contact-info modal data is on the same entry as everything else
//     (used to be in `contacts`, joined by URL on read).
//
// Wrapped in IIFE — see schema-v2.js header for the rationale.

(function () {

const DAY_MS = 86400000;

const STATUS = {
  PENDING:  'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  VISITED:  'visited',
};

// Metadata fields that flow from `info` (DOM extraction) into any record
// we create. Kept as a single source of truth so a new metadata field
// added to the extractor propagates through every write path with one
// edit here.
function metadataFromInfo(info) {
  const out = {
    headline:     info.headline     || '',
    avatar:       info.avatar       || '',
    location:     info.location     || '',
    country:      info.country      || '',
    mutualsUrl:   info.mutualsUrl   || '',
    mutualsText:  info.mutualsText  || '',
    mutualsCount: info.mutualsCount != null ? info.mutualsCount : null,
    lastActivityAt: info.lastActivityAt || null,
    lastPostAt:     info.lastPostAt     || null,
    recentActivity: Array.isArray(info.recentActivity) ? info.recentActivity : [],
  };
  if (info.memberId)   out.memberId   = info.memberId;
  if (info.vanityName) out.vanityName = info.vanityName;
  return out;
}

// Inline merge of recentActivity[]. Dedupe by urnActivityId (fresh wins
// on collision), sort by postedAt desc, cap at 5.
function mergeRecentActivityInline(existing, fresh, max = 5) {
  const byUrn = new Map();
  for (const c of existing || []) {
    if (c && c.urnActivityId) byUrn.set(c.urnActivityId, c);
  }
  for (const c of fresh || []) {
    if (c && c.urnActivityId) byUrn.set(c.urnActivityId, c);
  }
  return Array.from(byUrn.values())
    .filter((c) => c.postedAt)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .slice(0, max);
}

// Apply fresh activity fields onto `target`, preserving history:
//   - recentActivity → merge (URN dedupe, prefer fresh on collision).
//   - lastActivityAt / lastPostAt → keep the LATER of (prev, fresh).
function applyActivityFields(target, prev, info) {
  if (!target) return;
  const prevList = (prev && prev.recentActivity) || target.recentActivity || [];
  const freshList = Array.isArray(info.recentActivity) ? info.recentActivity : [];
  target.recentActivity = mergeRecentActivityInline(prevList, freshList);

  const pickNewer = (a, b) => (!a ? (b || null) : !b ? a : (a > b ? a : b));
  const prevLA = (prev && prev.lastActivityAt) || target.lastActivityAt || null;
  const prevLP = (prev && prev.lastPostAt)     || target.lastPostAt     || null;
  target.lastActivityAt = pickNewer(prevLA, info.lastActivityAt || null);
  target.lastPostAt     = pickNewer(prevLP, info.lastPostAt     || null);
}

// Refresh field policy: fresh non-empty value wins, always.
//   - Avatar has TWO signals now: info.avatar (URL or '') AND
//     info.avatarConfirmed (bool). Confirmed=true means we saw the
//     canonical Profile-photo anchor and can be trusted; confirmed=false
//     means the anchor was missing (mid-render) and we shouldn't wipe
//     stored good data with an empty read.
//   - Name is NOT refreshed here — identity is sticky. `applyProfileVisit`
//     overwrites name at fresh-record creation and via cross-URL dedup.
function refreshMetadata(target, info) {
  let changed = false;
  if (info.avatarConfirmed) {
    if (info.avatar !== target.avatar) { target.avatar = info.avatar || ''; changed = true; }
  } else if (info.avatar && info.avatar !== target.avatar) {
    target.avatar = info.avatar; changed = true;
  }
  if (info.headline    && info.headline !== target.headline)      { target.headline = info.headline; changed = true; }
  if (info.location    && info.location !== target.location)      { target.location = info.location; changed = true; }
  if (info.country     && info.country  !== target.country)       { target.country  = info.country;  changed = true; }
  if (info.mutualsUrl  && info.mutualsUrl  !== target.mutualsUrl)   { target.mutualsUrl  = info.mutualsUrl;  changed = true; }
  if (info.mutualsText && info.mutualsText !== target.mutualsText) { target.mutualsText = info.mutualsText; changed = true; }
  if (info.mutualsCount != null && info.mutualsCount !== target.mutualsCount) { target.mutualsCount = info.mutualsCount; changed = true; }
  return changed;
}

const CONTACT_FIELDS = [
  'email', 'phone', 'phoneLabel',
  'website', 'websiteLabel', 'extraWebsites',
  'address', 'birthday', 'connectedSinceText',
];

// Find an existing record in `contacts` under a DIFFERENT URL that refers
// to the same LinkedIn member as `targetUrl`. Anchored on `memberId`
// only — name matching is deliberately never used (two real people can
// share a name; silent merge corrupts data with no recovery).
function findDuplicateRecord(contacts, targetUrl, targetMemberId) {
  if (!targetMemberId) return null;
  for (const [url, rec] of Object.entries(contacts)) {
    if (url === targetUrl) continue;
    if (rec.memberId && rec.memberId === targetMemberId) return url;
  }
  return null;
}

// Migrate the OLD record's fields into the CURRENT record at `targetUrl`
// (both under `contacts`), then delete the old key. Current record's
// STATUS wins (it's the freshest observation), but historical fields
// from the old record are grafted in where the current lacks them.
function mergeIntoTarget(contacts, oldUrl, targetUrl) {
  const old = contacts[oldUrl] || {};
  const cur = contacts[targetUrl] || {};
  const merged = { ...old, ...cur };
  merged.profileUrl = targetUrl;
  for (const f of ['headline', 'avatar', 'location', 'country', ...CONTACT_FIELDS]) {
    if (!cur[f] && old[f]) merged[f] = old[f];
  }
  if (old.contactsCapturedAt && (!cur.contactsCapturedAt || old.contactsCapturedAt > cur.contactsCapturedAt)) {
    merged.contactsCapturedAt = old.contactsCapturedAt;
  }
  if (old.firstSeenAt && (!cur.firstSeenAt || old.firstSeenAt < cur.firstSeenAt)) {
    merged.firstSeenAt = old.firstSeenAt;
  }
  if (old.acceptedAt && (!cur.acceptedAt || old.acceptedAt < cur.acceptedAt)) {
    merged.acceptedAt = old.acceptedAt;
  }
  if (old.marked) {
    merged.marked = true;
    if (!cur.markedAt && old.markedAt) merged.markedAt = old.markedAt;
  }
  if (old.favorite) {
    merged.favorite = true;
    if (!cur.favoritedAt && old.favoritedAt) merged.favoritedAt = old.favoritedAt;
  }
  // Status: current record's status is the freshest observation. Special
  // case: a previously-accepted record downgrading to visited should
  // NOT lose the accepted status without canonical proof — either
  // connectedOnText (from /connections/ scan) OR firstConnectedAt
  // (self-reinforcing marker set on any prior 'connected' observation).
  if (old.status === STATUS.ACCEPTED
      && cur.status !== STATUS.ACCEPTED
      && (old.connectedOnText || old.firstConnectedAt)) {
    merged.status = STATUS.ACCEPTED;
  }
  if (old.connectedOnText && !cur.connectedOnText) merged.connectedOnText = old.connectedOnText;
  if (old.connectedOnDate && !cur.connectedOnDate) merged.connectedOnDate = old.connectedOnDate;
  // firstConnectedAt is sticky — earliest observation wins.
  if (old.firstConnectedAt && (!cur.firstConnectedAt || old.firstConnectedAt < cur.firstConnectedAt)) {
    merged.firstConnectedAt = old.firstConnectedAt;
  }
  // Preserve prior-URL history (useful for debugging vanity-rename cases).
  merged._priorUrls = merged._priorUrls || [];
  if (!merged._priorUrls.includes(oldUrl)) merged._priorUrls.push(oldUrl);
  contacts[targetUrl] = merged;
  delete contacts[oldUrl];
}

// Overwrite-on-visit semantics for the Contact-info modal fields.
function applyContactInfo(target, contactInfo, now) {
  if (!contactInfo) return false;
  let changed = false;
  for (const f of CONTACT_FIELDS) {
    const incoming = contactInfo[f];
    if (incoming === undefined) continue;
    if (target[f] !== incoming) { target[f] = incoming; changed = true; }
  }
  if (changed) target.contactsCapturedAt = now;
  return changed;
}

// Main entry point. `stored` is the whole IDB snapshot (v2 shape:
// `{contacts, schemaVersion, ...}`). Returns { contacts, changed }
// where `changed` tells the caller whether anything actually mutated
// (so it can skip the dbSet on quiet ticks).
function applyProfileVisit(stored, info, status, now, contactInfo) {
  const contacts = { ...(stored.contacts || {}) };
  const profileUrl = info.profileUrl;

  // Cross-URL dedup FIRST so status/contact-info updates land on the
  // merged record, not on a stale duplicate at the old URL.
  const dupUrl = findDuplicateRecord(contacts, profileUrl, info.memberId);
  if (dupUrl) {
    mergeIntoTarget(contacts, dupUrl, profileUrl);
  }

  const prev = contacts[profileUrl] || {};

  // Preserve fields the current tick cannot re-produce:
  //   - carriedContactFields: modal fields we captured on a previous
  //     visit when the user had the overlay open
  //   - user-authored: notes, tags, favorite, marked
  //   - source-of-truth timestamps: firstSeenAt, acceptedAt, verifiedAt
  //     (only earlier values win; never move forward here)
  const carriedContactFields = {};
  for (const f of CONTACT_FIELDS) {
    if (prev[f] !== undefined) carriedContactFields[f] = prev[f];
  }
  if (prev.contactsCapturedAt) carriedContactFields.contactsCapturedAt = prev.contactsCapturedAt;

  // Compute the new status and any timestamp side-effects. `observed`
  // (raw detector output) is passed to timingUpdates separately so the
  // anti-downgrade guard doesn't accidentally bump verifiedAt on a
  // not_connected tick that was refused for lack of canonical proof.
  const newStatus = statusFromVisit(status, prev);
  const timing = timingUpdates(newStatus, status, prev, now);

  // Build the record. Metadata refresh policy for headline/location/etc.
  // is applied via metadataFromInfo (write-through); avatar goes through
  // the explicit refresh helper because it has the avatarConfirmed guard.
  const next = {
    profileUrl,
    // Identity — sticky from prev unless fresh has non-empty.
    name: info.name || prev.name || '',
    memberId:   info.memberId   || prev.memberId   || undefined,
    vanityName: info.vanityName || prev.vanityName || undefined,

    // Timeline
    firstSeenAt: prev.firstSeenAt || now,
    visitedAt: now,

    // Sticky user flags — carried from prev, tick may override marked/favorite
    marked:       prev.marked       || false,
    markedAt:     prev.markedAt     || null,
    favorite:     prev.favorite     || false,
    favoritedAt:  prev.favoritedAt  || null,

    // Sent-page shape carried from prev if present
    lastSeenAt:       prev.lastSeenAt       || null,
    sentDateRelative: prev.sentDateRelative || '',
    addedFrom:        prev.addedFrom        || 'profile',
    withdrawnAt:      prev.withdrawnAt      || null,

    // Welcome tracking
    welcomeMessageSent: prev.welcomeMessageSent || false,

    // Canonical connection proof carried through
    connectedOnText: prev.connectedOnText || '',
    connectedOnDate: prev.connectedOnDate || '',

    // Contact-info modal (carried)
    ...carriedContactFields,

    // Notes / tags carried
    notes: prev.notes || '',
    tags:  Array.isArray(prev.tags) ? prev.tags : [],

    // Mutuals carried
    mutualsCollected:   prev.mutualsCollected   || undefined,
    mutualsCollectedAt: prev.mutualsCollectedAt || undefined,

    // Prior URLs history (from cross-URL dedup)
    _priorUrls: prev._priorUrls,

    // Metadata refresh (write-through fresh non-empty)
    ...metadataFromInfo(info),

    // Status + status-timing
    status: newStatus,
    acceptedAt:       timing.acceptedAt,
    declinedAt:       timing.declinedAt,
    verifiedAt:       timing.verifiedAt,
    firstConnectedAt: timing.firstConnectedAt,
    daysPending:      timing.daysPending,
  };

  // Avatar has the confirmed guard — go through refreshMetadata rather than
  // the raw spread. metadataFromInfo already wrote fresh info.avatar; the
  // refresh helper only fires if we should NOT overwrite (mid-render empty).
  // Emulate refreshMetadata inline: if info.avatarConfirmed=false AND
  // info.avatar=='' AND prev.avatar was non-empty, restore prev.avatar.
  if (!info.avatarConfirmed && !info.avatar && prev.avatar) {
    next.avatar = prev.avatar;
  }

  // Activity fields — merge with prev history
  applyActivityFields(next, prev, info);

  // Contact-info modal — overwrites when the user has the overlay open
  applyContactInfo(next, contactInfo, now);

  contacts[profileUrl] = next;

  // Change detection: has anything material changed vs prev?
  const changed = didChange(prev, next) || Boolean(dupUrl);

  return { contacts, changed };
}

// Decide the new `status` from the extracted profile status + prior state.
// Preserves the connectedOnText anti-downgrade guard: an entry that was
// canonically confirmed as connected via the /connections/ scan cannot be
// downgraded by a transient profile-page read.
function statusFromVisit(observed, prev) {
  if (observed === 'pending')   return STATUS.PENDING;
  if (observed === 'connected') return STATUS.ACCEPTED;
  // observed === 'not_connected'
  //
  // TWO independent anti-downgrade guards, either strong enough on
  // its own to refuse a downgrade:
  //
  //   connectedOnText  — canonical proof from the /connections/ scan,
  //                      strongest signal, set only when LinkedIn's own
  //                      "Connected on Jan 5, 2024" text was observed.
  //   firstConnectedAt — self-reinforcing marker set the FIRST time we
  //                      observed 'connected' via any signal (RSC or
  //                      aria). Once set, never cleared. Fixes the
  //                      Wendy-class regression where a transient DOM
  //                      state (sidebar bleed, RSC not yet hydrated)
  //                      returned 'not_connected' and downgraded a real
  //                      1st-degree to 'declined'.
  if (prev.connectedOnText || prev.firstConnectedAt) {
    return prev.status || STATUS.ACCEPTED;
  }
  if (prev.status === STATUS.ACCEPTED || prev.status === STATUS.PENDING) {
    return STATUS.DECLINED;
  }
  return prev.status || STATUS.VISITED;
}

// Compute status-driven timing side-effects. Only mutates timestamps
// when the status transition warrants it — e.g. acceptedAt is set the
// first time a pending record moves to accepted (or on brand-new
// accepted creation).
function timingUpdates(newStatus, observed, prev, now) {
  const out = {
    acceptedAt:       prev.acceptedAt        || null,
    declinedAt:       prev.declinedAt        || null,
    verifiedAt:       prev.verifiedAt        || null,
    firstConnectedAt: prev.firstConnectedAt  || null,
    daysPending:      prev.daysPending       || 0,
  };
  if (newStatus === STATUS.ACCEPTED) {
    if (!out.acceptedAt) out.acceptedAt = now;
    // verifiedAt bumps ONLY when the raw observation was 'connected'. A
    // not_connected observation that was refused-to-downgrade via the
    // connectedOnText guard must NOT touch verifiedAt — otherwise the
    // guard would spuriously report "changed=true" every quiet tick.
    if (observed === 'connected') {
      out.verifiedAt = now;
      // firstConnectedAt is sticky — set once on the FIRST 'connected'
      // observation, never cleared. This is the self-reinforcing guard
      // that keeps the record classified as accepted even if a future
      // transient DOM read returns 'not_connected'.
      if (!out.firstConnectedAt) out.firstConnectedAt = now;
    }
    if (prev.firstSeenAt) {
      out.daysPending = Math.floor((out.acceptedAt - prev.firstSeenAt) / DAY_MS);
    }
    // If they were previously declined and are now accepted again, clear declined stamp.
    if (prev.status === STATUS.DECLINED && observed === 'connected') out.declinedAt = null;
  } else if (newStatus === STATUS.DECLINED) {
    if (!out.declinedAt) out.declinedAt = now;
    if (!out.verifiedAt) out.verifiedAt = now;
  }
  return out;
}

// Compare prev vs next for "anything user-visible or downstream-important
// changed". Used by the caller to decide whether to persist.
function didChange(prev, next) {
  if (!prev || !next) return true;
  const keys = [
    'status', 'name', 'headline', 'avatar', 'location', 'country',
    'marked', 'favorite', 'acceptedAt', 'declinedAt', 'verifiedAt',
    'mutualsUrl', 'mutualsCount', 'lastActivityAt', 'lastPostAt',
    ...CONTACT_FIELDS,
  ];
  for (const k of keys) {
    if ((prev[k] ?? null) !== (next[k] ?? null)) return true;
  }
  // recentActivity urn-list changed?
  const prevIds = (prev.recentActivity || []).map((c) => c.urnActivityId).join(',');
  const nextIds = (next.recentActivity || []).map((c) => c.urnActivityId).join(',');
  if (prevIds !== nextIds) return true;
  return false;
}

const LITProfileState = {
  applyProfileVisit,
  applyContactInfo,
  applyActivityFields,
  mergeRecentActivityInline,
  refreshMetadata,
  metadataFromInfo,
  statusFromVisit,
  timingUpdates,
  didChange,
  STATUS,
  CONTACT_FIELDS,
  DAY_MS,
};
if (typeof globalThis !== 'undefined') globalThis.LITProfileState = LITProfileState;
if (typeof module !== 'undefined' && module.exports) module.exports = LITProfileState;

})();
