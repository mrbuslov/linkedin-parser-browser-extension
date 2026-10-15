// LinkedIn nav-counter detection. Fixtures are real DOM captured 2026-10-15
// from both LinkedIn shells. Two traps they pin: the Sales Navigator badge
// (and the "(8)" it puts in document.title) has nothing to do with messages,
// and the feed body links /mynetwork from cards that carry no counter.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NW = require('../linkedin-tracker/core/nav-watch.js');
const { normalizeSettings, DEFAULT_SETTINGS } = require('../linkedin-tracker/core/settings.js');

const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const mount = (html) => { document.body.innerHTML = html; return document; };

const NOW = 1_760_000_000_000;
const TOP = { name: 'Alice Example', time: '9:22 AM', preview: 'Alice: sure' };
const baseline = (counts, key = null) => Object.fromEntries(
  Object.entries(counts).map(([k, lastCount]) => [k, { lastCount, lastConversationKey: key, updatedAt: NOW - 1000 }]),
);

beforeEach(() => { document.body.innerHTML = ''; });

describe('readCounts — React shell (aria-label)', () => {
  it('reads every counter from its own nav link', () => {
    expect(NW.readCounts(mount(fixture('messaging-nav-react.html')))).toEqual({
      messages: 4, invitations: 3, activity: 7,
    });
  });

  it('ignores /mynetwork links in the page body', () => {
    const doc = mount(fixture('messaging-nav-react.html'));
    expect(doc.querySelectorAll('a[href*="/mynetwork"]').length).toBe(3);
    expect(NW.readCounts(doc).invitations).toBe(3);
  });

  it('reads zero when LinkedIn says zero', () => {
    const doc = mount(fixture('messaging-nav-react.html').replace('Messaging, 4 new', 'Messaging, 0 new'));
    expect(NW.readCounts(doc).messages).toBe(0);
  });
});

describe('readCounts — Ember shell (artdeco badge)', () => {
  it('reads each badge count and the empty badge as zero', () => {
    expect(NW.readCounts(mount(fixture('messaging-nav-ember.html')))).toEqual({
      messages: 2, invitations: 5, activity: 0,
    });
  });

  it('does NOT pick up the Sales Navigator badge when messaging has no count', () => {
    const html = fixture('messaging-nav-ember.html')
      .replace('<span class="notification-badge__count" aria-hidden="true">2</span>', '')
      .replace('2 new message notifications', '');
    expect(NW.readCounts(mount(html)).messages).toBe(0);
  });

  it('reads zero from the real no-count badge', () => {
    expect(NW.readCounts(mount(fixture('messaging-nav-ember-empty.html'))).messages).toBe(0);
  });
});

describe('readCounts — anchors gone', () => {
  it('reports null per counter that has no nav link', () => {
    expect(NW.readCounts(mount('<header><a href="/feed/">Home</a></header>'))).toEqual({
      messages: null, invitations: null, activity: null,
    });
  });

  it('reports null rather than guessing when a link has an aria-label without a number', () => {
    expect(NW.readCounts(mount('<nav><a href="/messaging/" aria-label="Messaging"></a></nav>')).messages).toBeNull();
  });

  it('reports null for an unknown shell: no aria-label and no li-icon', () => {
    expect(NW.readCounts(mount('<nav><a href="/messaging/"><span>Messaging</span></a></nav>')).messages).toBeNull();
  });
});

describe('readTopConversation', () => {
  it('reads name, time and the snippet of the first row', () => {
    expect(NW.readTopConversation(mount(fixture('messaging-conversation-list.html')))).toEqual({
      name: 'Alice Example',
      time: '9:22 AM',
      preview: 'Alice: sure, send the file over tomorrow',
    });
  });

  // REGRESSION: the first version returned "9:22 AM" as the preview. The row
  // prints the timestamp twice and the duplicate sits between <time> and the
  // snippet; a fixture without that duplicate let the bug pass unit tests and
  // the live page caught it.
  it('skips the duplicated timestamp and returns the snippet', () => {
    const doc = mount(fixture('messaging-conversation-list.html'));
    const row = doc.querySelector('li');
    const timeText = row.querySelector('time').textContent.trim();
    expect([...row.querySelectorAll('*')].filter((el) => el.textContent.trim() === timeText).length).toBe(2);
    expect(NW.readTopConversation(doc).preview).not.toBe(timeText);
  });

  it('returns null when a row has no text beyond its timestamp', () => {
    const doc = mount(fixture('messaging-conversation-list.html'));
    for (const p of doc.querySelectorAll('li:first-child p')) p.remove();
    for (const span of doc.querySelectorAll('li:first-child span')) {
      if (!/9:22 AM|Example/.test(span.textContent)) span.remove();
    }
    expect(NW.readTopConversation(doc)).toBeNull();
  });

  it('returns null when the page has no conversation list', () => {
    expect(NW.readTopConversation(mount(fixture('messaging-nav-react.html')))).toBeNull();
  });

  it('returns null for a short list (a dropdown is not the conversation list)', () => {
    const html = fixture('messaging-conversation-list.html');
    const firstRowEnd = html.indexOf('</li>') + 5;
    expect(NW.readTopConversation(mount(html.slice(0, firstRowEnd) + '</ul>'))).toBeNull();
  });
});

describe('observe', () => {
  it('combines counters and the top conversation on a messaging page', () => {
    const doc = mount(fixture('messaging-nav-ember.html') + fixture('messaging-conversation-list.html'));
    expect(NW.observe(doc)).toEqual({
      counts: { messages: 2, invitations: 5, activity: 0 },
      top: { name: 'Alice Example', time: '9:22 AM', preview: 'Alice: sure, send the file over tomorrow' },
    });
  });

  it('returns null when no counter can be read at all', () => {
    expect(NW.observe(mount('<div>not a linkedin page</div>'))).toBeNull();
  });
});

describe('nextNavState', () => {
  it('first observation only takes a baseline', () => {
    const r = NW.nextNavState(null, { counts: { messages: 3, invitations: 1, activity: 0 }, top: TOP }, NOW);
    expect(r.notifications).toEqual([]);
    expect(r.state.messages).toEqual({ lastCount: 3, lastConversationKey: 'Alice Example|9:22 AM|Alice: sure', updatedAt: NOW });
  });

  it('notifies with sender and snippet when messages grow and the top row is new', () => {
    const previous = baseline({ messages: 0, invitations: 0, activity: 0 }, 'Bob Example|Oct 14|You: thanks');
    const r = NW.nextNavState(previous, { counts: { messages: 1, invitations: 0, activity: 0 }, top: TOP }, NOW);
    expect(r.notifications).toEqual([{ key: 'messages', title: 'Alice Example', body: 'Alice: sure' }]);
  });

  it('notifies about invitations and the bell with counts, never a snippet', () => {
    const previous = baseline({ messages: 0, invitations: 0, activity: 0 });
    const r = NW.nextNavState(previous, { counts: { messages: 0, invitations: 2, activity: 1 }, top: TOP }, NOW);
    expect(r.notifications).toEqual([
      { key: 'invitations', title: 'LinkedIn', body: '2 new invitations' },
      { key: 'activity', title: 'LinkedIn', body: '1 new notification' },
    ]);
  });

  it('falls back to a count-only message notification when the top row did not change', () => {
    const key = 'Alice Example|9:22 AM|Alice: sure';
    const previous = baseline({ messages: 1, invitations: 0, activity: 0 }, key);
    const r = NW.nextNavState(previous, { counts: { messages: 2, invitations: 0, activity: 0 }, top: TOP }, NOW);
    expect(r.notifications).toEqual([{ key: 'messages', title: 'LinkedIn', body: '2 new messages' }]);
  });

  it('stays silent when a counter does not grow', () => {
    const previous = baseline({ messages: 3, invitations: 3, activity: 3 });
    const r = NW.nextNavState(previous, { counts: { messages: 3, invitations: 0, activity: 2 }, top: null }, NOW);
    expect(r.notifications).toEqual([]);
    expect(r.state.invitations.lastCount).toBe(0);
  });

  it('stays silent on my own sent message: the badge does not move, only the top row does', () => {
    const previous = baseline({ messages: 0, invitations: 0, activity: 0 }, 'Alice Example|9:20 AM|Alice: hi');
    const mine = { name: 'Alice Example', time: '9:22 AM', preview: 'You: on it' };
    expect(NW.nextNavState(previous, { counts: { messages: 0, invitations: 0, activity: 0 }, top: mine }, NOW).notifications).toEqual([]);
  });

  it('keeps the stored baseline for a counter it could not read this tick', () => {
    const previous = baseline({ messages: 4, invitations: 0, activity: 0 });
    const r = NW.nextNavState(previous, { counts: { messages: null, invitations: 0, activity: null }, top: null }, NOW);
    expect(r.state.messages).toEqual(previous.messages);
    expect(r.notifications).toEqual([]);
  });

  it('rejects malformed input instead of notifying about junk', () => {
    expect(() => NW.nextNavState(null, { counts: { messages: -1 }, top: null }, NOW)).toThrow(TypeError);
    expect(() => NW.nextNavState(null, { counts: { messages: 1.5 }, top: null }, NOW)).toThrow(TypeError);
    expect(() => NW.nextNavState(null, { counts: { inbox: 1 }, top: null }, NOW)).toThrow(/unknown targets/);
    expect(() => NW.nextNavState(null, { counts: {}, top: { name: 'A', time: '', preview: 'x' } }, NOW)).toThrow(TypeError);
    expect(() => NW.nextNavState(null, { counts: {}, top: { name: 'A', time: 'b', preview: 'c', extra: 1 } }, NOW)).toThrow(/unknown keys/);
    expect(() => NW.nextNavState({ messages: { lastCount: null } }, { counts: { messages: 1 }, top: null }, NOW)).toThrow(TypeError);
    expect(() => NW.nextNavState(null, { counts: {}, top: null }, 'now')).toThrow(TypeError);
  });
});

describe('inboxBadgeText', () => {
  const state = baseline({ messages: 2, invitations: 5, activity: 9 });

  it('sums only the counters the user turned on', () => {
    expect(NW.inboxBadgeText(state, normalizeSettings(null))).toBe('7');
    expect(NW.inboxBadgeText(state, normalizeSettings({ activityNotifications: true }))).toBe('16');
    expect(NW.inboxBadgeText(state, normalizeSettings({ messageNotifications: false, invitationNotifications: false }))).toBe('');
  });

  it('caps at 99+', () => {
    expect(NW.inboxBadgeText(baseline({ messages: 500, invitations: 0, activity: 0 }), normalizeSettings(null))).toBe('99+');
  });

  it('is empty with no state yet', () => {
    expect(NW.inboxBadgeText(null, normalizeSettings(null))).toBe('');
  });
});

describe('isWithinQuietHours', () => {
  const quiet = normalizeSettings({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '09:00' });
  const at = (h, m = 0) => new Date(2026, 9, 15, h, m);

  it('covers a window that wraps midnight', () => {
    expect(NW.isWithinQuietHours(at(23), quiet)).toBe(true);
    expect(NW.isWithinQuietHours(at(3), quiet)).toBe(true);
    expect(NW.isWithinQuietHours(at(22, 0), quiet)).toBe(true);
    expect(NW.isWithinQuietHours(at(8, 59), quiet)).toBe(true);
    expect(NW.isWithinQuietHours(at(9, 0), quiet)).toBe(false);
    expect(NW.isWithinQuietHours(at(14), quiet)).toBe(false);
  });

  it('covers a same-day window', () => {
    const lunch = normalizeSettings({ quietHoursEnabled: true, quietHoursStart: '13:00', quietHoursEnd: '14:00' });
    expect(NW.isWithinQuietHours(at(13, 30), lunch)).toBe(true);
    expect(NW.isWithinQuietHours(at(12, 59), lunch)).toBe(false);
    expect(NW.isWithinQuietHours(at(14, 0), lunch)).toBe(false);
  });

  it('is off when disabled or when start equals end', () => {
    expect(NW.isWithinQuietHours(at(23), normalizeSettings(null))).toBe(false);
    const same = normalizeSettings({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '22:00' });
    expect(NW.isWithinQuietHours(at(22), same)).toBe(false);
  });
});

describe('settings', () => {
  it('defaults: messages and invitations on, bell off, badge off, quiet hours off', () => {
    expect(normalizeSettings(null)).toEqual({
      messageNotifications: true,
      invitationNotifications: true,
      activityNotifications: false,
      badgeShowsLinkedInCounts: false,
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
    });
    expect(DEFAULT_SETTINGS.messageNotifications).toBe(true);
  });

  it('every nav target has a setting key that exists', () => {
    for (const target of NW.NAV_TARGETS) expect(DEFAULT_SETTINGS).toHaveProperty(target.settingKey);
  });

  it('keeps a stored value and fills a missing key with its default', () => {
    expect(normalizeSettings({ messageNotifications: false }).messageNotifications).toBe(false);
    expect(normalizeSettings({}).invitationNotifications).toBe(true);
  });

  it('raises on an unknown key, a wrong type or a bad time instead of ignoring it', () => {
    expect(() => normalizeSettings({ messageNotification: false })).toThrow(/unknown keys/);
    expect(() => normalizeSettings({ messageNotifications: 'yes' })).toThrow(TypeError);
    expect(() => normalizeSettings({ quietHoursStart: '25:00' })).toThrow(/HH:MM/);
    expect(() => normalizeSettings({ quietHoursEnd: '9:00' })).toThrow(/HH:MM/);
    expect(() => normalizeSettings([])).toThrow(TypeError);
  });
});
