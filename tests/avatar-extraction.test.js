import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

// Re-implements the avatar extraction from profile.js so we can pin it
// without spinning up the full content-script stack.
function extractAvatar(root) {
  const photoAnchor = root.querySelector('[aria-label="Profile photo"]');
  if (photoAnchor) {
    const img = photoAnchor.querySelector('img[src*=".licdn.com/"]');
    return img && img.src ? img.src : '';
  }
  for (const img of root.querySelectorAll('img[src]')) {
    if (/profile-(display|framed)photo/.test(img.src)) return img.src;
  }
  return '';
}

describe('avatar extraction — pinned to aria-label="Profile photo" anchor', () => {
  it('returns the img URL inside the Profile photo anchor when present', () => {
    const dom = new JSDOM(`
      <body>
        <main>
          <div aria-label="Profile photo">
            <figure><img src="https://media.licdn.com/dms/.../D4D03AQ_REAL/profile-displayphoto-scale_200.jpg"/></figure>
          </div>
          <!-- Decoy avatars elsewhere in the page — must NOT be picked -->
          <div class="featured-card"><img src="https://media.licdn.com/dms/.../D5603DECOY/profile-displayphoto-scale_100.jpg"/></div>
        </main>
      </body>
    `);
    expect(extractAvatar(dom.window.document.querySelector('main')))
      .toContain('D4D03AQ_REAL');
  });

  it('returns empty string when the Profile photo anchor exists but contains an SVG placeholder (user has no photo)', () => {
    // Costa Vasili case: aria-label="Profile photo" wraps a person-accent
    // SVG, not an <img>. Legacy parser was grabbing a stranger's avatar
    // from elsewhere in the top card; that's the bug we're killing here.
    const dom = new JSDOM(`
      <body>
        <main>
          <div aria-label="Profile photo">
            <figure><svg id="person-accent-4"></svg></figure>
          </div>
          <a><img src="https://media.licdn.com/dms/.../D5603STRANGER/profile-displayphoto-scale_100.jpg"/></a>
        </main>
      </body>
    `);
    expect(extractAvatar(dom.window.document.querySelector('main'))).toBe('');
  });

  it('returns the framedphoto URL (Hiring/OpenToWork/Verified frame) when present alongside SVG placeholder', () => {
    // Real Costa Vasili case: LinkedIn renders the SVG placeholder PLUS
    // the actual user photo overlaid on top inside the same Profile photo
    // anchor. The user uses LinkedIn's Hiring frame around their photo,
    // so the URL pattern is `profile-framedphoto` (not displayphoto).
    // Earlier version of this parser only matched `profile-displayphoto`
    // and missed the framed variant — saved empty / a stranger's avatar.
    const dom = new JSDOM(`
      <body>
        <main>
          <div aria-label="Profile photo">
            <figure><svg id="person-accent-4"></svg></figure>
            <img class="overlay" src="https://media.licdn.com/dms/image/v2/D5635AQHPGzLx4rhMvQ/profile-framedphoto-shrink_200_200/x.jpg"/>
          </div>
        </main>
      </body>
    `);
    expect(extractAvatar(dom.window.document.querySelector('main')))
      .toContain('profile-framedphoto');
  });

  it('costa-vasili real-HTML fixture: returns the framedphoto URL inside the Profile photo anchor', () => {
    const html = readFileSync('tests/fixtures/costa-vasili-topcard.html', 'utf8');
    const dom = new JSDOM(html);
    const url = extractAvatar(dom.window.document.body);
    expect(url).toMatch(/profile-framedphoto/);
    expect(url).toContain('D5635AQHPGzLx4rhMvQ');
  });

  it('falls back to legacy first-displayphoto-in-scope when the Profile photo anchor is missing entirely', () => {
    const dom = new JSDOM(`
      <body>
        <main>
          <a><img src="https://media.licdn.com/dms/.../D4D03LEGACY/profile-displayphoto-scale_200.jpg"/></a>
        </main>
      </body>
    `);
    expect(extractAvatar(dom.window.document.querySelector('main')))
      .toContain('D4D03LEGACY');
  });
});
