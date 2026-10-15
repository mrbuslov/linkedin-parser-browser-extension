// New-message detection. Fixtures are real DOM captured 2026-10-15 from both
// LinkedIn shells; the "Sales Navigator badge" case is the bug this pins:
// that link's badge, and the "(8)" it also puts in document.title, have
// nothing to do with messages.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MW = require('../linkedin-tracker/core/message-watch.js');
const { normalizeSettings, DEFAULT_SETTINGS } = require('../linkedin-tracker/core/settings.js');

const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const mount = (html) => { document.body.innerHTML = html; return document; };

const NOW = 1_760_000_000_000;

beforeEach(() => { document.body.innerHTML = ''; });

describe('readUnreadCount — React shell (aria-label)', () => {
  it('reads the count out of the messaging link, not the neighbouring links', () => {
    expect(MW.readUnreadCount(mount(fixture('messaging-nav-react.html')))).toBe(4);
  });

  it('reads zero when LinkedIn says zero', () => {
    const doc = mount(fixture('messaging-nav-react.html').replace('Messaging, 4 new', 'Messaging, 0 new'));
    expect(MW.readUnreadCount(doc)).toBe(0);
  });
});

describe('readUnreadCount — Ember shell (artdeco badge)', () => {
  it('reads the badge count on the messaging link', () => {
    expect(MW.readUnreadCount(mount(fixture('messaging-nav-ember.html')))).toBe(2);
  });

  it('does NOT pick up the Sales Navigator badge when messaging has no count', () => {
    const html = fixture('messaging-nav-ember.html')
      .replace('<span class="notification-badge__count" aria-hidden="true">2</span>', '')
      .replace('2 new message notifications', '');
    expect(MW.readUnreadCount(mount(html))).toBe(0);
  });

  it('reads zero from the real no-count badge', () => {
    expect(MW.readUnreadCount(mount(fixture('messaging-nav-ember-empty.html')))).toBe(0);
  });
});

describe('readUnreadCount — anchors gone', () => {
  it('returns null when there is no messaging link at all', () => {
    expect(MW.readUnreadCount(mount('<header><a href="/feed/">Home</a></header>'))).toBeNull();
  });

  it('returns null rather than guessing when the link has an aria-label without a number', () => {
    expect(MW.readUnreadCount(mount('<a href="/messaging/" aria-label="Messaging"></a>'))).toBeNull();
  });

  it('returns null for an unknown shell: no aria-label and no li-icon', () => {
    expect(MW.readUnreadCount(mount('<a href="/messaging/"><span>Messaging</span></a>'))).toBeNull();
  });
});

describe('readTopConversation', () => {
  it('reads name, time and the visible snippet of the first row', () => {
    expect(MW.readTopConversation(mount(fixture('messaging-conversation-list.html')))).toEqual({
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
    const top = MW.readTopConversation(doc);
    expect(top.preview).not.toBe(timeText);
    expect(top.preview).toBe('Alice: sure, send the file over tomorrow');
  });

  it('returns null when a row has no text beyond its timestamp', () => {
    const doc = mount(fixture('messaging-conversation-list.html'));
    for (const p of doc.querySelectorAll('li:first-child p')) p.remove();
    for (const span of doc.querySelectorAll('li:first-child span')) {
      if (!/9:22 AM|Example/.test(span.textContent)) span.remove();
    }
    expect(MW.readTopConversation(doc)).toBeNull();
  });

  it('returns null when the page has no conversation list', () => {
    expect(MW.readTopConversation(mount(fixture('messaging-nav-react.html')))).toBeNull();
  });

  it('returns null for a short list (a dropdown is not the conversation list)', () => {
    const html = fixture('messaging-conversation-list.html');
    const firstRowEnd = html.indexOf('</li>') + 5;
    expect(MW.readTopConversation(mount(html.slice(0, firstRowEnd) + '</ul>'))).toBeNull();
  });
});

describe('observe', () => {
  it('combines count and top conversation on a messaging page', () => {
    const doc = mount(fixture('messaging-nav-ember.html') + fixture('messaging-conversation-list.html'));
    expect(MW.observe(doc)).toEqual({
      unread: 2,
      top: { name: 'Alice Example', time: '9:22 AM', preview: 'Alice: sure, send the file over tomorrow' },
    });
  });

  it('returns null when the count cannot be read', () => {
    expect(MW.observe(mount('<div>no linkedin header here</div>'))).toBeNull();
  });
});

describe('nextWatchState', () => {
  const top = { name: 'Alice Example', time: '9:22 AM', preview: 'Alice: sure' };

  it('first observation only takes a baseline — no notification for old unread mail', () => {
    const r = MW.nextWatchState(null, { unread: 3, top }, NOW);
    expect(r.notification).toBeNull();
    expect(r.state).toEqual({ lastUnread: 3, lastConversationKey: 'Alice Example|9:22 AM|Alice: sure', updatedAt: NOW });
  });

  it('notifies with sender and snippet when the count grows and the top row is new', () => {
    const previous = { lastUnread: 0, lastConversationKey: 'Bob Example|Oct 14|You: thanks', updatedAt: NOW - 1000 };
    const r = MW.nextWatchState(previous, { unread: 1, top }, NOW);
    expect(r.notification).toEqual({ title: 'Alice Example', body: 'Alice: sure' });
  });

  it('falls back to a count-only notification when the top row did not change', () => {
    const key = 'Alice Example|9:22 AM|Alice: sure';
    const r = MW.nextWatchState({ lastUnread: 1, lastConversationKey: key, updatedAt: NOW }, { unread: 2, top }, NOW);
    expect(r.notification).toEqual({ title: 'New LinkedIn message', body: '2 unread conversations' });
  });

  it('says "conversation" in the singular', () => {
    const r = MW.nextWatchState({ lastUnread: 0, lastConversationKey: null, updatedAt: NOW }, { unread: 1, top: null }, NOW);
    expect(r.notification.body).toBe('1 unread conversation');
  });

  it('stays silent when the count does not grow (reading a message lowers it)', () => {
    const previous = { lastUnread: 3, lastConversationKey: null, updatedAt: NOW };
    expect(MW.nextWatchState(previous, { unread: 3, top: null }, NOW).notification).toBeNull();
    expect(MW.nextWatchState(previous, { unread: 0, top: null }, NOW).notification).toBeNull();
  });

  it('stays silent on my own sent message: the badge does not move, only the top row does', () => {
    const previous = { lastUnread: 0, lastConversationKey: 'Alice Example|9:20 AM|Alice: hi', updatedAt: NOW };
    const mine = { name: 'Alice Example', time: '9:22 AM', preview: 'You: on it' };
    expect(MW.nextWatchState(previous, { unread: 0, top: mine }, NOW).notification).toBeNull();
  });

  it('rejects a malformed observation instead of notifying about junk', () => {
    expect(() => MW.nextWatchState(null, { unread: -1, top: null }, NOW)).toThrow(TypeError);
    expect(() => MW.nextWatchState(null, { unread: 1.5, top: null }, NOW)).toThrow(TypeError);
    expect(() => MW.nextWatchState(null, { unread: 1, top: { name: 'A', time: '', preview: 'x' } }, NOW)).toThrow(TypeError);
    expect(() => MW.nextWatchState(null, { unread: 1, top: { name: 'A', time: 'b', preview: 'c', extra: 1 } }, NOW)).toThrow(/unknown keys/);
    expect(() => MW.nextWatchState({ lastUnread: null }, { unread: 1, top: null }, NOW)).toThrow(TypeError);
    expect(() => MW.nextWatchState(null, { unread: 1, top: null }, 'now')).toThrow(TypeError);
  });
});

describe('settings', () => {
  it('defaults message notifications to on', () => {
    expect(normalizeSettings(null)).toEqual({ messageNotifications: true });
    expect(DEFAULT_SETTINGS.messageNotifications).toBe(true);
  });

  it('keeps a stored value and fills a missing key with its default', () => {
    expect(normalizeSettings({ messageNotifications: false })).toEqual({ messageNotifications: false });
    expect(normalizeSettings({})).toEqual({ messageNotifications: true });
  });

  it('raises on an unknown key or a wrong type instead of silently ignoring it', () => {
    expect(() => normalizeSettings({ messageNotification: false })).toThrow(/unknown keys/);
    expect(() => normalizeSettings({ messageNotifications: 'yes' })).toThrow(TypeError);
    expect(() => normalizeSettings([])).toThrow(TypeError);
  });
});
