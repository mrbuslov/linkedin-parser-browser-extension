// Pure state-transition function for a single profile visit.
// Caller (profile.js content script) has the raw DOM-scraped `info` and a
// `status` from detectConnectionStatus(). This function applies the "one bucket
// at a time" invariant: each profileUrl lives in EITHER sentInvitations OR
// accepted OR neither (only in contacts) — never both.
//
// Returns the mutated stores plus changed flags so the caller can skip writes
// that didn't touch certain keys (small perf optimization for IndexedDB).

const DAY_MS = 86400000;
const MINUTE_MS = 60000;

// Grace period after a fresh verification: if `verifiedAt` is within the last
// five minutes, we don't honor a `not_connected` detection on that entry.
// This protects against transient mid-page-load false positives — LinkedIn's
// top card sometimes renders Follow/Connect briefly before settling on Message
// for an existing connection.
const VERIFY_GRACE_MS = 5 * MINUTE_MS;

function refreshMetadata(target, info) {
  let changed = false;
  if (info.avatar   && !target.avatar)   { target.avatar = info.avatar; changed = true; }
  if (info.headline && !target.headline) { target.headline = info.headline; changed = true; }
  if (info.location && !target.location) { target.location = info.location; changed = true; }
  if (info.country  && !target.country)  { target.country = info.country; changed = true; }
  return changed;
}

function applyProfileVisit(stored, info, status, now) {
  const contacts = { ...(stored.contacts || {}) };
  const accepted = { ...(stored.accepted || {}) };
  const sentInvitations = { ...(stored.sentInvitations || {}) };
  const profileUrl = info.profileUrl;
  const prev = contacts[profileUrl] || {};

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
  };

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
    sentChanged = true;
  } else if (status === 'connected') {
    // Promote from sentInvitations if present, else upsert into accepted.
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
  } else {
    // status === 'not_connected' — should be in neither sentInvitations nor accepted.
    if (sentInvitations[profileUrl]) {
      delete sentInvitations[profileUrl];
      sentChanged = true;
    }
    const entry = accepted[profileUrl];
    if (entry) {
      // Don't act on a freshly-verified entry — LinkedIn's profile DOM can
      // briefly render Follow/Connect on top-card before settling on Message,
      // and we'd otherwise nuke an entry we just confirmed seconds ago.
      const recentlyVerified = entry.verifiedAt && (now - entry.verifiedAt) < VERIFY_GRACE_MS;
      if (recentlyVerified) {
        // Caller can still surface this via contacts; we just refuse to touch
        // the accepted bucket inside the grace window.
      } else if (entry.verified === 'accepted' || entry.autoMarked) {
        // Ever confirmed accepted → user removed the connection → DELETE.
        // Marking "declined" would imply they rejected our invite, not the case.
        // Also drop autoMarked entries — those were never real.
        delete accepted[profileUrl];
        acceptedChanged = true;
      } else if (entry.verified !== 'declined') {
        entry.verified = 'declined';
        entry.verifiedAt = now;
        refreshMetadata(entry, info);
        acceptedChanged = true;
      }
    }
  }

  return { contacts, accepted, sentInvitations, acceptedChanged, sentChanged };
}

const LITProfileState = { applyProfileVisit, DAY_MS };
if (typeof globalThis !== 'undefined') globalThis.LITProfileState = LITProfileState;
if (typeof module !== 'undefined' && module.exports) module.exports = LITProfileState;
