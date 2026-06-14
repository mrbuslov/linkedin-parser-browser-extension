import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ActivityParser = require('../linkedin-tracker/core/activity-parser.js');
const {
  extractActivity,
  mergeRecentActivity,
  parseRelativeTimeMs,
  findActivitySection,
} = ActivityParser;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

describe('parseRelativeTimeMs', () => {
  it('parses minute/hour/day/week/month/year units', () => {
    expect(parseRelativeTimeMs('5m')).toBe(5 * 60_000);
    expect(parseRelativeTimeMs('3h')).toBe(3 * 3_600_000);
    expect(parseRelativeTimeMs('4d')).toBe(4 * 86_400_000);
    expect(parseRelativeTimeMs('2w')).toBe(2 * 604_800_000);
    expect(parseRelativeTimeMs('1mo')).toBe(2_592_000_000);
    expect(parseRelativeTimeMs('5mo')).toBe(5 * 2_592_000_000);
    expect(parseRelativeTimeMs('1y')).toBe(31_536_000_000);
  });
  it('ignores surrounding whitespace and bullet separators', () => {
    expect(parseRelativeTimeMs('  4d ')).toBe(4 * 86_400_000);
    expect(parseRelativeTimeMs('1mo •')).toBe(2_592_000_000);
  });
  it('returns null on unparseable input', () => {
    expect(parseRelativeTimeMs('')).toBeNull();
    expect(parseRelativeTimeMs(null)).toBeNull();
    expect(parseRelativeTimeMs('foo')).toBeNull();
    // We deliberately do not invent a "minute" fallback for the bare "m" suffix
    // when no digit precedes it — that's not what LinkedIn renders.
    expect(parseRelativeTimeMs('mo')).toBeNull();
  });
});

describe('mergeRecentActivity', () => {
  it('returns fresh when no existing', () => {
    const fresh = [{ urnActivityId: '1', postedAt: '2026-06-12T00:00:00.000Z' }];
    expect(mergeRecentActivity([], fresh)).toEqual(fresh);
  });
  it('dedupes by urnActivityId, fresh overrides existing', () => {
    const existing = [{ urnActivityId: '1', postedAt: '2026-06-10T00:00:00.000Z', text: 'old' }];
    const fresh    = [{ urnActivityId: '1', postedAt: '2026-06-12T00:00:00.000Z', text: 'new' }];
    expect(mergeRecentActivity(existing, fresh)).toEqual([
      { urnActivityId: '1', postedAt: '2026-06-12T00:00:00.000Z', text: 'new' },
    ]);
  });
  it('caps at max and sorts by postedAt desc', () => {
    const items = [
      { urnActivityId: '1', postedAt: '2026-06-01T00:00:00.000Z' },
      { urnActivityId: '2', postedAt: '2026-06-10T00:00:00.000Z' },
      { urnActivityId: '3', postedAt: '2026-06-05T00:00:00.000Z' },
      { urnActivityId: '4', postedAt: '2026-06-12T00:00:00.000Z' },
      { urnActivityId: '5', postedAt: '2026-06-03T00:00:00.000Z' },
      { urnActivityId: '6', postedAt: '2026-06-11T00:00:00.000Z' },
    ];
    const result = mergeRecentActivity([], items, 5);
    expect(result.map((c) => c.urnActivityId)).toEqual(['4', '6', '2', '3', '5']);
  });
  it('drops entries without postedAt (defensive against legacy records)', () => {
    const items = [
      { urnActivityId: '1' },
      { urnActivityId: '2', postedAt: '2026-06-10T00:00:00.000Z' },
    ];
    expect(mergeRecentActivity([], items)).toHaveLength(1);
  });
});

describe('extractActivity — lija-activity-section.html (single-author profile)', () => {
  let result;
  // All cards in this fixture are authored by "Lija T." (profile owner). Time
  // markers seen in the fixture: 4d, 1mo, 4mo, 4mo, 5mo, 5mo, 5mo, 5mo, 5mo, 6mo.
  // We pin `now` so the test is deterministic across runs.
  const NOW = Date.UTC(2026, 5, 14);  // 2026-06-14T00:00:00Z
  beforeAll(() => {
    const dom = new JSDOM(fx('lija-activity-section.html'));
    result = extractActivity(dom.window.document.body, 'Lija T.', NOW);
  });

  it('returns 5 cards (max cap)', () => {
    expect(result.recentActivity).toHaveLength(5);
  });

  it('every card has the canonical fields', () => {
    for (const c of result.recentActivity) {
      expect(c.urnActivityId).toMatch(/^\d{15,}$/);
      expect(c.url).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/update\//);
      expect(c.author).toBe('Lija T.');
      expect(c.type).toBe('post');
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(c.postedAtText).toMatch(/^\d+(mo|w|wk|d|h|m|y)$/);
    }
  });

  it('captures the full body text including the "translation agency" post', () => {
    const card = result.recentActivity.find((c) => c.urnActivityId === '7470098057225957376');
    expect(card).toBeTruthy();
    expect(card.text).toContain('A recent interaction with a translation agency reminded me');
    expect(card.text).toContain('Legitimacy and professionalism are not the same thing');
    // The "...more" expand button leaks no junk into the parsed body.
    expect(card.text).not.toMatch(/…more$|\.\.\.more$/);
  });

  it('sorts cards by postedAt desc (newest first)', () => {
    const dates = result.recentActivity.map((c) => c.postedAt);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  it('lastActivityAt and lastPostAt are both the freshest card (owner = author)', () => {
    expect(result.lastActivityAt).toBe(result.recentActivity[0].postedAt);
    expect(result.lastPostAt).toBe(result.recentActivity[0].postedAt);
  });

  it('postedAt is now - parseRelativeTimeMs(postedAtText) for each card', () => {
    for (const c of result.recentActivity) {
      const expected = new Date(NOW - parseRelativeTimeMs(c.postedAtText)).toISOString();
      expect(c.postedAt).toBe(expected);
    }
  });
});

describe('extractActivity — igor-activity-section.html (mixed authors)', () => {
  // Igor's Activity card has 6 different authors (own posts + reshares of
  // others). type='post' iff author === owner, type='share' otherwise.
  const NOW = Date.UTC(2026, 5, 14);
  let result;
  beforeAll(() => {
    const dom = new JSDOM(fx('igor-activity-section.html'));
    result = extractActivity(dom.window.document.body, 'Igor Alentyev', NOW);
  });

  it('classifies type correctly for own posts vs reshares', () => {
    for (const c of result.recentActivity) {
      if (c.author === 'Igor Alentyev') expect(c.type).toBe('post');
      else expect(c.type).toBe('share');
    }
  });

  it('lastActivityAt is freshest of ALL, lastPostAt is freshest OWN post', () => {
    expect(result.lastActivityAt).toBeTruthy();
    // lastPostAt may be null if none of the top-5 are own posts; otherwise it
    // must equal the postedAt of the freshest card with type=post.
    const ownPosts = result.recentActivity.filter((c) => c.type === 'post');
    if (ownPosts.length === 0) {
      expect(result.lastPostAt).toBeNull();
    } else {
      expect(result.lastPostAt).toBe(ownPosts[0].postedAt);
    }
    // lastActivityAt is always >= lastPostAt (newest of all >= newest of own)
    if (result.lastPostAt) {
      expect(result.lastActivityAt >= result.lastPostAt).toBe(true);
    }
  });
});

describe('extractActivity — degenerate inputs', () => {
  it('returns empty result when no Activity section in DOM', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><h2>Experience</h2></body></html>');
    const r = extractActivity(dom.window.document.body, 'Anyone', Date.now());
    expect(r).toEqual({ lastActivityAt: null, lastPostAt: null, recentActivity: [] });
  });

  it('throws when now is not a finite number', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    expect(() => extractActivity(dom.window.document.body, 'X', null))
      .toThrow(/numeric `now`/);
    expect(() => extractActivity(dom.window.document.body, 'X', NaN))
      .toThrow(/numeric `now`/);
    expect(() => extractActivity(dom.window.document.body, 'X', 'never'))
      .toThrow(/numeric `now`/);
  });
});

describe('findActivitySection — localized headings', () => {
  it('matches the English heading', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><section><h2>Activity</h2><div><span data-testid="expandable-text-box">x</span></div></section></body></html>');
    expect(findActivitySection(dom.window.document.body)).toBeTruthy();
  });
  it('matches Russian "Активность"', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><section><h2>Активность</h2><div><span data-testid="expandable-text-box">x</span></div></section></body></html>');
    expect(findActivitySection(dom.window.document.body)).toBeTruthy();
  });
  it('returns null when the activity section has no expandable bodies (e.g. profile has no posts yet)', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><section><h2>Activity</h2><p>This member hasn\'t posted yet</p></section></body></html>');
    expect(findActivitySection(dom.window.document.body)).toBeNull();
  });
});
