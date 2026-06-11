// Pure state-transition function for a single profile visit.
// Caller (profile.js content script) has the raw DOM-scraped `info` and a
// `status` from detectConnectionStatus(). This function applies the "one bucket
// at a time" invariant: each profileUrl lives in EITHER sentInvitations OR
// accepted OR neither (only in contacts) — never both.
//
// Returns the mutated stores plus changed flags so the caller can skip writes
// that didn't touch certain keys (small perf optimization for IndexedDB).

const DAY_MS = 86400000;

// Refresh field policy:
//   - name → never overwrite here (identity is sticky; mid-render bad names
//     would corrupt it; cross-URL dedup handles legitimate name changes)
//   - headline / location / country → ALWAYS overwrite when we have a fresh
//     non-empty value. The extractor is now deterministically clean (skips
//     video.js placeholders, degree badges, name-glued SR text), so the
//     latest visit is the freshest truth. Old "first non-empty wins" policy
//     left stale junk like "Video Player is loading." permanently stuck.
//   - avatar → only set if currently empty. LinkedIn lazy-loads cover/photo
//     images, so a mid-render scrape can yield "" — we don't want to wipe
//     a known-good URL with empty.
//   - mutuals* → overwrite when fresh value differs. Counts drift naturally.
function refreshMetadata(target, info) {
  let changed = false;
  if (info.avatar      && !target.avatar)                         { target.avatar = info.avatar; changed = true; }
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

// Find an existing record in `store` under a DIFFERENT URL that refers to
// the same person as `targetUrl`. We rely ONLY on memberId — LinkedIn's
// internal numeric profile ID, which is canonical and unforgeable. Name
// matching is deliberately NOT used: two different people can share a name,
// and silently merging them corrupts data with no recovery. If memberId is
// missing on either side, we simply don't dedup — the user can clean up
// duplicates manually if they bother them, but we never auto-merge by guess.
function findDuplicateRecord(store, targetUrl, targetMemberId) {
  if (!targetMemberId) return null;
  for (const [url, rec] of Object.entries(store)) {
    if (url === targetUrl) continue;
    if (rec.memberId && rec.memberId === targetMemberId) return url;
  }
  return null;
}

// Migrate the OLD record's fields into the CURRENT record at `targetUrl`,
// then delete the old key. Used by the cross-URL dedup pass. Current record
// takes precedence for fresh fields (name, status), but we restore:
//   - non-empty contact info and metadata from old when current doesn't have it
//   - earlier firstSeenAt / acceptedAt (real history > current snapshot)
//   - marked status (don't lose the user's manual action)
//   - 'accepted' verified status (don't auto-downgrade)
function mergeIntoTarget(store, oldUrl, targetUrl) {
  const old = store[oldUrl] || {};
  const cur = store[targetUrl] || {};
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
  if (old.verified === 'accepted' && cur.verified !== 'accepted') {
    merged.verified = 'accepted';
    if (!cur.verifiedAt && old.verifiedAt) merged.verifiedAt = old.verifiedAt;
  }
  if (old.connectedOnText && !cur.connectedOnText) merged.connectedOnText = old.connectedOnText;
  if (old.connectedOnDate && !cur.connectedOnDate) merged.connectedOnDate = old.connectedOnDate;
  store[targetUrl] = merged;
  delete store[oldUrl];
}

// Overwrite-on-visit semantics: every time the user opens the Contact info
// overlay we replace the stored fields with the freshly parsed ones. Simpler
// than a history log, and the LinkedIn UI is itself the source of truth — if
// the user edits their phone, we want the latest. We stamp `contactsCapturedAt`
// so the popup can tell "saved" from "never captured". Returns true iff
// anything changed in the target record.
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

function applyProfileVisit(stored, info, status, now, contactInfo) {
  const contacts = { ...(stored.contacts || {}) };
  const accepted = { ...(stored.accepted || {}) };
  const sentInvitations = { ...(stored.sentInvitations || {}) };
  const profileUrl = info.profileUrl;

  // CROSS-URL DEDUP — runs BEFORE the per-store branching below so that the
  // status/contact-info updates land on the merged record, not on a stale
  // duplicate. Common case fixed: a contact got verified=declined on the
  // OLD URL (pre-1.2.2 RSC bug), now visited at the NEW URL post-fix and
  // re-detected as connected. Without dedup we'd leave the old declined
  // entry orphaned and create a fresh accepted entry under the new URL —
  // user sees two rows for the same person.
  let acceptedDedup = false;
  let sentDedup = false;
  for (const store of [contacts, accepted, sentInvitations]) {
    const dupUrl = findDuplicateRecord(store, profileUrl, info.memberId);
    if (dupUrl) {
      mergeIntoTarget(store, dupUrl, profileUrl);
      if (store === accepted) acceptedDedup = true;
      if (store === sentInvitations) sentDedup = true;
    }
  }

  const prev = contacts[profileUrl] || {};

  // Preserve contact-info fields across visits — even when the modal isn't
  // open this tick. We only overwrite them via applyContactInfo below.
  const carriedContactFields = {};
  for (const f of CONTACT_FIELDS) {
    if (prev[f] !== undefined) carriedContactFields[f] = prev[f];
  }
  if (prev.contactsCapturedAt) carriedContactFields.contactsCapturedAt = prev.contactsCapturedAt;

  contacts[profileUrl] = {
    profileUrl,
    name: info.name,
    headline: info.headline || prev.headline || '',
    avatar: info.avatar || prev.avatar || '',
    location: info.location || prev.location || '',
    country: info.country || prev.country || '',
    connected: status === 'connected',
    visitedAt: now,
    firstSeenAt: prev.firstSeenAt || now,
    ...carriedContactFields,
    // memberId/vanityName from RSC when available — these enable bulletproof
    // dedup on subsequent visits, even if names don't match or change.
    ...(info.memberId   && { memberId: info.memberId }),
    ...(info.vanityName && { vanityName: info.vanityName }),
    // Mutual-connections deep link + count. Always reflect the freshest visit
    // when present; preserve previous when this tick didn't surface them
    // (mid-render or LinkedIn dropped the widget for some reason).
    mutualsUrl:   info.mutualsUrl   || prev.mutualsUrl   || '',
    mutualsText:  info.mutualsText  || prev.mutualsText  || '',
    mutualsCount: info.mutualsCount != null ? info.mutualsCount : (prev.mutualsCount != null ? prev.mutualsCount : null),
  };
  applyContactInfo(contacts[profileUrl], contactInfo, now);

  let acceptedChanged = acceptedDedup;
  let sentChanged = sentDedup;

  if (status === 'pending') {
    // Pending lives in sentInvitations only. If a stale accepted entry exists
    // (e.g. previously declined or removed, now re-invited), drop it.
    if (accepted[profileUrl]) {
      delete accepted[profileUrl];
      acceptedChanged = true;
    }
    const existing = sentInvitations[profileUrl];
    if (existing) {
      existing.lastSeenAt = now;
      existing.name = info.name || existing.name;
      existing.headline = info.headline || existing.headline;
      existing.avatar = info.avatar || existing.avatar;
    } else {
      sentInvitations[profileUrl] = {
        profileUrl,
        name: info.name,
        headline: info.headline || '',
        avatar: info.avatar || '',
        sentDateRelative: '',
        firstSeenAt: now,
        lastSeenAt: now,
        notes: '',
        tags: [],
        addedFrom: 'profile',
      };
    }
    if (info.memberId   && !sentInvitations[profileUrl].memberId)   sentInvitations[profileUrl].memberId   = info.memberId;
    if (info.vanityName && !sentInvitations[profileUrl].vanityName) sentInvitations[profileUrl].vanityName = info.vanityName;
    applyContactInfo(sentInvitations[profileUrl], contactInfo, now);
    sentChanged = true;
  } else if (status === 'connected') {
    // Promote from sentInvitations if present, else upsert into accepted.
    // Either way, apply any fresh contact-info modal data so the popup
    // sees email/phone/website without needing a separate write path.
    if (sentInvitations[profileUrl]) {
      const sentEntry = sentInvitations[profileUrl];
      const existingAccepted = accepted[profileUrl];
      accepted[profileUrl] = {
        ...sentEntry,
        ...(existingAccepted || {}),
        profileUrl,
        name: info.name || sentEntry.name,
        acceptedAt: existingAccepted?.acceptedAt || now,
        daysPending: Math.floor(((existingAccepted?.acceptedAt || now) - sentEntry.firstSeenAt) / DAY_MS),
        marked: existingAccepted?.marked || false,
        markedAt: existingAccepted?.markedAt || null,
        verified: 'accepted',
        verifiedAt: now,
      };
      delete sentInvitations[profileUrl];
      sentChanged = true;
      acceptedChanged = true;
    } else if (accepted[profileUrl]) {
      const entry = accepted[profileUrl];
      if (entry.verified !== 'accepted') {
        entry.verified = 'accepted';
        entry.verifiedAt = now;
        acceptedChanged = true;
      }
      if (refreshMetadata(entry, info)) acceptedChanged = true;
    } else {
      // Brand-new connection never in our tracking → pre-existing contact.
      accepted[profileUrl] = {
        profileUrl,
        name: info.name,
        headline: info.headline || '',
        avatar: info.avatar || '',
        location: info.location || '',
        country: info.country || '',
        acceptedAt: now,
        daysPending: 0,
        marked: true,
        markedAt: now,
        verified: 'accepted',
        verifiedAt: now,
        autoMarked: true,
      };
      acceptedChanged = true;
    }
    if (info.memberId   && !accepted[profileUrl].memberId)   { accepted[profileUrl].memberId   = info.memberId;   acceptedChanged = true; }
    if (info.vanityName && !accepted[profileUrl].vanityName) { accepted[profileUrl].vanityName = info.vanityName; acceptedChanged = true; }
    if (applyContactInfo(accepted[profileUrl], contactInfo, now)) acceptedChanged = true;
  } else {
    // status === 'not_connected' — should be in neither sentInvitations nor accepted.
    if (sentInvitations[profileUrl]) {
      delete sentInvitations[profileUrl];
      sentChanged = true;
    }
    // Even when status is "not connected", an accepted record may still exist
    // (the entry might be wrongly declined awaiting a re-verify; or the user
    // is on a profile that previously accepted and got removed/declined).
    // Either way, the contact-info modal data the user explicitly opened is
    // valuable — apply it so the popup shows the copy buttons regardless of
    // verified status.
    if (accepted[profileUrl] && applyContactInfo(accepted[profileUrl], contactInfo, now)) {
      acceptedChanged = true;
    }
    const entry = accepted[profileUrl];
    if (entry && entry.verified !== 'declined') {
      // CRITICAL: if entry carries `connectedOnText` it came from the /connections/
      // scan — that page IS the canonical source of truth for "who is connected".
      // A transient false-positive on the profile page (LinkedIn briefly rendering
      // Follow/Connect before settling on Message for a slow load) must not be
      // allowed to downgrade a canonically-confirmed entry. Real disconnections
      // are detected by re-running the /connections/ scan, not by profile visits.
      if (entry.connectedOnText) {
        // No-op: preserve as-is. Stability check already gave us 1.5s, but for
        // slow networks even that's sometimes insufficient and we'd rather
        // err on the side of keeping a real connection's badge intact.
      } else {
        // No canonical proof — verified was upgraded by /sent/ disappearance or
        // a prior profile.js detection (both heuristic). Mark declined; popup
        // surfaces it under the collapsible "Didn't accept" block. We never
        // auto-delete here — surprise removals erode trust more than a stale label.
        entry.verified = 'declined';
        entry.verifiedAt = now;
        refreshMetadata(entry, info);
        acceptedChanged = true;
      }
    }
  }

  return { contacts, accepted, sentInvitations, acceptedChanged, sentChanged };
}

const LITProfileState = { applyProfileVisit, applyContactInfo, CONTACT_FIELDS, DAY_MS };
if (typeof globalThis !== 'undefined') globalThis.LITProfileState = LITProfileState;
if (typeof module !== 'undefined' && module.exports) module.exports = LITProfileState;
