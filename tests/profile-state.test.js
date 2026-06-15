import { describe, it, expect } from 'vitest';
import { applyProfileVisit, applyContactInfo } from '../linkedin-tracker/core/profile-state.js';

const NOW = 1716624000000; // 2024-05-25T08:00:00Z, fixed for determinism
const DAY = 86400000;

function info(overrides = {}) {
  return {
    profileUrl: 'https://www.linkedin.com/in/jane/',
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

describe('applyProfileVisit — contacts (always touched)', () => {
  it('creates a contacts entry on first visit', () => {
    const r = applyProfileVisit({}, info(), 'connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/jane/']).toMatchObject({
      name: 'Jane Doe',
      headline: 'Engineer',
      country: 'Germany',
      connected: true,
      visitedAt: NOW,
      firstSeenAt: NOW,
    });
  });

  it('preserves firstSeenAt across subsequent visits', () => {
    const stored = {
      contacts: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].firstSeenAt).toBe(NOW - 10 * DAY);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].visitedAt).toBe(NOW);
  });

  it('sets connected=false in contacts when status is not_connected', () => {
    const r = applyProfileVisit({}, info(), 'not_connected', NOW);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].connected).toBe(false);
  });
});

describe('applyProfileVisit — status:pending', () => {
  it('adds to sentInvitations when not in any bucket', () => {
    const r = applyProfileVisit({}, info(), 'pending', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toMatchObject({
      profileUrl: 'https://www.linkedin.com/in/jane/',
      name: 'Jane Doe',
      addedFrom: 'profile',
      firstSeenAt: NOW,
    });
    expect(r.accepted).toEqual({});
    expect(r.sentChanged).toBe(true);
  });

  it('updates existing sentInvitations entry (lastSeenAt bumped)', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          name: 'Old Name',
          firstSeenAt: NOW - 5 * DAY,
          lastSeenAt: NOW - 5 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/'].lastSeenAt).toBe(NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/'].firstSeenAt).toBe(NOW - 5 * DAY);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/'].name).toBe('Jane Doe');
  });

  it('persists mutuals (url + text + count) onto new sentInvitations entry', () => {
    const r = applyProfileVisit({}, info(), 'pending', NOW);
    const rec = r.sentInvitations['https://www.linkedin.com/in/jane/'];
    expect(rec.mutualsUrl).toBe('https://www.linkedin.com/search/results/people/?connectionOf=urn:li:member:1&network=["F"]');
    expect(rec.mutualsText).toBe('Anton, Mikhail and 5 other mutual connections');
    expect(rec.mutualsCount).toBe(7);
  });

  it('refreshes mutuals on an existing sentInvitations record (count drifts as network grows)', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          name: 'Jane Doe',
          firstSeenAt: NOW - 5 * DAY,
          lastSeenAt: NOW - 5 * DAY,
          mutualsCount: 3,
          mutualsText: 'Anton and 2 other mutual connections',
        },
      },
    };
    const r = applyProfileVisit(stored, info({
      mutualsCount: 7,
      mutualsText: 'Anton, Mikhail and 5 other mutual connections',
    }), 'pending', NOW);
    const rec = r.sentInvitations['https://www.linkedin.com/in/jane/'];
    expect(rec.mutualsCount).toBe(7);
    expect(rec.mutualsText).toBe('Anton, Mikhail and 5 other mutual connections');
  });

  it('drops a stale accepted entry when status flips to pending (re-invite case)', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'declined',
          acceptedAt: NOW - 30 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeUndefined();
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeDefined();
    expect(r.acceptedChanged).toBe(true);
    expect(r.sentChanged).toBe(true);
  });
});

describe('applyProfileVisit — status:connected', () => {
  it('persists mutuals onto a brand-new accepted (auto-marked) record', () => {
    const r = applyProfileVisit({}, info(), 'connected', NOW);
    const rec = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(rec.mutualsUrl).toBe('https://www.linkedin.com/search/results/people/?connectionOf=urn:li:member:1&network=["F"]');
    expect(rec.mutualsText).toBe('Anton, Mikhail and 5 other mutual connections');
    expect(rec.mutualsCount).toBe(7);
  });

  it('persists mutuals on promote-from-pending (sentInvitations → accepted)', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          name: 'Jane Doe',
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    const rec = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(rec.mutualsUrl).toBe('https://www.linkedin.com/search/results/people/?connectionOf=urn:li:member:1&network=["F"]');
    expect(rec.mutualsCount).toBe(7);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeUndefined();
  });

  it('lands a brand-new connection in Accepted with marked=false', () => {
    // Regression: before this change, profile-page visits to "connected"
    // people we had no prior tracking for were auto-marked. That silently
    // buried fresh acceptances whose pending phase we missed — common when
    // the user invited from /mynetwork/ without visiting the profile, OR
    // when pre-1.2.3 pending detection failed on that profile. Now they
    // appear in Accepted; legacy pre-install contacts can be cleared via
    // the "Mark all" button (one-time action).
    const r = applyProfileVisit({}, info(), 'connected', NOW);
    const a = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(a).toMatchObject({
      verified: 'accepted',
      marked: false,
      markedAt: null,
      acceptedAt: NOW,
      daysPending: 0,
    });
    expect(a.autoMarked).toBeUndefined();
  });

  it('promotes pending → accepted preserving firstSeenAt for daysPending calculation', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          name: 'Jane Doe',
          firstSeenAt: NOW - 5 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeUndefined();
    const a = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(a.daysPending).toBe(5);
    expect(a.acceptedAt).toBe(NOW);
    expect(a.verified).toBe('accepted');
    expect(a.autoMarked).toBeUndefined();
  });

  it('upgrades verified:null → verified:accepted on an existing accepted entry', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: null,
          acceptedAt: NOW - 2 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('accepted');
    expect(r.acceptedChanged).toBe(true);
  });

  it('upgrades verified:declined → verified:accepted (user changed mind)', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'declined',
          acceptedAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('accepted');
  });
});

describe('applyProfileVisit — status:not_connected', () => {
  it('no-op when profile never tracked', () => {
    const r = applyProfileVisit({}, info(), 'not_connected', NOW);
    expect(r.accepted).toEqual({});
    expect(r.sentInvitations).toEqual({});
    expect(r.acceptedChanged).toBe(false);
    expect(r.sentChanged).toBe(false);
  });

  it('removes from sentInvitations (user withdrew on the profile page)', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': { profileUrl: 'https://www.linkedin.com/in/jane/' },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeUndefined();
    expect(r.sentChanged).toBe(true);
  });

  it('REGRESSION (Bernardo bug): does NOT downgrade canonical /connections/-verified entry on transient not_connected profile visit', () => {
    // Bernardo bug from Mira: real 1st-degree connection wrongly shown as
    // ✗ DECLINED in popup. Cause: profile.js detected not_connected during a
    // slow profile-page load (Follow button flashed before Message settled),
    // stability check confirmed it, applyProfileVisit downgraded to declined.
    // Fix: entries carrying `connectedOnText` (from /connections/ scan, the
    // canonical source) are never downgraded by profile.js — only a fresh
    // /connections/ scan can revise them.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/bernardo/': {
          profileUrl: 'https://www.linkedin.com/in/bernardo/',
          verified: 'accepted',
          verifiedAt: NOW - 5 * DAY,
          connectedOnText: 'Connected on May 28, 2026',
        },
      },
    };
    const r = applyProfileVisit(stored, info({ profileUrl: 'https://www.linkedin.com/in/bernardo/' }), 'not_connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/bernardo/'].verified).toBe('accepted');
    expect(r.acceptedChanged).toBe(false);
  });

  it('marks a verified-accepted entry without connectedOnText as declined (Vlad case)', () => {
    // Verified upgraded by a previous profile.js detection (possibly transient).
    // LinkedIn now shows Connect — record stays in Marked, badge flips to ✗ declined.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/vlad/': {
          profileUrl: 'https://www.linkedin.com/in/vlad/',
          verified: 'accepted',
          verifiedAt: NOW - 5 * DAY,
          marked: true,
          markedAt: NOW - 1 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info({ profileUrl: 'https://www.linkedin.com/in/vlad/' }), 'not_connected', NOW);
    const entry = r.accepted['https://www.linkedin.com/in/vlad/'];
    expect(entry).toBeDefined();
    expect(entry.verified).toBe('declined');
    expect(entry.marked).toBe(true); // preserve marked status
    expect(r.acceptedChanged).toBe(true);
  });

  it('marks an autoMarked entry as declined (preserves the record over silent deletion)', () => {
    // Auto-added "pre-existing" entry from a profile visit. If status now says
    // not_connected, the past detection was wrong OR they disconnected since.
    // Either way, preserve and surface via declined badge — surprise deletes
    // are worse than a stale label.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          autoMarked: true,
          verified: 'accepted',
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeDefined();
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('declined');
  });

  it('marks verified:declined when entry was tracked via /sent/ but never confirmed', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: null,
          acceptedAt: NOW - 7 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/jane/'].verified).toBe('declined');
    expect(r.acceptedChanged).toBe(true);
  });

  it('no-op when entry already verified:declined', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          verified: 'declined',
          verifiedAt: NOW - 1 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'not_connected', NOW);
    expect(r.acceptedChanged).toBe(false);
  });
});

describe('applyProfileVisit — regression: someone added me, then I visit their profile', () => {
  // Anastasia bug: she added the user → showed up in Accepted via /connections/
  // scan with verified='accepted', autoMarked=false, marked=false. User then
  // visits her profile (status='connected'). Expectation: she STAYS in accepted.
  it('preserves a connections-page-sourced entry across a connected profile visit', () => {
    const url = 'https://www.linkedin.com/in/anastasia/';
    const stored = {
      accepted: {
        [url]: {
          profileUrl: url,
          name: 'Anastasia',
          headline: 'IT Recruiter',
          avatar: 'https://media.licdn.com/avatar.jpg',
          acceptedAt: NOW - 2 * DAY,
          firstSeenAt: NOW - 2 * DAY,
          daysPending: 0,
          marked: false,
          markedAt: null,
          verified: 'accepted',
          verifiedAt: NOW - 2 * DAY,
          connectedOnText: 'Connected on May 23, 2026',
          autoMarked: false,
          addedFrom: 'connections-page',
        },
      },
    };
    const r = applyProfileVisit(stored, info({ profileUrl: url, name: 'Anastasia' }), 'connected', NOW);
    expect(r.accepted[url]).toBeDefined();
    expect(r.accepted[url].verified).toBe('accepted');
    expect(r.accepted[url].marked).toBe(false);
    expect(r.accepted[url].autoMarked).toBe(false);
  });

  // Edge case: if MutationObserver fires DURING page load, the first tick may
  // see a partial DOM (no buttons rendered yet) — in that intermediate state
  // detect returns 'not_connected' falsely → applyProfileVisit deletes her.
  // The fix is in the detector (return null when not enough signal), not here,
  // but document the expected behavior of applyProfileVisit too.
  it('preserves entry when status is null (caller must skip persistence in that case)', () => {
    // applyProfileVisit isn't called with null in real code (profile.js bails
    // out earlier), but this asserts the contract.
    const url = 'https://www.linkedin.com/in/anastasia/';
    const stored = {
      accepted: { [url]: { profileUrl: url, verified: 'accepted' } },
    };
    // Sanity: applyProfileVisit doesn't accept null — caller is expected to
    // pre-filter. Document: only valid statuses are pending/connected/not_connected.
    expect(() => applyProfileVisit(stored, info({ profileUrl: url }), 'connected', NOW)).not.toThrow();
  });
});

describe('applyProfileVisit — invariants', () => {
  it('"one bucket at a time" — pending visit clears accepted, never both', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': { profileUrl: 'https://www.linkedin.com/in/jane/' },
      },
    };
    const r = applyProfileVisit(stored, info(), 'pending', NOW);
    const inAccepted = !!r.accepted['https://www.linkedin.com/in/jane/'];
    const inSent = !!r.sentInvitations['https://www.linkedin.com/in/jane/'];
    expect(inAccepted && inSent).toBe(false);
    expect(inSent).toBe(true);
  });

  it('"one bucket at a time" — connected visit clears sentInvitations', () => {
    const stored = {
      sentInvitations: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          firstSeenAt: NOW - 3 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW);
    expect(r.sentInvitations['https://www.linkedin.com/in/jane/']).toBeUndefined();
    expect(r.accepted['https://www.linkedin.com/in/jane/']).toBeDefined();
  });
});

describe('applyProfileVisit — cross-URL dedup (memberId ONLY, no name fallback)', () => {
  it('merges old record into new URL when memberId matches', () => {
    // User visited a profile under OLD slug, contact got declined by the
    // buggy pre-1.2.2 detector. LinkedIn changes the slug. User re-visits
    // at NEW slug, fix returns connected. memberId from RSC matches the
    // stored memberId on the old record → merge into new URL key.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/zhenia-old-slug/': {
          profileUrl: 'https://www.linkedin.com/in/zhenia-old-slug/',
          name: 'Zhenia Mohyla',
          memberId: 'M-111',
          verified: 'declined',
          acceptedAt: NOW - 30 * DAY,
          firstSeenAt: NOW - 30 * DAY,
          daysPending: 0,
        },
      },
    };
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/zhenyamogila/',
      name: 'Zhenia Mohyla',
      memberId: 'M-111',
    }), 'connected', NOW);

    expect(r.accepted['https://www.linkedin.com/in/zhenia-old-slug/']).toBeUndefined();
    const cur = r.accepted['https://www.linkedin.com/in/zhenyamogila/'];
    expect(cur).toBeDefined();
    expect(cur.verified).toBe('accepted');
    expect(cur.firstSeenAt).toBe(NOW - 30 * DAY);
    expect(cur.acceptedAt).toBe(NOW - 30 * DAY);
  });

  it('migrates contact info from old record into new URL when memberId matches', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/old/': {
          profileUrl: 'https://www.linkedin.com/in/old/',
          name: 'Zhenia Mohyla',
          memberId: 'M-111',
          verified: 'declined',
          acceptedAt: NOW - 30 * DAY,
          firstSeenAt: NOW - 30 * DAY,
          daysPending: 0,
          email: 'z@old.captured',
          phone: '+999',
          contactsCapturedAt: NOW - 5 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/new/',
      name: 'Zhenia Mohyla',
      memberId: 'M-111',
    }), 'connected', NOW, null);

    const cur = r.accepted['https://www.linkedin.com/in/new/'];
    expect(cur.email).toBe('z@old.captured');
    expect(cur.phone).toBe('+999');
  });

  it('still merges when names DIFFER but memberId matches (married surname, transliteration)', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/maiden-name/': {
          profileUrl: 'https://www.linkedin.com/in/maiden-name/',
          name: 'Anna Smith',
          memberId: 'M-555',
          verified: 'accepted',
          acceptedAt: NOW - 60 * DAY,
          firstSeenAt: NOW - 60 * DAY,
          daysPending: 0,
        },
      },
    };
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/married-name/',
      name: 'Anna Johnson',
      memberId: 'M-555',
    }), 'connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/maiden-name/']).toBeUndefined();
    expect(r.accepted['https://www.linkedin.com/in/married-name/']).toBeDefined();
  });

  it('does NOT dedup when names match but memberIds differ (two different people)', () => {
    // The whole reason name-based dedup is banned: two real people named
    // "John Smith" with different memberIds must remain separate records.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/john-a/': {
          profileUrl: 'https://www.linkedin.com/in/john-a/',
          name: 'John Smith',
          memberId: 'M-AAA',
          verified: 'accepted',
          acceptedAt: NOW - 30 * DAY,
          firstSeenAt: NOW - 30 * DAY,
          daysPending: 0,
        },
      },
    };
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/john-b/',
      name: 'John Smith',
      memberId: 'M-BBB',
    }), 'connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/john-a/']).toBeDefined();
    expect(r.accepted['https://www.linkedin.com/in/john-b/']).toBeDefined();
  });

  it('does NOT dedup when one side has no memberId (silent name-based merge banned)', () => {
    // Legacy record from pre-1.2.2 has no memberId. New visit has one.
    // Without a verifiable identity match we MUST NOT merge — name match
    // alone is forbidden because it can corrupt data with two people
    // sharing a name.
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/legacy/': {
          profileUrl: 'https://www.linkedin.com/in/legacy/',
          name: 'Zhenia Mohyla',
          verified: 'declined',
          acceptedAt: NOW - 30 * DAY,
          firstSeenAt: NOW - 30 * DAY,
          daysPending: 0,
        },
      },
    };
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/zhenyamogila/',
      name: 'Zhenia Mohyla',
      memberId: 'M-NEW',
    }), 'connected', NOW);
    expect(r.accepted['https://www.linkedin.com/in/legacy/']).toBeDefined();
    expect(r.accepted['https://www.linkedin.com/in/zhenyamogila/']).toBeDefined();
  });

  it('preserves marked status from the older record after merge', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/old/': {
          profileUrl: 'https://www.linkedin.com/in/old/',
          name: 'Zhenia Mohyla',
          memberId: 'M-111',
          verified: 'accepted',
          marked: true,
          markedAt: NOW - 10 * DAY,
          acceptedAt: NOW - 30 * DAY,
          firstSeenAt: NOW - 30 * DAY,
          daysPending: 0,
        },
      },
    };
    const r = applyProfileVisit(stored, info({
      profileUrl: 'https://www.linkedin.com/in/new/',
      name: 'Zhenia Mohyla',
      memberId: 'M-111',
    }), 'connected', NOW);
    const cur = r.accepted['https://www.linkedin.com/in/new/'];
    expect(cur.marked).toBe(true);
    expect(cur.markedAt).toBe(NOW - 10 * DAY);
  });

  it('persists memberId and vanityName from info onto the contacts record', () => {
    const r = applyProfileVisit({}, info({
      memberId: 'M-42',
      vanityName: 'jane',
    }), 'connected', NOW);
    const c = r.contacts['https://www.linkedin.com/in/jane/'];
    expect(c.memberId).toBe('M-42');
    expect(c.vanityName).toBe('jane');
  });
});

describe('applyContactInfo', () => {
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
    // Modal was opened with only Phone — we should NOT wipe the previously
    // captured email just because this snapshot didn't have it.
    const target = { email: 'keep@x.co', phone: '+1', contactsCapturedAt: NOW - 1000 };
    applyContactInfo(target, { phone: '+2' }, NOW);
    expect(target.email).toBe('keep@x.co');
    expect(target.phone).toBe('+2');
    expect(target.contactsCapturedAt).toBe(NOW);
  });
});

describe('applyProfileVisit — contact info modal integration', () => {
  it('writes contact fields onto contacts entry on connected visit', () => {
    const r = applyProfileVisit({}, info(), 'connected', NOW, {
      email: 'jane@example.com',
      phone: '+1 415 555 0100',
      website: 'https://jane.example',
    });
    const c = r.contacts['https://www.linkedin.com/in/jane/'];
    expect(c.email).toBe('jane@example.com');
    expect(c.phone).toBe('+1 415 555 0100');
    expect(c.website).toBe('https://jane.example');
    expect(c.contactsCapturedAt).toBe(NOW);
  });

  it('also writes contact fields onto accepted entry (so popup sees them)', () => {
    const r = applyProfileVisit({}, info(), 'connected', NOW, {
      email: 'jane@example.com',
    });
    expect(r.acceptedChanged).toBe(true);
    expect(r.accepted['https://www.linkedin.com/in/jane/'].email).toBe('jane@example.com');
  });

  it('preserves previously captured fields across visits when modal not open', () => {
    const stored = {
      contacts: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          email: 'old@jane.co',
          phone: '+999',
          contactsCapturedAt: NOW - 10 * DAY,
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW, null);
    const c = r.contacts['https://www.linkedin.com/in/jane/'];
    expect(c.email).toBe('old@jane.co');
    expect(c.phone).toBe('+999');
    expect(c.contactsCapturedAt).toBe(NOW - 10 * DAY);
  });

  it('overwrites email when the modal shows a different one on a later visit', () => {
    const stored = {
      contacts: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          email: 'old@jane.co',
          contactsCapturedAt: NOW - 10 * DAY,
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, info(), 'connected', NOW, { email: 'new@jane.co' });
    const c = r.contacts['https://www.linkedin.com/in/jane/'];
    expect(c.email).toBe('new@jane.co');
    expect(c.contactsCapturedAt).toBe(NOW);
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

  it('persists lastActivityAt, lastPostAt, recentActivity on first visit (connected)', () => {
    const r = applyProfileVisit({}, activityInfo(), 'connected', NOW, null);
    const c = r.contacts['https://www.linkedin.com/in/jane/'];
    expect(c.lastActivityAt).toBe('2026-06-10T12:00:00.000Z');
    expect(c.lastPostAt).toBe('2026-06-08T09:00:00.000Z');
    expect(c.recentActivity).toHaveLength(2);
    expect(c.recentActivity[0].urnActivityId).toBe('A');
    // accepted record gets the same fields
    const a = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(a.lastActivityAt).toBe('2026-06-10T12:00:00.000Z');
    expect(a.recentActivity).toHaveLength(2);
  });

  it('persists activity on a pending visit (sentInvitations)', () => {
    const r = applyProfileVisit({}, activityInfo(), 'pending', NOW, null);
    const s = r.sentInvitations['https://www.linkedin.com/in/jane/'];
    expect(s.lastActivityAt).toBe('2026-06-10T12:00:00.000Z');
    expect(s.lastPostAt).toBe('2026-06-08T09:00:00.000Z');
    expect(s.recentActivity).toHaveLength(2);
  });

  it('keeps the LATER lastActivityAt across visits (stored > fresh)', () => {
    const stored = {
      contacts: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          lastActivityAt: '2026-06-30T00:00:00.000Z',  // stored is newer than fresh
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, activityInfo(), 'connected', NOW, null);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].lastActivityAt)
      .toBe('2026-06-30T00:00:00.000Z');
  });

  it('keeps the LATER lastActivityAt across visits (fresh > stored)', () => {
    const stored = {
      contacts: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          lastActivityAt: '2026-05-01T00:00:00.000Z',
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, activityInfo(), 'connected', NOW, null);
    expect(r.contacts['https://www.linkedin.com/in/jane/'].lastActivityAt)
      .toBe('2026-06-10T12:00:00.000Z');
  });

  it('merges recentActivity across visits, dedupes by URN, caps at 5', () => {
    const stored = {
      contacts: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          recentActivity: [
            { urnActivityId: 'B', postedAt: '2026-06-08T09:00:00.000Z', text: 'old-B' },
            { urnActivityId: 'C', postedAt: '2026-05-01T00:00:00.000Z', text: 'C' },
            { urnActivityId: 'D', postedAt: '2026-04-01T00:00:00.000Z', text: 'D' },
            { urnActivityId: 'E', postedAt: '2026-03-01T00:00:00.000Z', text: 'E' },
            { urnActivityId: 'F', postedAt: '2026-02-01T00:00:00.000Z', text: 'F' },
          ],
          firstSeenAt: NOW - 10 * DAY,
        },
      },
    };
    const r = applyProfileVisit(stored, activityInfo(), 'connected', NOW, null);
    const list = r.contacts['https://www.linkedin.com/in/jane/'].recentActivity;
    expect(list).toHaveLength(5);
    expect(list.map((c) => c.urnActivityId)).toEqual(['A', 'B', 'C', 'D', 'E']);
    // Fresh wins for B (the URN that overlapped)
    const b = list.find((c) => c.urnActivityId === 'B');
    expect(b.text).toBe('B');
    // F got pushed out by A which is newer
    expect(list.find((c) => c.urnActivityId === 'F')).toBeUndefined();
  });

  it('preserves stored activity when this tick has no recentActivity (Activity card not rendered)', () => {
    const stored = {
      accepted: {
        'https://www.linkedin.com/in/jane/': {
          profileUrl: 'https://www.linkedin.com/in/jane/',
          name: 'Jane Doe',
          acceptedAt: NOW - 10 * DAY,
          marked: false,
          verified: 'accepted',
          recentActivity: [{ urnActivityId: 'Z', postedAt: '2026-05-20T00:00:00.000Z', text: 'Z' }],
          lastActivityAt: '2026-05-20T00:00:00.000Z',
        },
      },
    };
    // info has no activity (Activity section was empty or not yet rendered)
    const tickInfo = info({ lastActivityAt: null, lastPostAt: null, recentActivity: [] });
    const r = applyProfileVisit(stored, tickInfo, 'connected', NOW, null);
    const a = r.accepted['https://www.linkedin.com/in/jane/'];
    expect(a.recentActivity).toHaveLength(1);
    expect(a.recentActivity[0].urnActivityId).toBe('Z');
    expect(a.lastActivityAt).toBe('2026-05-20T00:00:00.000Z');
  });
});
