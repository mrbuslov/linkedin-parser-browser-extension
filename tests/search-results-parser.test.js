import { describe, it, expect, beforeEach } from 'vitest';
import { extractMutualsList } from '../linkedin-tracker/core/search-results-parser.js';
import { normalizeProfileUrl } from '../linkedin-tracker/core/url.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('extractMutualsList — pure DOM parsing', () => {
  it('extracts {name, profileUrl} for each unique profile anchor', () => {
    document.body.innerHTML = `
      <main>
        <a href="https://www.linkedin.com/in/alice/">Alice Smith</a>
        <a href="https://www.linkedin.com/in/bob/">Bob Jones</a>
      </main>
    `;
    const list = extractMutualsList(document.querySelector('main'), normalizeProfileUrl);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: 'Alice Smith', profileUrl: 'https://www.linkedin.com/in/alice/' });
    expect(list[1]).toMatchObject({ name: 'Bob Jones', profileUrl: 'https://www.linkedin.com/in/bob/' });
  });

  it('strips trailing "• 1st"/"• 2nd"/"• 3rd" degree marker from the name', () => {
    document.body.innerHTML = `<main><a href="https://www.linkedin.com/in/alice/">Alice Smith • 1st</a></main>`;
    const list = extractMutualsList(document.querySelector('main'), normalizeProfileUrl);
    expect(list[0].name).toBe('Alice Smith');
  });

  it('strips "Premium" badge label from the name', () => {
    document.body.innerHTML = `<main><a href="https://www.linkedin.com/in/alice/">Alice Smith Premium • 1st</a></main>`;
    const list = extractMutualsList(document.querySelector('main'), normalizeProfileUrl);
    expect(list[0].name).toBe('Alice Smith');
  });

  it('dedupes by canonical profileUrl when multiple anchors point to the same profile', () => {
    // Real LinkedIn renders the name anchor and avatar anchor as separate
    // <a> tags both pointing to the same profile.
    document.body.innerHTML = `
      <main>
        <a href="https://www.linkedin.com/in/alice/"><img src="data:image/png;base64,x" /></a>
        <a href="https://www.linkedin.com/in/alice/">Alice Smith</a>
      </main>
    `;
    const list = extractMutualsList(document.querySelector('main'), normalizeProfileUrl);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Alice Smith');
  });

  it('picks up profile-displayphoto avatar from a sibling <img>', () => {
    document.body.innerHTML = `
      <main>
        <div class="card">
          <a href="https://www.linkedin.com/in/alice/"><img src="https://media.licdn.com/dms/image/profile-displayphoto-scale_100/x.png" /></a>
          <a href="https://www.linkedin.com/in/alice/">Alice Smith</a>
        </div>
      </main>
    `;
    const list = extractMutualsList(document.querySelector('main'), normalizeProfileUrl);
    expect(list[0].avatar).toContain('profile-displayphoto');
  });

  it('skips anchors with empty/whitespace-only text (image-only wrappers)', () => {
    document.body.innerHTML = `
      <main>
        <a href="https://www.linkedin.com/in/alice/">  </a>
        <a href="https://www.linkedin.com/in/bob/">Bob Jones</a>
      </main>
    `;
    const list = extractMutualsList(document.querySelector('main'), normalizeProfileUrl);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Bob Jones');
  });

  it('returns [] for an empty scope and for null root', () => {
    expect(extractMutualsList(document.body, normalizeProfileUrl)).toEqual([]);
    expect(extractMutualsList(null, normalizeProfileUrl)).toEqual([]);
  });
});

describe('extractMutualsList — real LinkedIn fixture (common-connections-search.html)', () => {
  // The fixture is the bounded role="list" results section from a real
  // /search/results/people/?...connectionOf=... visit. It carries exactly
  // 10 result cards (LinkedIn renders 10 per page) plus the inner
  // mutuals-of-mutuals carousel noise that the legacy parser used to
  // sweep up. Anchor: each card wraps in `componentkey="SearchResults<URN>"`.
  let list;
  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(
      path.resolve(__dirname, 'fixtures/common-connections-search.html'),
      'utf8'
    );
    document.body.innerHTML = html;
    list = extractMutualsList(document.body, normalizeProfileUrl);
  });

  it('parses exactly 10 results (LinkedIn renders 10 per search page)', () => {
    expect(list).toHaveLength(10);
  });

  it('includes the three target names the user flagged in the bug report', () => {
    // Regression for "ты неправильно парсишь общих конекшенов / temp/common-connections.html":
    // these are the actual search results; the OLD parser missed/diluted
    // them by scanning every <a href="/in/..."> on the page including the
    // mutuals-of-mutuals chips inside each card.
    const names = list.map((x) => x.name);
    expect(names).toContain('Andrés Lacruz');
    expect(names).toContain('Naw Caroline');
    expect(names).toContain('Natasa Budisin');
  });

  it('does NOT include connections-of-connections noise (kat boogaard etc.)', () => {
    // Noise vanities that appeared in the OLD parser's output but are NOT
    // actual top-level search results — they were mentioned inside other
    // result cards' mutual-connections lists.
    const urls = list.map((x) => x.profileUrl);
    expect(urls.every((u) => !u.includes('/in/katboogaard'))).toBe(true);
    expect(urls.every((u) => !u.includes('/in/martinarusso'))).toBe(true);
    expect(urls.every((u) => !u.includes('/in/patrice-dussault'))).toBe(true);
  });

  it('every result has a non-empty profileUrl and clean name (no degree/Premium marker)', () => {
    for (const item of list) {
      expect(item.name).toBeTruthy();
      expect(item.profileUrl).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
      expect(item.name).not.toMatch(/•\s*1st|2nd|3rd/i);
      expect(item.name).not.toMatch(/\bPremium\b/);
    }
  });

  it('avatars carry the profile-displayphoto substring when present', () => {
    // LinkedIn omits the avatar for profiles with no photo (placeholder
    // initials instead of an <img>). When the avatar IS rendered, its URL
    // contains the language/class-stable `profile-displayphoto` substring.
    const withAvatar = list.filter((x) => x.avatar);
    expect(withAvatar.length).toBeGreaterThan(0);
    for (const item of withAvatar) {
      expect(item.avatar).toMatch(/profile-displayphoto/);
    }
  });
});
