import { describe, it, expect } from 'vitest';
const { migrateToV2, isLegacyPayload, STATUS } = require('../linkedin-tracker/core/schema-v2.js');
const { diffSentInvitations } = require('../linkedin-tracker/core/diff-sent.js');
const { mergeConnections } = require('../linkedin-tracker/core/merge-connections.js');
const { applyProfileVisit } = require('../linkedin-tracker/core/profile-state.js');

const NOW = 1721001600000; // 2024-07-15T00:00:00Z
const DAY = 86_400_000;

// End-to-end: a v1 backup payload → migrated → consumed by all four
// state modules without error. Guards the "half-migrated storage half-
// migrated code" failure mode where migration works in isolation but the
// downstream modules choke on the migrated shape.

function v1BackupPayload() {
  return {
    exportedAt: '2024-07-01T12:00:00Z',
    version: 1,
    data: {
      // NOTE: no schemaVersion → this is a v1 payload
      sentInvitations: {
        'https://www.linkedin.com/in/alice/': {
          profileUrl: 'https://www.linkedin.com/in/alice/',
          name: 'Alice A',
          headline: 'PM',
          firstSeenAt: NOW - 10 * DAY,
          lastSeenAt: NOW - 3 * DAY,
          sentDateRelative: '10 days ago',
          notes: 'Chat about hiring',
          tags: ['recruiting'],
        },
      },
      accepted: {
        'https://www.linkedin.com/in/bob/': {
          profileUrl: 'https://www.linkedin.com/in/bob/',
          name: 'Bob B',
          headline: 'Engineer',
          verified: 'accepted',
          verifiedAt: NOW - 5 * DAY,
          acceptedAt: NOW - 5 * DAY,
          firstSeenAt: NOW - 30 * DAY,
          daysPending: 25,
          marked: false,
          markedAt: null,
          favorite: true,
          favoritedAt: NOW - 2 * DAY,
          connected: true, // dropped by migration
          connectedOnText: 'Connected on June 15, 2024',
        },
        'https://www.linkedin.com/in/carol/': {
          profileUrl: 'https://www.linkedin.com/in/carol/',
          name: 'Carol C',
          verified: 'declined',
          verifiedAt: NOW - 20 * DAY,
          acceptedAt: NOW - 40 * DAY,
          firstSeenAt: NOW - 40 * DAY,
        },
      },
      contacts: {
        'https://www.linkedin.com/in/dave/': {
          profileUrl: 'https://www.linkedin.com/in/dave/',
          name: 'Dave D',
          firstSeenAt: NOW - 60 * DAY,
          visitedAt: NOW - 1 * DAY,
          email: 'dave@example.com',
          contactsCapturedAt: NOW - 1 * DAY,
        },
      },
      scanHistory: [{ timestamp: NOW - 30 * DAY, pendingCount: 5, newAccepted: 1 }],
      scanState:   { sent: { lastAt: NOW - 30 * DAY } },
      settings:    { autoCaptureProfiles: true },
    },
  };
}

describe('end-to-end: v1 backup → migration → downstream modules', () => {
  it('the backup is detected as legacy and migrates cleanly to v2', () => {
    const payload = v1BackupPayload();
    expect(isLegacyPayload(payload)).toBe(true);
    const v2 = migrateToV2(payload.data);
    expect(v2.schemaVersion).toBe(2);
    expect(Object.keys(v2.contacts).sort()).toEqual([
      'https://www.linkedin.com/in/alice/',
      'https://www.linkedin.com/in/bob/',
      'https://www.linkedin.com/in/carol/',
      'https://www.linkedin.com/in/dave/',
    ]);
    expect(v2.contacts['https://www.linkedin.com/in/alice/'].status).toBe(STATUS.PENDING);
    expect(v2.contacts['https://www.linkedin.com/in/bob/'].status).toBe(STATUS.ACCEPTED);
    expect(v2.contacts['https://www.linkedin.com/in/carol/'].status).toBe(STATUS.DECLINED);
    expect(v2.contacts['https://www.linkedin.com/in/dave/'].status).toBe(STATUS.VISITED);
    // Bob's favorite + connectedOnText preserved
    expect(v2.contacts['https://www.linkedin.com/in/bob/'].favorite).toBe(true);
    expect(v2.contacts['https://www.linkedin.com/in/bob/'].connectedOnText).toBe('Connected on June 15, 2024');
    // Dave's email preserved
    expect(v2.contacts['https://www.linkedin.com/in/dave/'].email).toBe('dave@example.com');
  });

  it('diff-sent consumes the migrated shape without error, respects sanity check', () => {
    const v2 = migrateToV2(v1BackupPayload().data);
    // Simulate a /sent/ scan that STILL shows Alice pending
    const snapshot = [{
      profileUrl: 'https://www.linkedin.com/in/alice/',
      name: 'Alice A',
      headline: 'PM',
      sentDateRelative: '11 days ago',
      avatar: '',
    }];
    const r = diffSentInvitations(snapshot, v2, NOW);
    expect(r.contacts['https://www.linkedin.com/in/alice/'].status).toBe('pending');
    expect(r.contacts['https://www.linkedin.com/in/alice/'].lastSeenAt).toBe(NOW);
    // Bob, Carol, Dave unchanged
    expect(r.contacts['https://www.linkedin.com/in/bob/'].status).toBe('accepted');
    expect(r.contacts['https://www.linkedin.com/in/carol/'].status).toBe('declined');
  });

  it('merge-connections consumes the migrated shape and promotes Alice → accepted', () => {
    const v2 = migrateToV2(v1BackupPayload().data);
    // Simulate /connections/ scan finds Alice
    const snapshot = [{
      profileUrl: 'https://www.linkedin.com/in/alice/',
      name: 'Alice A',
      headline: 'PM',
      connectedAt: NOW - 1 * DAY,
      dateText: 'Connected on July 14, 2024',
    }];
    const r = mergeConnections(snapshot, v2, NOW);
    expect(r.contacts['https://www.linkedin.com/in/alice/'].status).toBe('accepted');
    expect(r.contacts['https://www.linkedin.com/in/alice/'].acceptedAt).toBe(NOW - 1 * DAY);
    expect(r.contacts['https://www.linkedin.com/in/alice/'].connectedOnText).toBe('Connected on July 14, 2024');
  });

  it('applyProfileVisit consumes the migrated shape and can revisit a migrated pending record', () => {
    const v2 = migrateToV2(v1BackupPayload().data);
    const info = {
      profileUrl: 'https://www.linkedin.com/in/alice/',
      name: 'Alice A',
      headline: 'Senior PM',  // headline changed
      avatar: 'https://media.licdn.com/newphoto.jpg',
      location: 'NYC',
      country: 'USA',
    };
    const r = applyProfileVisit(v2, info, 'pending', NOW, null);
    const c = r.contacts['https://www.linkedin.com/in/alice/'];
    expect(c.status).toBe('pending');
    expect(c.headline).toBe('Senior PM');  // fresh non-empty wins
    expect(c.firstSeenAt).toBe(NOW - 10 * DAY);  // preserved from migration
    expect(c.notes).toBe('Chat about hiring');  // user-authored preserved
    expect(c.tags).toEqual(['recruiting']);
  });
});

describe('idempotence — running the full pipeline on a v2 payload does not corrupt it', () => {
  it('a v2 payload passes through migrateToV2 unchanged', () => {
    const v2Once = migrateToV2(v1BackupPayload().data);
    const v2Twice = migrateToV2(v2Once);
    expect(v2Twice).toBe(v2Once);
  });
});
