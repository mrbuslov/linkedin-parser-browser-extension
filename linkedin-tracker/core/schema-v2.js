// Schema v2 — unified `contacts` store with a per-entry `status` field.
//
// v1 kept THREE separate top-level IDB keys:
//   sentInvitations[url] → invitation in flight
//   accepted[url]        → connection or declined (via verified: string)
//   contacts[url]        → any visited profile (may or may not appear in the above)
//
// v2 keeps ONE:
//   contacts[url] → { status, ...same fields as before but merged }
//
// Where `status` is one of:
//   'pending'  — invite sent, not yet accepted (was sentInvitations[url])
//   'accepted' — 1st-degree connection (was accepted[url] with verified='accepted')
//   'declined' — invite withdrawn/rejected OR post-connection disconnect
//                (was accepted[url] with verified='declined')
//   'visited'  — we saw this profile but never invited and it's not a connection
//                (was contacts[url] with no matching pending/accepted entry)
//
// The rewrite is a one-time storage migration: on the first popup open
// after upgrade, `migrateToV2()` builds the unified dict from the three
// legacy stores, snapshots the pre-migration state into `_backup_v1` as
// a safety net, and writes `schemaVersion: 2` so subsequent loads know
// the storage is already upgraded.
//
// Import path (JSON backup restore) detects v1 payloads by the presence of
// legacy top-level keys (`sentInvitations` / `accepted`) or explicit
// `version === 1` on the wrapper, runs the same migration in-memory, and
// writes the resulting v2 shape.
//
// Wrapped in IIFE — content_scripts, popup <script> tags, AND SW
// importScripts ALL share the same script scope within their context.
// Multiple core/* files with the same top-level `const STATUS` will
// collide with "Identifier already declared" and take the whole bundle
// down. IIFE keeps STATUS local to this file; the public API is only
// exposed via the LITSchema global at the end.

(function () {

const STATUS = Object.freeze({
  PENDING:  'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  VISITED:  'visited',
});

const ALL_STATUSES = Object.freeze([
  STATUS.PENDING, STATUS.ACCEPTED, STATUS.DECLINED, STATUS.VISITED,
]);

// Fields we DROP during migration. `connected` was a boolean synthesized
// from status; `verified` string is now status itself; `autoMarked` was
// killed in 1.2.5 (project rule: no auto-marking on brand-new visits).
const DROPPED_FIELDS = Object.freeze(['connected', 'verified', 'autoMarked']);

// Given a v1 accepted-store entry, decide the new status.
function statusFromLegacyAccepted(rec) {
  if (rec.verified === 'declined') return STATUS.DECLINED;
  // 'accepted', null, or missing → treat as accepted. Pre-1.2.2 records
  // that hit the accepted store without a `verified` set were the result
  // of a /sent/ disappearance which we optimistically treated as accepted;
  // the safest migration keeps that assumption.
  return STATUS.ACCEPTED;
}

// Return true when the currently-stored payload is v2 (unified). We check
// BOTH the version marker AND the shape as a defense against half-written
// state (e.g., a previous migration crash).
function isV2(stored) {
  if (!stored) return false;
  if (stored.schemaVersion === 2) return true;
  // Absent version but has the v2 signature (contacts present and no
  // sentInvitations/accepted OR both are empty). We trust schemaVersion
  // as the primary signal; this is only a fallback.
  return false;
}

// Merge two records for the same profileUrl. Called during migration when
// the same URL appears in multiple legacy stores. Precedence:
//   1) Fields that describe LATEST STATE (status, verifiedAt, declinedAt,
//      marked, favorite, contactsCapturedAt) win by source-priority:
//      accepted > sentInvitations > contacts.
//   2) HISTORY fields (firstSeenAt, acceptedAt): take the EARLIEST value
//      that's set — we want the true "when we first saw them" not the
//      most-recent-store's copy.
//   3) All other fields: take fresh non-empty over stored empty.
function mergeRecords(base, incoming, incomingSource) {
  const out = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (DROPPED_FIELDS.includes(k)) continue;
    if (k === 'firstSeenAt' || k === 'acceptedAt') {
      // Earliest wins
      if (v && (!out[k] || v < out[k])) out[k] = v;
      continue;
    }
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v === '') continue;
    // Empty array is intentional emptiness — but we only overwrite if
    // there's nothing there already.
    if (Array.isArray(v) && v.length === 0 && Array.isArray(out[k]) && out[k].length > 0) {
      continue;
    }
    out[k] = v;
  }
  if (incomingSource) out._migratedFrom = out._migratedFrom || [];
  if (incomingSource && !out._migratedFrom.includes(incomingSource)) {
    out._migratedFrom.push(incomingSource);
  }
  return out;
}

// Strip DROPPED_FIELDS off a record and stamp `status`. Returns a fresh
// object; does not mutate the input.
function normalize(rec, status) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (DROPPED_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  out.status = status;
  // Preserve declinedAt only when status is declined; otherwise drop any
  // legacy stale copy that snuck in from a previous downgrade path.
  if (status !== STATUS.DECLINED) delete out.declinedAt;
  return out;
}

// Cross-URL dedup by memberId. When two URLs in the unified dict refer to
// the same person, keep ONE URL (accepted-status wins; else pending; else
// whichever has the later visitedAt) and merge the other's fields in.
// This mirrors the pre-v2 findDuplicateRecord logic from profile-state.
function dedupeByMemberId(dict) {
  const byMember = new Map();
  const drop = [];
  for (const [url, rec] of Object.entries(dict)) {
    if (!rec.memberId) continue;
    const prev = byMember.get(rec.memberId);
    if (!prev) {
      byMember.set(rec.memberId, url);
      continue;
    }
    const prevRec = dict[prev];
    // Pick winner by status priority then by visitedAt recency.
    const rank = (r) => (
      r.status === STATUS.ACCEPTED ? 3
      : r.status === STATUS.PENDING ? 2
      : r.status === STATUS.DECLINED ? 1
      : 0
    );
    const winnerUrl = rank(rec) > rank(prevRec) ? url
                    : rank(rec) < rank(prevRec) ? prev
                    : (rec.visitedAt || 0) > (prevRec.visitedAt || 0) ? url : prev;
    const loserUrl = winnerUrl === url ? prev : url;
    // Merge loser fields into winner; loser's firstSeenAt often wins
    // (earliest history), so mergeRecords handles that. Winner's status
    // is preserved explicitly — mergeRecords otherwise treats status as
    // any other string and lets the loser's value override.
    const winnerStatus = dict[winnerUrl].status;
    dict[winnerUrl] = mergeRecords(dict[winnerUrl], dict[loserUrl], '_dedup_by_memberId');
    dict[winnerUrl].status = winnerStatus;
    if (winnerStatus !== STATUS.DECLINED) delete dict[winnerUrl].declinedAt;
    // Preserve the loser URL as an alias-history marker so the popup
    // could surface "also known as" if we ever want to. Not critical.
    dict[winnerUrl]._priorUrls = dict[winnerUrl]._priorUrls || [];
    if (!dict[winnerUrl]._priorUrls.includes(loserUrl)) {
      dict[winnerUrl]._priorUrls.push(loserUrl);
    }
    drop.push(loserUrl);
    byMember.set(rec.memberId, winnerUrl);
  }
  for (const url of drop) delete dict[url];
}

// Build the unified `contacts` v2 dict from v1's three-store shape.
// Pure function — no IDB, no side effects. Returns the new dict.
function buildUnifiedContacts(v1) {
  const sent   = v1.sentInvitations || {};
  const accept = v1.accepted        || {};
  const legacy = v1.contacts        || {};
  const out = {};

  // Order matters: we walk from LOWEST priority to HIGHEST so that later
  // writes cleanly overwrite. Precedence: accepted > sentInvitations > contacts.
  for (const [url, rec] of Object.entries(legacy)) {
    out[url] = normalize(rec, STATUS.VISITED);
    out[url]._migratedFrom = ['contacts'];
  }
  for (const [url, rec] of Object.entries(sent)) {
    const normalized = normalize(rec, STATUS.PENDING);
    normalized._migratedFrom = ['sentInvitations'];
    if (out[url]) {
      // Merge existing (from contacts) with sent — sent wins (higher priority),
      // but earlier firstSeenAt from contacts is preserved by mergeRecords.
      out[url] = mergeRecords(out[url], normalized, 'sentInvitations');
      out[url].status = STATUS.PENDING;
    } else {
      out[url] = normalized;
    }
  }
  for (const [url, rec] of Object.entries(accept)) {
    const status = statusFromLegacyAccepted(rec);
    const normalized = normalize(rec, status);
    normalized._migratedFrom = ['accepted'];
    // Preserve declinedAt off legacy verifiedAt for declined entries.
    if (status === STATUS.DECLINED && rec.verifiedAt && !normalized.declinedAt) {
      normalized.declinedAt = rec.verifiedAt;
    }
    if (out[url]) {
      out[url] = mergeRecords(out[url], normalized, 'accepted');
      out[url].status = status;
      if (status === STATUS.DECLINED && rec.verifiedAt && !out[url].declinedAt) {
        out[url].declinedAt = rec.verifiedAt;
      }
      if (status !== STATUS.DECLINED) delete out[url].declinedAt;
    } else {
      out[url] = normalized;
    }
  }

  dedupeByMemberId(out);
  return out;
}

// Apply the migration to a full stored-state snapshot (as returned by
// dbGet(null)). Idempotent: if `stored.schemaVersion === 2` already, we
// return the input unchanged. Otherwise we produce a NEW stored shape
// with:
//   - `contacts` — unified v2 dict
//   - `schemaVersion: 2`
//   - `_backup_v1` — snapshot of pre-migration state for disaster recovery
//   - `sentInvitations` and `accepted` ABSENT (callers must delete these
//     IDB keys separately — see LEGACY_STORE_KEYS)
//   - all OTHER top-level keys (scanHistory, scanState, scanInProgress,
//     settings) passed through unchanged
function migrateToV2(stored) {
  if (isV2(stored)) return stored;

  const backup = {
    sentInvitations: stored.sentInvitations || {},
    accepted:        stored.accepted        || {},
    contacts:        stored.contacts        || {},
    _migratedAt:     null, // filled by caller when Date.now() is available
  };

  const unified = buildUnifiedContacts(stored);

  const out = { ...stored };
  out.contacts = unified;
  out.schemaVersion = 2;
  out._backup_v1 = backup;
  delete out.sentInvitations;
  delete out.accepted;
  return out;
}

// The v1 top-level IDB keys that are gone in v2. Callers use this to
// physically delete them from IDB after writing the migrated state — a
// dbSet cannot remove keys, only overwrite, so leaving them out of
// migrateToV2's return is not enough on its own.
const LEGACY_STORE_KEYS = Object.freeze(['sentInvitations', 'accepted']);

// Detect whether an imported JSON backup is v1-shaped. Used by the import
// path so we can run the same migration on incoming data before writing.
// Two signals:
//   - Explicit `version: 1` on the payload wrapper
//   - Presence of legacy top-level keys (`sentInvitations` or `accepted`)
//     in the `data` object even if version marker is missing
function isLegacyPayload(payload) {
  if (!payload) return false;
  // Storage marker beats wrapper version — a v2 storage that got wrapped
  // by an old export tool with version:1 is still v2 at rest.
  if (payload.data && payload.data.schemaVersion === 2) return false;
  if (payload.version === 1) return true;
  if (!payload.data) return false;
  if (payload.data.sentInvitations || payload.data.accepted) return true;
  return false;
}

const LITSchema = {
  STATUS,
  ALL_STATUSES,
  DROPPED_FIELDS,
  LEGACY_STORE_KEYS,
  migrateToV2,
  buildUnifiedContacts,
  isV2,
  isLegacyPayload,
  statusFromLegacyAccepted,
  normalize,
  mergeRecords,
  dedupeByMemberId,
};
if (typeof globalThis !== 'undefined') globalThis.LITSchema = LITSchema;
if (typeof module !== 'undefined' && module.exports) module.exports = LITSchema;

})();
