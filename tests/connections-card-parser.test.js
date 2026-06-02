// Regression tests for connections.js findCards/parseCard. The bug we're
// covering here is the new LinkedIn UI structure where name + headline live
// inside the SAME <a href="/in/..."> block — `link.textContent` for that link
// can be 150-300 chars long. The old `text.length > 100` filter dropped those
// cards entirely, silently losing them from the scan.
//
// We don't import connections.js (side-effectful entry); we replicate the
// pure-DOM portion of findCards/parseCard so the test exercises the actual
// extraction logic against jsdom fixtures.

import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeProfileUrl } from '../linkedin-tracker/core/url.js';

function extractNameFromLink(link) {
  for (const sel of ['h1', 'h2', 'h3', 'p']) {
    const el = link.querySelector(sel);
    if (!el) continue;
    const t = (el.textContent || '').trim();
    if (t && t.length > 1) return t;
  }
  return (link.textContent || '').trim();
}

function findCards() {
  const byUrl = new Map();
  for (const link of document.querySelectorAll('a[href*="/in/"]')) {
    const name = extractNameFromLink(link);
    if (!name) continue;
    const url = normalizeProfileUrl(link.href);
    if (!byUrl.has(url)) byUrl.set(url, { link, name });
  }
  return byUrl;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('findCards / extractNameFromLink — /connections/', () => {
  it('captures a card whose link nests name + headline (new LinkedIn UI)', () => {
    // REGRESSION (Mira "declines не ушли"): Luis/Ana/Bernardo had long
    // headlines, link.textContent exceeded 100 chars, old code dropped them.
    document.body.innerHTML = `
      <a href="https://www.linkedin.com/in/bernardo/">
        <figure><img src="..."></figure>
      </a>
      <a href="https://www.linkedin.com/in/bernardo/">
        <div>
          <p>Bernardo Neves</p>
          <div>
            <p><span>Internal Medicine MD | Clinical Analytics &amp; Value-Based Healthcare at Luz Saúde</span></p>
          </div>
        </div>
      </a>
      <p>Connected on May 28, 2026</p>
    `;
    const cards = findCards();
    expect(cards.size).toBe(1);
    const entry = cards.get('https://www.linkedin.com/in/bernardo/');
    expect(entry.name).toBe('Bernardo Neves');
  });

  it('still captures the older flat structure (just <a><h2>Name</h2></a>)', () => {
    document.body.innerHTML = `
      <a href="https://www.linkedin.com/in/jane/"><h2>Jane Doe</h2></a>
      <p>Connected on Apr 1, 2024</p>
    `;
    const cards = findCards();
    expect(cards.size).toBe(1);
    expect(cards.get('https://www.linkedin.com/in/jane/').name).toBe('Jane Doe');
  });

  it('skips avatar-only links that wrap a figure with no text', () => {
    document.body.innerHTML = `
      <a href="https://www.linkedin.com/in/bob/">
        <figure><img src="..."></figure>
      </a>
    `;
    const cards = findCards();
    expect(cards.size).toBe(0);
  });

  it('dedupes when both avatar-link and name-link point to the same profile', () => {
    document.body.innerHTML = `
      <a href="https://www.linkedin.com/in/dup/"><figure><img></figure></a>
      <a href="https://www.linkedin.com/in/dup/"><p>Dup Person</p></a>
      <a href="https://www.linkedin.com/in/dup/?utm=share"><p>Dup Person</p></a>
    `;
    const cards = findCards();
    expect(cards.size).toBe(1);
  });

  it('skips mutual-connections search links (href contains /search/, not /in/)', () => {
    document.body.innerHTML = `
      <a href="https://www.linkedin.com/search/results/people/?origin=...&connectionOf=...">
        <p><strong>Anton</strong>, <strong>Misha</strong> and 79 other mutual connections</p>
      </a>
      <a href="https://www.linkedin.com/in/carol/"><p>Carol</p></a>
    `;
    const cards = findCards();
    expect(cards.size).toBe(1);
    expect(cards.has('https://www.linkedin.com/in/carol/')).toBe(true);
  });

  it('does not truncate or drop cards regardless of name length (per "no hard caps" policy)', () => {
    const longText = 'X'.repeat(800);
    document.body.innerHTML = `
      <a href="https://www.linkedin.com/in/runaway/">
        ${longText}
      </a>
    `;
    const cards = findCards();
    expect(cards.size).toBe(1);
    const entry = cards.get('https://www.linkedin.com/in/runaway/');
    // We persist whatever text was there; no arbitrary length cap.
    expect(entry.name.length).toBeGreaterThan(500);
  });

  it('accepts long real-world headlines (Mira bug): captures cards up to ~500 chars without dropping', () => {
    // Bernardo's actual content: "Internal Medicine MD | Clinical Analytics &
    // Value-Based Healthcare at Luz Saúde" — 80 chars. With name attached,
    // link.textContent could be 100-200+ chars. We must not drop these.
    document.body.innerHTML = `
      <a href="https://www.linkedin.com/in/bernardo/">
        <p>Bernardo Neves</p>
        <p>Internal Medicine MD | Clinical Analytics &amp; Value-Based Healthcare at Luz Saúde | Senior Consultant | Board Member | International Conference Speaker</p>
      </a>
    `;
    const cards = findCards();
    expect(cards.size).toBe(1);
    expect(cards.get('https://www.linkedin.com/in/bernardo/').name).toBe('Bernardo Neves');
  });
});
