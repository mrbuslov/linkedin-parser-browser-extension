import { describe, it, expect } from 'vitest';
const {
  STATUS,
  migrateToV2,
  buildUnifiedContacts,
  isV2,
  isLegacyPayload,
  mergeRecords,
  normalize,
} = require('../linkedin-tracker/core/schema-v2.js');

const NOW = 1717200000000; // 2024-06-01T00:00:00Z
const DAY = 86_400_000;

// A trimmed v1 shape helper for tests. Every legacy entry is populated
// with the fields the migration must preserve — this catches "we forgot
// to copy X during merge" bugs.
function v1(overrides = {}) {
  return {
    sentInvitations: {},
    accepted:        {},
    contacts:        {},
    scanHistory:     [],
    scanState:       {},
    ...overrides,
  };
}

// A common sent-page record shape from the pre-v2 codebase.
function sentRec(url, extras = {}) {
  return {
    profileUrl: url,
    name: 'Alice Doe',
    headline: 'Engineer',
    avatar: 'https://media.licdn.com/x.jpg',
    firstSeenAt: NOW - 10 * DAY,
    lastSeenAt:  NOW - 3 * DAY,
    sentDateRelative: '2 weeks ago',
    addedFrom: 'sent-page',
    ...extras,
  };
}

function acceptedRec(url, extras = {}) {
  return {
    profileUrl: url,
    name: 'Alice Doe',
    headline: 'Engineer',
    avatar: 'https://media.licdn.com/x.jpg',
    firstSeenAt: NOW - 20 * DAY,
    acceptedAt: NOW - 5 * DAY,
    daysPending: 15,
    verified: 'accepted',
    verifiedAt: NOW - 5 * DAY,
    marked: false,
    markedAt: null,
    connected: true, // dropped by migration
    ...extras,
  };
}

function contactRec(url, extras = {}) {
  return {
    profileUrl: url,
    name: 'Alice Doe',
    headline: 'Engineer',
    avatar: 'https://media.licdn.com/x.jpg',
    firstSeenAt: NOW - 15 * DAY,
    visitedAt:   NOW - 1 * DAY,
    connected: false, // dropped
    ...extras,
  };
}

describe('isV2 / isLegacyPayload — detection', () => {
  it('isV2 true when schemaVersion:2 is set', () => {
    expect(isV2({ schemaVersion: 2, contacts: {} })).toBe(true);
  });
  it('isV2 false when schemaVersion missing (defense against half-written state)', () => {
    expect(isV2({ contacts: {} })).toBe(false);
  });
  it('isV2 false for legacy shape', () => {
    expect(isV2({ sentInvitations: {}, accepted: {}, contacts: {} })).toBe(false);
  });
  it('isV2 false for empty input', () => {
    expect(isV2({})).toBe(false);
    expect(isV2(null)).toBe(false);
  });

  it('isLegacyPayload true when wrapper version is 1', () => {
    expect(isLegacyPayload({ version: 1, data: { contacts: {} } })).toBe(true);
  });
  it('isLegacyPayload true when data has sentInvitations top-level', () => {
    expect(isLegacyPayload({ version: 999, data: { sentInvitations: {} } })).toBe(true);
  });
  it('isLegacyPayload true when data has accepted top-level', () => {
    expect(isLegacyPayload({ data: { accepted: {} } })).toBe(true);
  });
  it('isLegacyPayload false when data.schemaVersion is 2', () => {
    expect(isLegacyPayload({ version: 1, data: { schemaVersion: 2, contacts: {} } })).toBe(false);
  });
  it('isLegacyPayload false for empty / null', () => {
    expect(isLegacyPayload(null)).toBe(false);
    expect(isLegacyPayload({})).toBe(false);
  });
});

describe('normalize — strips dropped fields, stamps status', () => {
  it('drops connected, verified, autoMarked', () => {
    const out = normalize({ name: 'x', connected: true, verified: 'accepted', autoMarked: true }, STATUS.ACCEPTED);
    expect(out.connected).toBeUndefined();
    expect(out.verified).toBeUndefined();
    expect(out.autoMarked).toBeUndefined();
    expect(out.status).toBe(STATUS.ACCEPTED);
    expect(out.name).toBe('x');
  });
  it('drops declinedAt when status is not declined', () => {
    const out = normalize({ declinedAt: 12345 }, STATUS.ACCEPTED);
    expect(out.declinedAt).toBeUndefined();
  });
  it('preserves declinedAt when status is declined', () => {
    const out = normalize({ declinedAt: 12345 }, STATUS.DECLINED);
    expect(out.declinedAt).toBe(12345);
  });
});

describe('mergeRecords — merge semantics', () => {
  it('earliest firstSeenAt wins', () => {
    const base = { firstSeenAt: NOW };
    const incoming = { firstSeenAt: NOW - 10 * DAY };
    const merged = mergeRecords(base, incoming, 'accepted');
    expect(merged.firstSeenAt).toBe(NOW - 10 * DAY);
  });
  it('earliest acceptedAt wins', () => {
    const base = { acceptedAt: NOW };
    const incoming = { acceptedAt: NOW - 5 * DAY };
    const merged = mergeRecords(base, incoming, 'accepted');
    expect(merged.acceptedAt).toBe(NOW - 5 * DAY);
  });
  it('drops legacy fields even when passed through mergeRecords', () => {
    const base = { name: 'x' };
    const incoming = { connected: true, verified: 'accepted' };
    const merged = mergeRecords(base, incoming, 'accepted');
    expect(merged.connected).toBeUndefined();
    expect(merged.verified).toBeUndefined();
  });
  it('skips empty string overrides (does not wipe stored non-empty)', () => {
    const base = { headline: 'Real headline' };
    const incoming = { headline: '' };
    const merged = mergeRecords(base, incoming, 'x');
    expect(merged.headline).toBe('Real headline');
  });
  it('appends _migratedFrom source for provenance', () => {
    const merged = mergeRecords({}, { name: 'x' }, 'sentInvitations');
    expect(merged._migratedFrom).toContain('sentInvitations');
  });
});

describe('buildUnifiedContacts — single-source migrations', () => {
  it('empty v1 → empty v2 contacts', () => {
    expect(buildUnifiedContacts(v1())).toEqual({});
  });

  it('only sentInvitations → all become status=pending', () => {
    const stored = v1({ sentInvitations: { 'a': sentRec('a'), 'b': sentRec('b') } });
    const out = buildUnifiedContacts(stored);
    expect(Object.keys(out)).toEqual(['a', 'b']);
    expect(out.a.status).toBe(STATUS.PENDING);
    expect(out.b.status).toBe(STATUS.PENDING);
    expect(out.a.sentDateRelative).toBe('2 weeks ago');  // preserved
    expect(out.a.firstSeenAt).toBe(NOW - 10 * DAY);      // preserved
  });

  it('only accepted (verified=accepted) → status=accepted', () => {
    const stored = v1({ accepted: { 'a': acceptedRec('a') } });
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.ACCEPTED);
    expect(out.a.verified).toBeUndefined();
    expect(out.a.connected).toBeUndefined();
    expect(out.a.acceptedAt).toBe(NOW - 5 * DAY);
    expect(out.a.declinedAt).toBeUndefined();
  });

  it('only accepted (verified=declined) → status=declined + declinedAt = verifiedAt', () => {
    const stored = v1({ accepted: {
      'a': acceptedRec('a', { verified: 'declined', verifiedAt: NOW - 2 * DAY })
    }});
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.DECLINED);
    expect(out.a.declinedAt).toBe(NOW - 2 * DAY);
  });

  it('only accepted (verified=null legacy) → default status=accepted', () => {
    const stored = v1({ accepted: {
      'a': acceptedRec('a', { verified: null })
    }});
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.ACCEPTED);
  });

  it('only contacts (never in tracking) → status=visited', () => {
    const stored = v1({ contacts: { 'a': contactRec('a') } });
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.VISITED);
    expect(out.a.visitedAt).toBe(NOW - 1 * DAY);
  });

  it('dropped fields never appear on the output (connected, verified, autoMarked)', () => {
    const stored = v1({ accepted: {
      'a': acceptedRec('a', { autoMarked: true, connected: true, verified: 'accepted' })
    }});
    const out = buildUnifiedContacts(stored);
    expect(out.a.connected).toBeUndefined();
    expect(out.a.verified).toBeUndefined();
    expect(out.a.autoMarked).toBeUndefined();
  });
});

describe('buildUnifiedContacts — cross-store same URL merges', () => {
  it('URL in accepted AND contacts: accepted status wins, contacts firstSeenAt preserved if earlier', () => {
    const stored = v1({
      contacts: { 'a': contactRec('a', { firstSeenAt: NOW - 30 * DAY }) },
      accepted: { 'a': acceptedRec('a', { firstSeenAt: NOW - 5 * DAY }) },
    });
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.ACCEPTED);
    expect(out.a.firstSeenAt).toBe(NOW - 30 * DAY);
  });

  it('URL in sentInvitations AND contacts: pending wins, contacts headline preserved if sent has none', () => {
    const stored = v1({
      contacts: { 'a': contactRec('a', { headline: 'Actual real headline' }) },
      sentInvitations: { 'a': sentRec('a', { headline: '' }) },
    });
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.PENDING);
    expect(out.a.headline).toBe('Actual real headline');
  });

  it('URL in ALL THREE: accepted wins for status; historical fields merged', () => {
    const stored = v1({
      contacts: { 'a': contactRec('a', {
        firstSeenAt: NOW - 30 * DAY,
        email: 'x@y.com',
      }) },
      sentInvitations: { 'a': sentRec('a', { firstSeenAt: NOW - 20 * DAY }) },
      accepted: { 'a': acceptedRec('a', { firstSeenAt: NOW - 10 * DAY }) },
    });
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.ACCEPTED);
    expect(out.a.firstSeenAt).toBe(NOW - 30 * DAY);
    expect(out.a.email).toBe('x@y.com');
  });

  it('URL declined in accepted + also in contacts: status=declined, contactsCapturedAt kept', () => {
    const stored = v1({
      contacts: { 'a': contactRec('a', { contactsCapturedAt: NOW - 20 * DAY }) },
      accepted: { 'a': acceptedRec('a', { verified: 'declined', verifiedAt: NOW - 3 * DAY }) },
    });
    const out = buildUnifiedContacts(stored);
    expect(out.a.status).toBe(STATUS.DECLINED);
    expect(out.a.declinedAt).toBe(NOW - 3 * DAY);
    expect(out.a.contactsCapturedAt).toBe(NOW - 20 * DAY);
  });
});

describe('buildUnifiedContacts — cross-URL dedup by memberId', () => {
  it('same memberId under two URLs: accepted-status URL wins; loser dropped; firstSeenAt earliest', () => {
    const stored = v1({
      sentInvitations: {
        'https://www.linkedin.com/in/oldname/': sentRec('https://www.linkedin.com/in/oldname/', {
          memberId: 'ABC123',
          firstSeenAt: NOW - 30 * DAY,
        }),
      },
      accepted: {
        'https://www.linkedin.com/in/newname/': acceptedRec('https://www.linkedin.com/in/newname/', {
          memberId: 'ABC123',
          firstSeenAt: NOW - 10 * DAY,
        }),
      },
    });
    const out = buildUnifiedContacts(stored);
    expect(Object.keys(out)).toEqual(['https://www.linkedin.com/in/newname/']);
    expect(out['https://www.linkedin.com/in/newname/'].status).toBe(STATUS.ACCEPTED);
    expect(out['https://www.linkedin.com/in/newname/'].firstSeenAt).toBe(NOW - 30 * DAY);
    expect(out['https://www.linkedin.com/in/newname/']._priorUrls)
      .toContain('https://www.linkedin.com/in/oldname/');
  });

  it('no memberId → no dedup, both entries preserved', () => {
    const stored = v1({
      contacts: {
        'a': contactRec('a'),  // no memberId
        'b': contactRec('b'),
      },
    });
    const out = buildUnifiedContacts(stored);
    expect(Object.keys(out).sort()).toEqual(['a', 'b']);
  });

  it('same memberId, both visited: keeps the one with the later visitedAt', () => {
    const stored = v1({
      contacts: {
        'a': contactRec('a', { memberId: 'M1', visitedAt: NOW - 10 * DAY }),
        'b': contactRec('b', { memberId: 'M1', visitedAt: NOW - 2 * DAY }),
      },
    });
    const out = buildUnifiedContacts(stored);
    expect(Object.keys(out)).toEqual(['b']);
  });
});

describe('migrateToV2 — end-to-end wrapper', () => {
  it('populates schemaVersion=2 and preserves scanHistory/scanState/settings pass-through', () => {
    const stored = v1({
      scanHistory: [{ ts: 1, count: 5 }],
      scanState: { sent: { lastAt: 42 } },
      settings: { autoCaptureProfiles: true },
    });
    const out = migrateToV2(stored);
    expect(out.schemaVersion).toBe(2);
    expect(out.scanHistory).toEqual([{ ts: 1, count: 5 }]);
    expect(out.scanState).toEqual({ sent: { lastAt: 42 } });
    expect(out.settings).toEqual({ autoCaptureProfiles: true });
  });

  it('creates _backup_v1 snapshot of the pre-migration state', () => {
    const stored = v1({
      sentInvitations: { 'a': sentRec('a') },
      accepted: { 'b': acceptedRec('b') },
      contacts: { 'c': contactRec('c') },
    });
    const out = migrateToV2(stored);
    expect(out._backup_v1).toBeDefined();
    expect(out._backup_v1.sentInvitations).toEqual({ 'a': sentRec('a') });
    expect(out._backup_v1.accepted).toEqual({ 'b': acceptedRec('b') });
    expect(out._backup_v1.contacts).toEqual({ 'c': contactRec('c') });
  });

  it('clears sentInvitations and accepted keys to empty objects post-migration', () => {
    const stored = v1({
      sentInvitations: { 'a': sentRec('a') },
      accepted: { 'b': acceptedRec('b') },
    });
    const out = migrateToV2(stored);
    expect(out.sentInvitations).toEqual({});
    expect(out.accepted).toEqual({});
  });

  it('idempotent: v2 input returns unchanged (no double-backup)', () => {
    const v2 = { schemaVersion: 2, contacts: { 'a': { status: 'pending' } } };
    const out = migrateToV2(v2);
    expect(out).toBe(v2);
    expect(out._backup_v1).toBeUndefined();
  });

  it('merges all three legacy stores into unified contacts', () => {
    const stored = v1({
      sentInvitations: { 'p': sentRec('p') },
      accepted:        { 'a': acceptedRec('a') },
      contacts:        { 'v': contactRec('v') },
    });
    const out = migrateToV2(stored);
    expect(Object.keys(out.contacts).sort()).toEqual(['a', 'p', 'v']);
    expect(out.contacts.p.status).toBe(STATUS.PENDING);
    expect(out.contacts.a.status).toBe(STATUS.ACCEPTED);
    expect(out.contacts.v.status).toBe(STATUS.VISITED);
  });
});

describe('migrateToV2 — real-world edge cases', () => {
  it('preserves marked+markedAt on accepted → after migration still marked with correct timestamp', () => {
    const stored = v1({
      accepted: { 'a': acceptedRec('a', { marked: true, markedAt: NOW - 4 * DAY }) },
    });
    const out = migrateToV2(stored);
    expect(out.contacts.a.marked).toBe(true);
    expect(out.contacts.a.markedAt).toBe(NOW - 4 * DAY);
  });

  it('preserves favorite+favoritedAt across migration', () => {
    const stored = v1({
      accepted: { 'a': acceptedRec('a', { favorite: true, favoritedAt: NOW - 2 * DAY }) },
    });
    const out = migrateToV2(stored);
    expect(out.contacts.a.favorite).toBe(true);
    expect(out.contacts.a.favoritedAt).toBe(NOW - 2 * DAY);
  });

  it('preserves withdrawnAt (needed by diff-sent 7-day rule)', () => {
    const stored = v1({
      sentInvitations: { 'a': sentRec('a', { withdrawnAt: NOW - 3 * DAY }) },
    });
    const out = migrateToV2(stored);
    expect(out.contacts.a.withdrawnAt).toBe(NOW - 3 * DAY);
    expect(out.contacts.a.status).toBe(STATUS.PENDING);
  });

  it('preserves connectedOnText / connectedOnDate (canonical-proof anti-downgrade guard)', () => {
    const stored = v1({
      accepted: { 'a': acceptedRec('a', {
        connectedOnText: 'Connected on Jan 15, 2024',
        connectedOnDate: '2024-01-15',
      }) },
    });
    const out = migrateToV2(stored);
    expect(out.contacts.a.connectedOnText).toBe('Connected on Jan 15, 2024');
    expect(out.contacts.a.connectedOnDate).toBe('2024-01-15');
  });

  it('preserves contact-info modal fields (email, phone, website, address, birthday)', () => {
    const stored = v1({
      contacts: { 'a': contactRec('a', {
        email: 'foo@bar.com',
        phone: '+123', phoneLabel: 'work',
        website: 'https://x.com', websiteLabel: 'blog',
        address: '123 Main St', birthday: 'Jan 15',
        connectedSinceText: 'Connected March 2020',
        contactsCapturedAt: NOW - 5 * DAY,
      }) },
    });
    const out = migrateToV2(stored);
    expect(out.contacts.a.email).toBe('foo@bar.com');
    expect(out.contacts.a.phone).toBe('+123');
    expect(out.contacts.a.website).toBe('https://x.com');
    expect(out.contacts.a.address).toBe('123 Main St');
    expect(out.contacts.a.birthday).toBe('Jan 15');
    expect(out.contacts.a.connectedSinceText).toBe('Connected March 2020');
    expect(out.contacts.a.contactsCapturedAt).toBe(NOW - 5 * DAY);
  });

  it('preserves recentActivity + lastActivityAt + lastPostAt (Activity capture from 1.2.5)', () => {
    const activity = {
      lastActivityAt: '2024-05-01T12:00:00Z',
      lastPostAt:     '2024-05-01T12:00:00Z',
      recentActivity: [{ urnActivityId: '1', postedAt: '2024-05-01T12:00:00Z' }],
    };
    const stored = v1({ accepted: { 'a': acceptedRec('a', activity) } });
    const out = migrateToV2(stored);
    expect(out.contacts.a.lastActivityAt).toBe(activity.lastActivityAt);
    expect(out.contacts.a.recentActivity).toEqual(activity.recentActivity);
  });

  it('preserves mutualsCollected + mutualsCollectedAt (search-mutuals capture)', () => {
    const mutuals = {
      mutualsUrl: 'https://x.com/search?connectionOf=ABC',
      mutualsText: 'Alice and 5 others',
      mutualsCount: 6,
      mutualsCollected: [{ name: 'Alice', profileUrl: 'https://x/alice/' }],
      mutualsCollectedAt: NOW - 1 * DAY,
    };
    const stored = v1({ accepted: { 'a': acceptedRec('a', mutuals) } });
    const out = migrateToV2(stored);
    expect(out.contacts.a.mutualsCount).toBe(6);
    expect(out.contacts.a.mutualsCollected).toHaveLength(1);
  });

  it('preserves notes + tags (user-authored data must never be lost)', () => {
    const stored = v1({
      sentInvitations: { 'a': sentRec('a', {
        notes: 'Met at conf. Follow up in 2 weeks.',
        tags: ['recruiter', 'stripe'],
      }) },
    });
    const out = migrateToV2(stored);
    expect(out.contacts.a.notes).toBe('Met at conf. Follow up in 2 weeks.');
    expect(out.contacts.a.tags).toEqual(['recruiter', 'stripe']);
  });

  it('a giant real-shaped payload — count preservation', () => {
    // 100 pending + 200 accepted + 50 visited = 350 unique urls, no overlap.
    const sent = {};
    const acc = {};
    const con = {};
    for (let i = 0; i < 100; i++) sent[`https://www.linkedin.com/in/p${i}/`] = sentRec(`https://www.linkedin.com/in/p${i}/`);
    for (let i = 0; i < 200; i++) acc[`https://www.linkedin.com/in/a${i}/`]  = acceptedRec(`https://www.linkedin.com/in/a${i}/`);
    for (let i = 0; i < 50; i++)  con[`https://www.linkedin.com/in/v${i}/`]  = contactRec(`https://www.linkedin.com/in/v${i}/`);
    const stored = v1({ sentInvitations: sent, accepted: acc, contacts: con });
    const out = migrateToV2(stored);
    expect(Object.keys(out.contacts)).toHaveLength(350);
    const counts = Object.values(out.contacts).reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ pending: 100, accepted: 200, visited: 50 });
  });
});
