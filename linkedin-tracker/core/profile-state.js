// Pure state-transition function for a single profile visit.
// Caller (profile.js content script) has the raw DOM-scraped `info` and a
// `status` from detectConnectionStatus(). This function applies the "one bucket
// at a time" invariant: each profileUrl lives in EITHER sentInvitations OR
// accepted OR neither (only in contacts) — never both.
//
// Returns the mutated stores plus changed flags so the caller can skip writes
// that didn't touch certain keys (small perf optimization for IndexedDB).

const DAY_MS = 86400000;

function refreshMetadata(target, info) {
  let changed = false;
  if (info.avatar   && !target.avatar)   { target.avatar = info.avatar; changed = true; }
  if (info.headline && !target.headline) { target.headline = info.headline; changed = true; }
  if (info.location && !target.location) { target.location = info.location; changed = true; }
  if (info.country  && !target.country)  { target.country = info.country; changed = true; }
  return changed;
}

const CONTACT_FIELDS = [
  'email', 'phone', 'phoneLabel',
  'website', 'websiteLabel', 'extraWebsites',
  'address', 'birthday', 'connectedSinceText',
];

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
  };
  applyContactInfo(contacts[profileUrl], contactInfo, now);

  let acceptedChanged = false;
  let sentChanged = false;

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
