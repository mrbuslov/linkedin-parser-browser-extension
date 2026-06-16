// Pure state-transition function for a single profile visit.
// Caller (profile.js content script) has the raw DOM-scraped `info` and a
// `status` from detectConnectionStatus(). This function applies the "one bucket
// at a time" invariant: each profileUrl lives in EITHER sentInvitations OR
// accepted OR neither (only in contacts) — never both.
//
// Returns the mutated stores plus changed flags so the caller can skip writes
// that didn't touch certain keys (small perf optimization for IndexedDB).

const DAY_MS = 86400000;

// Single source of truth for "metadata fields that flow from info into any
// record we create or update". Keeps sentInvitations / accepted / contacts
// in sync — every store gets the same shape, no field gets silently dropped
// because we forgot to copy it into one specific branch.
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

// Inline merge of recentActivity[] — kept here (not imported from
// activity-parser.js) so profile-state.js remains a standalone module that
// jsdom tests can import without dragging the DOM-scraping parser into Node.
// Dedupe by urnActivityId, sort desc by postedAt, cap at 5.
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

// Apply fresh activity fields onto `target` given `prev` as the previous
// snapshot. Three semantics:
//   - recentActivity → merge (URN dedupe, prefer fresh on collision, cap 5).
//   - lastActivityAt / lastPostAt → keep the LATER of (prev, fresh). The
//     fresh value is the freshest of the 5 currently rendered cards; the
//     stored value is the freshest we've ever seen on this profile. Either
//     could be more recent depending on whether the user posted since.
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

// Refresh field policy: "fresh non-empty value wins, always."
//   - The DOM extractor in profile.js is now deterministic (anchors on
//     stable aria-labels, RSC payload, top-card scope) — when it yields a
//     non-empty value, that's the freshest truth on the live profile.
//     LinkedIn users DO change their photo, headline, location, etc.; we
//     must reflect that, not freeze on the first capture.
//   - The `info.X` truthy guard keeps mid-render empty reads from wiping
//     known-good stored data. Empty stays empty (no overwrite); non-empty
//     and DIFFERENT triggers update.
//   - name is intentionally NOT refreshed here. Identity-level mutations
//     (legal name changes) are rare; mid-render bogus "name" reads are
//     not — keeping name sticky avoids one whole class of corruption. The
//     applyProfileVisit branches still write `info.name` directly into
//     fresh records (sent/accepted creation, contacts rebuild) so a real
//     name change picks up on the next clean tick.
function refreshMetadata(target, info) {
  let changed = false;
  if (info.avatar      && info.avatar   !== target.avatar)        { target.avatar = info.avatar; changed = true; }
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
  applyActivityFields(contacts[profileUrl], prev, info);

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
      // Name: overwrite when fresh non-empty. The extractor is deterministic
      // and won't yield a bogus name; preserving an old (possibly stale or
      // mid-render-corrupted) name on top of fresh truth doesn't help.
      if (info.name) existing.name = info.name;
      refreshMetadata(existing, info);
      applyActivityFields(existing, existing, info);
    } else {
      sentInvitations[profileUrl] = {
        profileUrl,
        name: info.name,
        sentDateRelative: '',
        firstSeenAt: now,
        lastSeenAt: now,
        notes: '',
        tags: [],
        addedFrom: 'profile',
        ...metadataFromInfo(info),
      };
      applyActivityFields(sentInvitations[profileUrl], null, info);
    }
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
        ...metadataFromInfo(info),  // fresh metadata wins over carried-over old fields
        profileUrl,
        name: info.name || sentEntry.name,
        acceptedAt: existingAccepted?.acceptedAt || now,
        daysPending: Math.floor(((existingAccepted?.acceptedAt || now) - sentEntry.firstSeenAt) / DAY_MS),
        marked: existingAccepted?.marked || false,
        markedAt: existingAccepted?.markedAt || null,
        verified: 'accepted',
        verifiedAt: now,
      };
      // Activity: merge against whichever record had the longer history. Prefer
      // existing-accepted (had been a connection before, then re-invited), else
      // the sent-entry's stored activity (captured during pending phase).
      applyActivityFields(accepted[profileUrl], existingAccepted || sentEntry, info);
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
      const prevActivityLA = entry.lastActivityAt;
      const prevActivityList = entry.recentActivity;
      applyActivityFields(entry, entry, info);
      if (entry.lastActivityAt !== prevActivityLA || entry.recentActivity !== prevActivityList) {
        acceptedChanged = true;
      }
    } else {
      // Brand-new connection never in our tracking. Two real scenarios fall
      // through here:
      //   1. Pre-existing contact (was in your network before you installed
      //      the extension) — you visit them once, we discover them.
      //   2. Fresh acceptance whose pending phase we missed — you invited
      //      via /mynetwork/ or /search/ without visiting the profile, OR
      //      the pre-1.2.3 pending detector failed on this profile (class
      //      names rotated → "Kimberly bug"). Person accepted, you now
      //      visit their profile; we see "connected" with no history.
      //
      // We CANNOT reliably distinguish (1) from (2) from the DOM alone. The
      // old behavior auto-marked all of these, which silently buried fresh
      // acceptances in the Marked tab. Now we land them in Accepted with
      // marked=false. Users with pre-1.x install state can tap "Mark all"
      // once to clear the legacy backlog.
      accepted[profileUrl] = {
        profileUrl,
        name: info.name,
        acceptedAt: now,
        daysPending: 0,
        marked: false,
        markedAt: null,
        verified: 'accepted',
        verifiedAt: now,
        ...metadataFromInfo(info),
      };
      applyActivityFields(accepted[profileUrl], null, info);
      acceptedChanged = true;
    }
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

const LITProfileState = {
  applyProfileVisit,
  applyContactInfo,
  applyActivityFields,
  mergeRecentActivityInline,
  CONTACT_FIELDS,
  DAY_MS,
};
if (typeof globalThis !== 'undefined') globalThis.LITProfileState = LITProfileState;
if (typeof module !== 'undefined' && module.exports) module.exports = LITProfileState;
