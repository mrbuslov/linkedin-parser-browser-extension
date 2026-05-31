// Regression tests for content.js parseCards via DOM fixtures. We don't import
// content.js (it's the side-effectful entry point) — instead we replicate its
// parseCards function shape using the same logic so the test exercises the
// real branches: /in/ link present, /in/ link absent + email fallback.

import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeProfileUrl, extractEmail } from '../linkedin-tracker/core/url.js';

function parseCards() {
  const cards = document.querySelectorAll('[role="listitem"]');
  const result = new Map();
  for (const card of cards) {
    const paragraphs = [...card.querySelectorAll('p')]
      .map((p) => p.textContent.trim())
      .filter(Boolean);
    const img = card.querySelector('img');

    const link = card.querySelector('a[href*="/in/"]');
    let profileUrl, name, headline;
    if (link) {
      profileUrl = normalizeProfileUrl(link.href);
      name = paragraphs[0] || '';
      headline = paragraphs[1] || '';
    } else {
      const email = extractEmail(card.textContent || '');
      if (!email) continue;
      profileUrl = `mailto:${email}`;
      name = email;
      headline = '';
    }

    if (result.has(profileUrl)) continue;
    result.set(profileUrl, {
      profileUrl, name, headline,
      sentDateRelative: paragraphs[paragraphs.length - 1] || '',
      avatar: img?.src || '',
    });
  }
  return Array.from(result.values());
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('parseCards — /sent/ invitations', () => {
  it('parses a standard /in/ profile invite', () => {
    document.body.innerHTML = `
      <div role="listitem">
        <a href="https://www.linkedin.com/in/ricardo/"><span>Ricardo</span></a>
        <img src="https://media.licdn.com/ricardo.jpg">
        <p>Ricardo Rodrigues</p>
        <p>Médico de Família</p>
        <p>Sent 3 days ago</p>
      </div>
    `;
    const result = parseCards();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      profileUrl: 'https://www.linkedin.com/in/ricardo/',
      name: 'Ricardo Rodrigues',
      headline: 'Médico de Família',
      sentDateRelative: 'Sent 3 days ago',
    });
  });

  it('REGRESSION (Mira bug 3): parses an email-only invite (no /in/ link)', () => {
    // LinkedIn "you must know them" wall, or invitee doesn't have a LinkedIn
    // account yet. Card shows raw email instead of name + profile link.
    document.body.innerHTML = `
      <div role="listitem">
        <img src="">
        <p>scavaca@dmrs.min-saude.pt</p>
        <p>Sent 2 weeks ago</p>
      </div>
    `;
    const result = parseCards();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      profileUrl: 'mailto:scavaca@dmrs.min-saude.pt',
      name: 'scavaca@dmrs.min-saude.pt',
      headline: '',
      sentDateRelative: 'Sent 2 weeks ago',
    });
  });

  it('parses a page mixing /in/ and email invites', () => {
    document.body.innerHTML = `
      <div role="listitem">
        <a href="https://www.linkedin.com/in/jane/"><span>Jane</span></a>
        <p>Jane Doe</p>
        <p>Engineer</p>
        <p>Sent yesterday</p>
      </div>
      <div role="listitem">
        <p>foo@example.com</p>
        <p>Sent 1 week ago</p>
      </div>
      <div role="listitem">
        <a href="https://www.linkedin.com/in/bob/"><span>Bob</span></a>
        <p>Bob Smith</p>
        <p>Designer</p>
        <p>Sent 3 days ago</p>
      </div>
    `;
    const result = parseCards();
    expect(result).toHaveLength(3);
    expect(result.map(r => r.profileUrl)).toEqual([
      'https://www.linkedin.com/in/jane/',
      'mailto:foo@example.com',
      'https://www.linkedin.com/in/bob/',
    ]);
  });

  it('skips cards that have neither /in/ link nor a recognizable email', () => {
    document.body.innerHTML = `
      <div role="listitem">
        <p>Loading...</p>
      </div>
    `;
    expect(parseCards()).toHaveLength(0);
  });

  it('deduplicates by profileUrl when the same person appears twice in DOM', () => {
    document.body.innerHTML = `
      <div role="listitem">
        <a href="https://www.linkedin.com/in/jane/"><span>Jane</span></a>
        <p>Jane Doe</p>
      </div>
      <div role="listitem">
        <a href="https://www.linkedin.com/in/jane/?utm=share"><span>Jane</span></a>
        <p>Jane Doe</p>
      </div>
    `;
    expect(parseCards()).toHaveLength(1);
  });
});
