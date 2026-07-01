import { describe, it, expect } from 'vitest';
import { mergeConnections } from '../linkedin-tracker/core/merge-connections.js';

const NOW = 1716624000000;
const DAY = 86400000;

function item(url, overrides = {}) {
  return {
    profileUrl: url,
    name: url.split('/in/')[1].replace(/\/$/, ''),
    headline: 'Headline',
    avatar: '',
    connectedAt: NOW - 30 * DAY,
    dateText: 'Connected on Apr 25, 2024',
    ...overrides,
  };
}

function storedV2(entries) {
  return { schemaVersion: 2, contacts: entries || {} };
}

describe('mergeConnections — v2 unified store', () => {
  it('adds every connection with status=accepted and canonical connectedOnText', () => {
    const r = mergeConnections([item('https://www.linkedin.com/in/a/')], storedV2(), NOW);
    const a = r.contacts['https://www.linkedin.com/in/a/'];
    expect(a.status).toBe('accepted');
    expect(a.verifiedAt).toBe(NOW);
    expect(a.acceptedAt).toBe(NOW - 30 * DAY);
    expect(a.connectedOnText).toBe('Connected on Apr 25, 2024');
    expect(a.addedFrom).toBe('connections-page');
    expect(r.touched).toBe(1);
  });

  it('promotes a previously-pending record: overwrites status=accepted, clears declined', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = storedV2({
      [url]: { profileUrl: url, status: 'pending', firstSeenAt: NOW - 30 * DAY },
    });
    const r = mergeConnections([item(url)], stored, NOW);
    expect(r.contacts[url].status).toBe('accepted');
    expect(r.contacts[url].declinedAt).toBeNull();
  });

  it('uses LinkedIn-provided connectedAt over our previous guess', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = storedV2({
      [url]: {
        profileUrl: url, name: 'A', status: 'accepted',
        acceptedAt: NOW - 10 * DAY,  // our /sent/ guess
        firstSeenAt: NOW - 20 * DAY,
      },
    });
    const r = mergeConnections([item(url, { connectedAt: NOW - 50 * DAY })], stored, NOW);
    expect(r.contacts[url].acceptedAt).toBe(NOW - 50 * DAY);
  });

  it('does NOT auto-mark brand-new discoveries (1.2.5 policy change)', () => {
    // Legacy behavior auto-marked pre-existing contacts. New policy: land in
    // Accepted with marked=false; user can bulk-clear via "Mark all" once.
    const url = 'https://www.linkedin.com/in/old-friend/';
    const r = mergeConnections([item(url)], storedV2(), NOW);
    expect(r.contacts[url].marked).toBe(false);
    expect(r.contacts[url].markedAt).toBeNull();
    expect(r.contacts[url].autoMarked).toBeUndefined();
  });

  it('preserves marked status set by the user', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = storedV2({
      [url]: { profileUrl: url, status: 'accepted', marked: true, markedAt: NOW - 1 * DAY },
    });
    const r = mergeConnections([item(url)], stored, NOW);
    expect(r.contacts[url].marked).toBe(true);
    expect(r.contacts[url].markedAt).toBe(NOW - 1 * DAY);
  });

  it('preserves favorite status set by the user', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = storedV2({
      [url]: { profileUrl: url, status: 'accepted', favorite: true, favoritedAt: NOW - 2 * DAY },
    });
    const r = mergeConnections([item(url)], stored, NOW);
    expect(r.contacts[url].favorite).toBe(true);
    expect(r.contacts[url].favoritedAt).toBe(NOW - 2 * DAY);
  });

  it('skips snapshot entries without profileUrl', () => {
    const r = mergeConnections([{ name: 'no-url' }], storedV2(), NOW);
    expect(r.contacts).toEqual({});
    expect(r.touched).toBe(0);
  });

  it('computes daysPending from firstSeenAt and connectedAt', () => {
    const url = 'https://www.linkedin.com/in/a/';
    const stored = storedV2({
      [url]: { profileUrl: url, status: 'pending', firstSeenAt: NOW - 100 * DAY },
    });
    const r = mergeConnections([item(url, { connectedAt: NOW - 90 * DAY })], stored, NOW);
    expect(r.contacts[url].daysPending).toBe(10);
  });

  it('sets connectedOnText — future profile-page not_connected reads must be refused', () => {
    // The whole point of merge-connections's canonical status: entries it
    // creates carry `connectedOnText` from LinkedIn's own connection date,
    // which the profile.js not_connected downgrade path respects and refuses
    // to downgrade.
    const url = 'https://www.linkedin.com/in/a/';
    const r = mergeConnections([item(url, { dateText: 'Connected on May 1, 2024' })], storedV2(), NOW);
    expect(r.contacts[url].connectedOnText).toBe('Connected on May 1, 2024');
  });
});
