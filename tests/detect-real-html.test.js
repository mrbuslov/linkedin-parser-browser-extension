import { describe, it, expect, beforeEach } from 'vitest';
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
