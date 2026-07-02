import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectConnectionStatus } from '../linkedin-tracker/core/detect.js';

beforeEach(() => { document.body.innerHTML = ''; });

// Real-world regression fixture from a 1st-degree contact where the user
// reported the profile being deleted from Accepted after a profile visit.
// Key features: h2 name, `· 1st` text, NO Connect/Follow/Pending buttons,
// `/messaging/compose/` link, "500+ connections" text in a sub-link, mutual-
// connections section with a `connectionOf=` link.
const ANASTASIA_HTML = `
  <main>
    <a href="https://www.linkedin.com/in/annmahh/">
      <h2>Anastasia Novitskaya</h2>
    </a>
    <p>· 1st</p>
    <div><p>· 2nd</p></div>
    <p>IT Recruiter with a technical background and PhD research in AI-driven recruitment</p>
    <p>AlumniHub · National Research Nuclear University MEPhI</p>
    <p>Tel Aviv-Yafo, Tel Aviv District, Israel</p>
    <p>·</p>
    <p><a href="#">Contact info</a></p>
    <div role="button"><p><span>AlumniHub</span></p></div>
    <div role="button"><p><span>National Research Nuclear University MEPhI</span></p></div>
    <p>8,884 followers</p>
    <p>·</p>
    <a href="https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&connectionOf=..."><p>500+ connections</p></a>
    <a href="https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&network=%5B%22F%22%5D&connectionOf=...">
      <ul>
        <li><figure><svg></svg></figure></li>
        <li><figure><svg></svg></figure></li>
      </ul>
      <p><span><a href="..." target="_blank">
        <strong>Anton</strong>, <strong>Mikhail</strong> and 79 other mutual connections
      </a></span></p>
    </a>
    <a href="/messaging/compose/?profileUrn=urn%3Ali%3Afsd_profile%3AACoAADk8wVgBWargxVJvOLwMULwE0VydDu4FR0o&recipient=ACoAADk8wVgBWargxVJvOLwMULwE0VydDu4FR0o">
      <span>Message</span>
    </a>
    <button><span>More</span></button>
  </main>
`;

describe('detectConnectionStatus — real-world Anastasia 1st-degree fixture', () => {
  it('returns "connected" for a 1st-degree profile with mutual connections section', () => {
    document.body.innerHTML = ANASTASIA_HTML;
    const root = document.querySelector('main');
    expect(detectConnectionStatus(root)).toBe('connected');
  });
});

// Wendy Pease — real profile saved by the user from a running LinkedIn
// session. She's in the user's 1st-degree connections but the extension
// kept classifying her as 'visited' — that stale status combined with
// the STATUS-collision bug (which prevented profile visits from being
// persisted at all in the 1.3.x window). Once the collision is fixed
// and profile.js runs, the detector MUST return 'connected' or she'll
// stay stuck in Viewed. The aria-degree signal on her top-card is
// "Wendy Pease 🌍 Premium Profile 1st".
describe('detectConnectionStatus — Wendy Pease 1st-degree (full-page fixture)', () => {
  it('returns "connected" from the aria-degree signal on the real page', () => {
    const html = readFileSync(
      join(__dirname, 'fixtures/wendy-pease.html'), 'utf8',
    );
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    // Copy body into the test's document so detect can query it
    document.body.innerHTML = doc.body.innerHTML;

    // Sanity: the aria-degree anchor MUST be present in this fixture
    const ariaLabels = Array.from(document.querySelectorAll('[aria-label]'))
      .map((n) => n.getAttribute('aria-label'));
    const found1st = ariaLabels.find((a) => /\b1st\b\s*$/i.test(a));
    expect(found1st, 'expected an aria-label ending in "1st"').toBeDefined();

    expect(detectConnectionStatus(document.body)).toBe('connected');
  });
});

describe('detectConnectionStatus — Emirhan Karahasan pending 2nd-degree (fixture)', () => {
  it('returns "pending" — 2nd-degree profile with a real "Pending, click to withdraw..." button in the top-card', () => {
    const html = readFileSync(
      join(__dirname, 'fixtures/emirhan-karahasan.html'), 'utf8',
    );
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    document.body.innerHTML = doc.body.innerHTML;

    // Sanity: the Pending button IS in the DOM
    const pendingBtn = Array.from(document.querySelectorAll('[aria-label]'))
      .find((n) => /Pending.*withdraw invitation/i.test(n.getAttribute('aria-label') || ''));
    expect(pendingBtn, 'expected a Pending withdraw button in fixture').toBeDefined();

    expect(detectConnectionStatus(document.body)).toBe('pending');
  });

});
