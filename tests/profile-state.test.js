import { describe, it, expect } from 'vitest';
import { applyProfileVisit, applyContactInfo, STATUS } from '../linkedin-tracker/core/profile-state.js';

// V2 (unified contacts store) migration of all pre-1.3.0 profile-state
// regressions. Every "expect(r.sentInvitations[url])" from v1 is now
// "expect(r.contacts[url]).with status === 'pending'"; likewise accepted.

const NOW = 1716624000000; // 2024-05-25T08:00:00Z, fixed for determinism
const DAY = 86400000;
const URL_JANE = 'https://www.linkedin.com/in/jane/';

function info(overrides = {}) {
  return {
    profileUrl: URL_JANE,
    name: 'Jane Doe',
    headline: 'Engineer',
    avatar: 'https://media.licdn.com/profile-displayphoto/jane.jpg',
    location: 'Berlin, Germany',
    country: 'Germany',
    mutualsUrl: 'https://www.linkedin.com/search/results/people/?connectionOf=urn:li:member:1&network=["F"]',
    mutualsText: 'Anton, Mikhail and 5 other mutual connections',
    mutualsCount: 7,
    ...overrides,
  };
}

// Build a v2-shaped `stored` snapshot from a per-URL record dict. Each
// entry must carry `status` — tests assert transitions from any of the
// four statuses, so this helper keeps set-up terse.
function storedV2(entries) {
  return { schemaVersion: 2, contacts: entries || {} };
}

describe('applyProfileVisit — first-visit record creation', () => {
  it('creates a status=accepted record on first connected visit', () => {
    const r = applyProfileVisit(storedV2(), info(), 'connected', NOW);
    expect(r.contacts[URL_JANE]).toMatchObject({
      name: 'Jane Doe',
      headline: 'Engineer',
      country: 'Germany',
      status: STATUS.ACCEPTED,
      visitedAt: NOW,
      firstSeenAt: NOW,
      acceptedAt: NOW,
      daysPending: 0,
    });
    expect(r.changed).toBe(true);
  });

  it('creates a status=pending record on first pending visit', () => {
    const r = applyProfileVisit(storedV2(), info(), 'pending', NOW);
    expect(r.contacts[URL_JANE]).toMatchObject({
      name: 'Jane Doe',
      status: STATUS.PENDING,
      firstSeenAt: NOW,
      addedFrom: 'profile',
    });
    expect(r.contacts[URL_JANE].acceptedAt).toBeNull();
    expect(r.changed).toBe(true);
  });

  it('creates a status=visited record when not_connected has no prior tracking (never invited)', () => {
    const r = applyProfileVisit(storedV2(), info(), 'not_connected', NOW);
    expect(r.contacts[URL_JANE].status).toBe(STATUS.VISITED);
    expect(r.changed).toBe(true);
  });
});

describe('applyProfileVisit — preserves history across revisits', () => {
  it('preserves firstSeenAt across subsequent visits', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.VISITED,
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.contacts[URL_JANE].firstSeenAt).toBe(NOW - 10 * DAY);
    expect(r.contacts[URL_JANE].visitedAt).toBe(NOW);
  });

  it('updates existing pending on revisit (visitedAt bumped, firstSeenAt kept)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        name: 'Old Name',
        status: STATUS.PENDING,
        firstSeenAt: NOW - 5 * DAY,
        visitedAt:   NOW - 5 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    expect(r.contacts[URL_JANE].visitedAt).toBe(NOW);
    expect(r.contacts[URL_JANE].firstSeenAt).toBe(NOW - 5 * DAY);
    expect(r.contacts[URL_JANE].name).toBe('Jane Doe');
    expect(r.contacts[URL_JANE].status).toBe(STATUS.PENDING);
  });
});

describe('applyProfileVisit — status transitions', () => {
  it('pending → accepted: promotes preserving firstSeenAt, computes daysPending', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.PENDING,
        firstSeenAt: NOW - 5 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    const c = r.contacts[URL_JANE];
    expect(c.status).toBe(STATUS.ACCEPTED);
    expect(c.acceptedAt).toBe(NOW);
    expect(c.daysPending).toBe(5);
    expect(c.firstSeenAt).toBe(NOW - 5 * DAY);
    expect(r.changed).toBe(true);
  });

  it('accepted → pending: re-invite case, verifiedAt bumped only when accepted', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.DECLINED,
        acceptedAt: NOW - 30 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    expect(r.contacts[URL_JANE].status).toBe(STATUS.PENDING);
    expect(r.changed).toBe(true);
  });

  it('accepted → declined: profile page shows not-connected, no canonical proof', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.ACCEPTED,
        verifiedAt: NOW - 5 * DAY,
        marked: true,
        markedAt: NOW - 1 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    const c = r.contacts[URL_JANE];
    expect(c.status).toBe(STATUS.DECLINED);
    expect(c.declinedAt).toBe(NOW);
    expect(c.marked).toBe(true);  // marked preserved
    expect(r.changed).toBe(true);
  });

  it('declined → accepted: user changed mind (Withdraw + re-invite → accepted)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.DECLINED,
        acceptedAt: NOW - 10 * DAY,
        declinedAt: NOW - 3 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.contacts[URL_JANE].status).toBe(STATUS.ACCEPTED);
    // declinedAt cleared after re-acceptance
    expect(r.contacts[URL_JANE].declinedAt).toBeNull();
  });
});

describe('applyProfileVisit — connectedOnText anti-downgrade guard', () => {
  it('REGRESSION (Bernardo bug): does NOT downgrade canonical /connections/-verified entry on transient not_connected profile visit', () => {
    // Real 1st-degree connection wrongly shown as declined in popup. Cause:
    // profile.js detected not_connected during a slow profile-page load
    // (Follow button flashed before Message settled). Fix: entries carrying
    // `connectedOnText` (from /connections/ scan, the canonical source)
    // are never downgraded by profile.js — only a fresh /connections/ scan
    // can revise them.
    const stored = storedV2({
      'https://www.linkedin.com/in/bernardo/': {
        profileUrl: 'https://www.linkedin.com/in/bernardo/',
        status: STATUS.ACCEPTED,
        verifiedAt: NOW - 5 * DAY,
        connectedOnText: 'Connected on May 28, 2026',
      },
    });
    const r = applyProfileVisit(stored, info({ profileUrl: 'https://www.linkedin.com/in/bernardo/' }), 'not_connected', NOW);
    const c = r.contacts['https://www.linkedin.com/in/bernardo/'];
    expect(c.status).toBe(STATUS.ACCEPTED);
    // Metadata fields (headline/avatar/etc) on this record were empty
    // before the visit and get populated now — that's a legitimate
    // change, but the status must NOT be downgraded and verifiedAt must
    // NOT be bumped by a refused not_connected tick.
    expect(c.verifiedAt).toBe(NOW - 5 * DAY);
    expect(c.declinedAt).toBeNull();
  });

  it('preserves an entry sourced from the /connections/ scan across a connected profile visit', () => {
    // Anastasia bug: she added the user → showed up in Accepted via /connections/
    // scan (via merge-connections.js). Now user visits her profile — she must
    // remain marked=false and status=accepted (no accidental re-mark).
    const url = 'https://www.linkedin.com/in/anastasia/';
    const stored = storedV2({
      [url]: {
        profileUrl: url,
        name: 'Anastasia',
        status: STATUS.ACCEPTED,
        acceptedAt: NOW - 2 * DAY,
        firstSeenAt: NOW - 2 * DAY,
        daysPending: 0,
        marked: false,
        markedAt: null,
        verifiedAt: NOW - 2 * DAY,
        connectedOnText: 'Connected on May 23, 2026',
        addedFrom: 'connections-page',
      },
    });
    const r = applyProfileVisit(stored, info({ profileUrl: url, name: 'Anastasia' }), 'connected', NOW);
    expect(r.contacts[url].status).toBe(STATUS.ACCEPTED);
    expect(r.contacts[url].marked).toBe(false);
  });
});

describe('applyProfileVisit — firstConnectedAt self-reinforcing guard', () => {
  // Class-of-bug: user visits a profile, detection returns 'connected'
  // (via aria or RSC), status becomes 'accepted'. Later, another visit
  // hits a transient DOM state — sidebar bleed, half-hydrated RSC,
  // race with SPA navigation — and detection returns 'not_connected'.
  // Without a guard, the record downgrades to 'declined'. connectedOnText
  // only exists after /connections/ scan; users who don't run that scan
  // had no protection. firstConnectedAt closes the gap: it's set the
  // FIRST time we ever observe 'connected', never cleared, and any
  // future not_connected observation is refused as long as it's set.

  it('sets firstConnectedAt on the first connected observation and never clears it', () => {
    const url = 'https://www.linkedin.com/in/first-time/';
    const stored = storedV2({});
    // First visit: connected
    const r1 = applyProfileVisit(stored, info({ profileUrl: url }), 'connected', NOW);
    expect(r1.contacts[url].status).toBe(STATUS.ACCEPTED);
    expect(r1.contacts[url].firstConnectedAt).toBe(NOW);

    // Second visit later: also connected — firstConnectedAt stays the earlier value
    const stored2 = { ...stored, contacts: r1.contacts };
    const r2 = applyProfileVisit(stored2, info({ profileUrl: url }), 'connected', NOW + 5 * DAY);
    expect(r2.contacts[url].firstConnectedAt).toBe(NOW);
    // verifiedAt bumps on the second connected observation
    expect(r2.contacts[url].verifiedAt).toBe(NOW + 5 * DAY);
  });

  it('refuses to downgrade an accepted record that has firstConnectedAt but no connectedOnText', () => {
    const url = 'https://www.linkedin.com/in/self-guarded/';
    // First visit: connected → firstConnectedAt set
    let r = applyProfileVisit(storedV2({}), info({ profileUrl: url }), 'connected', NOW - 10 * DAY);
    expect(r.contacts[url].firstConnectedAt).toBe(NOW - 10 * DAY);
    // Later visit — DOM transient returns not_connected. Guard MUST hold.
    r = applyProfileVisit({ ...r, contacts: r.contacts }, info({ profileUrl: url }), 'not_connected', NOW);
    expect(r.contacts[url].status).toBe(STATUS.ACCEPTED);
    expect(r.contacts[url].declinedAt).toBeNull();
    // verifiedAt is NOT touched by a refused-downgrade tick (unchanged
    // from the earlier connected observation)
    expect(r.contacts[url].verifiedAt).toBe(NOW - 10 * DAY);
  });

  it('does NOT set firstConnectedAt on a visited-only or pending record (only on connected)', () => {
    const url = 'https://www.linkedin.com/in/never-connected/';
    // Visited only
    let r = applyProfileVisit(storedV2({}), info({ profileUrl: url }), 'not_connected', NOW);
    expect(r.contacts[url].status).toBe(STATUS.VISITED);
    expect(r.contacts[url].firstConnectedAt).toBeNull();
    // Pending
    r = applyProfileVisit({ ...r, contacts: r.contacts }, info({ profileUrl: url }), 'pending', NOW + 100);
    expect(r.contacts[url].status).toBe(STATUS.PENDING);
    expect(r.contacts[url].firstConnectedAt).toBeNull();
  });
});

describe('applyProfileVisit — not-connected on untracked profile', () => {
  it('creates a status=visited record when we\'ve never seen this profile before', () => {
    const r = applyProfileVisit(storedV2(), info(), 'not_connected', NOW);
    expect(r.contacts[URL_JANE].status).toBe(STATUS.VISITED);
    expect(r.contacts[URL_JANE].firstSeenAt).toBe(NOW);
  });

  it('re-visit of a visited profile just bumps visitedAt', () => {
    const stored = storedV2({
      [URL_JANE]: { profileUrl: URL_JANE, status: STATUS.VISITED, firstSeenAt: NOW - 3 * DAY },
    });
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.contacts[URL_JANE].status).toBe(STATUS.VISITED);
    expect(r.contacts[URL_JANE].visitedAt).toBe(NOW);
    expect(r.contacts[URL_JANE].firstSeenAt).toBe(NOW - 3 * DAY);
  });

  it('is idempotent — repeated not_connected visits after already-declined report no material change', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.DECLINED,
        declinedAt: NOW - 1 * DAY,
        verifiedAt: NOW - 1 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    // declinedAt is sticky — doesn't move to `now` on repeat not-connected reads
    expect(r.contacts[URL_JANE].declinedAt).toBe(NOW - 1 * DAY);
  });
});

describe('applyProfileVisit — mutuals persistence', () => {
  it('persists mutuals onto a brand-new accepted record', () => {
    const r = applyProfileVisit(storedV2(), info(), 'connected', NOW);
    const c = r.contacts[URL_JANE];
    expect(c.mutualsUrl).toBe(info().mutualsUrl);
    expect(c.mutualsText).toBe(info().mutualsText);
    expect(c.mutualsCount).toBe(7);
  });

  it('persists mutuals onto a brand-new pending record', () => {
    const r = applyProfileVisit(storedV2(), info(), 'pending', NOW);
    const c = r.contacts[URL_JANE];
    expect(c.mutualsUrl).toBe(info().mutualsUrl);
    expect(c.mutualsCount).toBe(7);
  });

  it('refreshes mutuals count on revisit (network grows)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.PENDING,
        firstSeenAt: NOW - 5 * DAY,
        mutualsCount: 3,
        mutualsText: 'Anton and 2 other mutual connections',
      },
    });
    const r = applyProfileVisit(stored, info({
      mutualsCount: 7,
      mutualsText: 'Anton, Mikhail and 5 other mutual connections',
    }), 'pending', NOW);
    expect(r.contacts[URL_JANE].mutualsCount).toBe(7);
  });
});

describe('applyProfileVisit — cross-URL dedup (memberId ONLY, no name fallback)', () => {
  it('merges old URL into new URL when memberId matches', () => {
    const stored = storedV2({
      'https://www.linkedin.com/in/zhenia-old-slug/': {
        profileUrl: 'https://www.linkedin.com/in/zhenia-old-slug/',
        name: 'Zhenia Mohyla',
        memberId: 'M-111',
        status: STATUS.DECLINED,
        acceptedAt: NOW - 30 * DAY,
        firstSeenAt: NOW - 30 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/zhenyamogila/',
      name: 'Zhenia Mohyla',
      memberId: 'M-111',
    }), 'connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/zhenia-old-slug/']).toBeUndefined();
    const cur = r.contacts['https://www.linkedin.com/in/zhenyamogila/'];
    expect(cur.status).toBe(STATUS.ACCEPTED);
    expect(cur.firstSeenAt).toBe(NOW - 30 * DAY);
    expect(cur.acceptedAt).toBe(NOW - 30 * DAY);
  });

  it('carries contact info from old URL into new URL when memberId matches', () => {
    const stored = storedV2({
      'https://www.linkedin.com/in/old/': {
        profileUrl: 'https://www.linkedin.com/in/old/',
        name: 'Zhenia Mohyla',
        memberId: 'M-111',
        status: STATUS.DECLINED,
        acceptedAt: NOW - 30 * DAY,
        firstSeenAt: NOW - 30 * DAY,
        email: 'z@old.captured',
        phone: '+999',
        contactsCapturedAt: NOW - 5 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/new/',
      name: 'Zhenia Mohyla',
      memberId: 'M-111',
    }), 'connected', NOW);
    const cur = r.contacts['https://www.linkedin.com/in/new/'];
    expect(cur.email).toBe('z@old.captured');
    expect(cur.phone).toBe('+999');
  });

  it('preserves marked status from the older record after cross-URL merge', () => {
    const stored = storedV2({
      'https://www.linkedin.com/in/old/': {
        profileUrl: 'https://www.linkedin.com/in/old/',
        name: 'Zhenia Mohyla',
        memberId: 'M-111',
        status: STATUS.ACCEPTED,
        marked: true,
        markedAt: NOW - 10 * DAY,
        firstSeenAt: NOW - 30 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/new/',
      name: 'Zhenia Mohyla',
      memberId: 'M-111',
    }), 'connected', NOW);
    const cur = r.contacts['https://www.linkedin.com/in/new/'];
    expect(cur.marked).toBe(true);
    expect(cur.markedAt).toBe(NOW - 10 * DAY);
  });

  it('does NOT dedup when names match but memberIds differ (two different people)', () => {
    const stored = storedV2({
      'https://www.linkedin.com/in/john-a/': {
        profileUrl: 'https://www.linkedin.com/in/john-a/',
        name: 'John Smith',
        memberId: 'M-AAA',
        status: STATUS.ACCEPTED,
        firstSeenAt: NOW - 30 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/john-b/',
      name: 'John Smith',
      memberId: 'M-BBB',
    }), 'connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/john-a/']).toBeDefined();
    expect(r.contacts['https://www.linkedin.com/in/john-b/']).toBeDefined();
  });

  it('does NOT dedup when one side has no memberId (silent name-based merge banned)', () => {
    const stored = storedV2({
      'https://www.linkedin.com/in/legacy/': {
        profileUrl: 'https://www.linkedin.com/in/legacy/',
        name: 'Zhenia Mohyla',
        status: STATUS.DECLINED,
        firstSeenAt: NOW - 30 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/zhenyamogila/',
      name: 'Zhenia Mohyla',
      memberId: 'M-NEW',
    }), 'connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/legacy/']).toBeDefined();
    expect(r.contacts['https://www.linkedin.com/in/zhenyamogila/']).toBeDefined();
  });

  it('persists memberId and vanityName from info onto the unified record', () => {
    const r = applyProfileVisit(storedV2(), info({ memberId: 'M-42', vanityName: 'jane' }), 'connected', NOW);
    const c = r.contacts[URL_JANE];
    expect(c.memberId).toBe('M-42');
    expect(c.vanityName).toBe('jane');
  });
});

describe('applyContactInfo — modal capture semantics', () => {
  it('returns false when contactInfo is null', () => {
    const target = { name: 'X' };
    expect(applyContactInfo(target, null, NOW)).toBe(false);
    expect(target.contactsCapturedAt).toBeUndefined();
  });

  it('returns false when nothing changed', () => {
    const target = { email: 'a@b.co' };
    expect(applyContactInfo(target, { email: 'a@b.co' }, NOW)).toBe(false);
    expect(target.contactsCapturedAt).toBeUndefined();
  });

  it('overwrites changed fields and stamps timestamp', () => {
    const target = { email: 'old@x.co', phone: '+1' };
    expect(applyContactInfo(target, { email: 'new@x.co', phone: '+1' }, NOW)).toBe(true);
    expect(target.email).toBe('new@x.co');
    expect(target.phone).toBe('+1');
    expect(target.contactsCapturedAt).toBe(NOW);
  });

  it('does not delete fields that are absent from the new payload', () => {
    const target = { email: 'keep@x.co', phone: '+1', contactsCapturedAt: NOW - 1000 };
    applyContactInfo(target, { phone: '+2' }, NOW);
    expect(target.email).toBe('keep@x.co');
    expect(target.phone).toBe('+2');
    expect(target.contactsCapturedAt).toBe(NOW);
  });
});

describe('applyProfileVisit — contact-info modal integration', () => {
  it('writes contact fields onto the unified record on connected visit', () => {
    const r = applyProfileVisit(storedV2(), info(), 'connected', NOW, {
      email: 'jane@example.com',
      phone: '+1 415 555 0100',
      website: 'https://jane.example',
    });
    const c = r.contacts[URL_JANE];
    expect(c.email).toBe('jane@example.com');
    expect(c.phone).toBe('+1 415 555 0100');
    expect(c.website).toBe('https://jane.example');
    expect(c.contactsCapturedAt).toBe(NOW);
  });

  it('preserves previously captured fields across visits when modal not open', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.VISITED,
        email: 'old@jane.co',
        phone: '+999',
        contactsCapturedAt: NOW - 10 * DAY,
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'connected', NOW, null);
    const c = r.contacts[URL_JANE];
    expect(c.email).toBe('old@jane.co');
    expect(c.phone).toBe('+999');
    expect(c.contactsCapturedAt).toBe(NOW - 10 * DAY);
  });

  it('overwrites email when the modal shows a different one on a later visit', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.VISITED,
        email: 'old@jane.co',
        contactsCapturedAt: NOW - 10 * DAY,
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'connected', NOW, { email: 'new@jane.co' });
    const c = r.contacts[URL_JANE];
    expect(c.email).toBe('new@jane.co');
    expect(c.contactsCapturedAt).toBe(NOW);
  });
});

describe('applyProfileVisit — metadata refresh policy (1.2.7 change)', () => {
  it('clears stored stale avatar when avatarConfirmed=true and fresh=empty (Costa case)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.PENDING,
        avatar: 'https://media.licdn.com/STRANGERS_FACE/profile-displayphoto.jpg',
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({ avatar: '', avatarConfirmed: true }), 'pending', NOW);
    expect(r.contacts[URL_JANE].avatar).toBe('');
  });

  it('preserves stored avatar when avatarConfirmed=false and fresh=empty (lazy-load guard)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.PENDING,
        avatar: 'https://media.licdn.com/known-good.jpg',
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({ avatar: '', avatarConfirmed: false }), 'pending', NOW);
    expect(r.contacts[URL_JANE].avatar).toBe('https://media.licdn.com/known-good.jpg');
  });

  it('overwrites avatar on a subsequent visit when LinkedIn returns a different URL', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.PENDING,
        avatar: 'https://media.licdn.com/old.jpg',
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({ avatar: 'https://media.licdn.com/new.jpg' }), 'pending', NOW);
    expect(r.contacts[URL_JANE].avatar).toBe('https://media.licdn.com/new.jpg');
  });

  it('overwrites headline/location/country/mutuals when fresh non-empty value differs', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.PENDING,
        headline: 'Old headline',
        location: 'Berlin, Germany',
        country: 'Germany',
        mutualsCount: 3,
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info({
      headline: 'New headline',
      location: 'Munich, Germany',
      country: 'Germany',
      mutualsCount: 7,
    }), 'pending', NOW);
    const c = r.contacts[URL_JANE];
    expect(c.headline).toBe('New headline');
    expect(c.location).toBe('Munich, Germany');
    expect(c.mutualsCount).toBe(7);
  });
});

describe('applyProfileVisit — activity fields', () => {
  function activityInfo(overrides = {}) {
    return info({
      lastActivityAt: '2026-06-10T12:00:00.000Z',
      lastPostAt:     '2026-06-08T09:00:00.000Z',
      recentActivity: [
        { urnActivityId: 'A', url: 'https://x/A', author: 'Jane Doe', type: 'post',  text: 'A', postedAt: '2026-06-10T12:00:00.000Z', postedAtText: '4d' },
        { urnActivityId: 'B', url: 'https://x/B', author: 'Other',    type: 'share', text: 'B', postedAt: '2026-06-08T09:00:00.000Z', postedAtText: '1w' },
      ],
      ...overrides,
    });
  }

  it('persists lastActivityAt, lastPostAt, recentActivity on first visit', () => {
    const r = applyProfileVisit(storedV2(), activityInfo(), 'connected', NOW, null);
    const c = r.contacts[URL_JANE];
    expect(c.lastActivityAt).toBe('2026-06-10T12:00:00.000Z');
    expect(c.lastPostAt).toBe('2026-06-08T09:00:00.000Z');
    expect(c.recentActivity).toHaveLength(2);
  });

  it('keeps the LATER lastActivityAt across visits (stored > fresh)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.VISITED,
        lastActivityAt: '2026-06-30T00:00:00.000Z',
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, activityInfo(), 'connected', NOW, null);
    expect(r.contacts[URL_JANE].lastActivityAt).toBe('2026-06-30T00:00:00.000Z');
  });

  it('keeps the LATER lastActivityAt across visits (fresh > stored)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.VISITED,
        lastActivityAt: '2026-05-01T00:00:00.000Z',
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, activityInfo(), 'connected', NOW, null);
    expect(r.contacts[URL_JANE].lastActivityAt).toBe('2026-06-10T12:00:00.000Z');
  });

  it('merges recentActivity across visits, dedupes by URN, caps at 5', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.VISITED,
        recentActivity: [
          { urnActivityId: 'B', postedAt: '2026-06-08T09:00:00.000Z', text: 'old-B' },
          { urnActivityId: 'C', postedAt: '2026-05-01T00:00:00.000Z', text: 'C' },
          { urnActivityId: 'D', postedAt: '2026-04-01T00:00:00.000Z', text: 'D' },
          { urnActivityId: 'E', postedAt: '2026-03-01T00:00:00.000Z', text: 'E' },
          { urnActivityId: 'F', postedAt: '2026-02-01T00:00:00.000Z', text: 'F' },
        ],
        firstSeenAt: NOW - 10 * DAY,
      },
    });
    const r = applyProfileVisit(stored, activityInfo(), 'connected', NOW, null);
    const list = r.contacts[URL_JANE].recentActivity;
    expect(list).toHaveLength(5);
    expect(list.map((c) => c.urnActivityId)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(list.find((c) => c.urnActivityId === 'B').text).toBe('B');
    expect(list.find((c) => c.urnActivityId === 'F')).toBeUndefined();
  });

  it('preserves stored activity when this tick has no recentActivity (Activity card not rendered)', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.ACCEPTED,
        acceptedAt: NOW - 10 * DAY,
        firstSeenAt: NOW - 10 * DAY,
        recentActivity: [{ urnActivityId: 'Z', postedAt: '2026-05-20T00:00:00.000Z', text: 'Z' }],
        lastActivityAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const tickInfo = info({ lastActivityAt: null, lastPostAt: null, recentActivity: [] });
    const r = applyProfileVisit(stored, tickInfo, 'connected', NOW, null);
    const c = r.contacts[URL_JANE];
    expect(c.recentActivity).toHaveLength(1);
    expect(c.recentActivity[0].urnActivityId).toBe('Z');
    expect(c.lastActivityAt).toBe('2026-05-20T00:00:00.000Z');
  });
});

describe('applyProfileVisit — favorite / marked flags are sticky', () => {
  it('preserves favorite=true across a revisit', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.PENDING,
        favorite: true,
        favoritedAt: NOW - 3 * DAY,
        firstSeenAt: NOW - 5 * DAY,
      },
    });
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    expect(r.contacts[URL_JANE].favorite).toBe(true);
    expect(r.contacts[URL_JANE].favoritedAt).toBe(NOW - 3 * DAY);
  });

  it('preserves marked=true across a status transition', () => {
    const stored = storedV2({
      [URL_JANE]: {
        profileUrl: URL_JANE,
        status: STATUS.ACCEPTED,
        marked: true,
        markedAt: NOW - 2 * DAY,
        firstSeenAt: NOW - 10 * DAY,
        acceptedAt: NOW - 5 * DAY,
      },
    });
    // Transient not-connected → declined, but marked stays true
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.contacts[URL_JANE].status).toBe(STATUS.DECLINED);
    expect(r.contacts[URL_JANE].marked).toBe(true);
    expect(r.contacts[URL_JANE].markedAt).toBe(NOW - 2 * DAY);
  });
});
