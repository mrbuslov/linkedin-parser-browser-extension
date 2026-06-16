import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';

// Re-implements the avatar extraction from profile.js so we can pin it
// without spinning up the full content-script stack.
function extractAvatar(root) {
  const photoAnchor = root.querySelector('[aria-label="Profile photo"]');
  if (photoAnchor) {
    const img = photoAnchor.querySelector('img[src*="profile-displayphoto"]');
    return img ? img.src : '';
  }
  for (const img of root.querySelectorAll('img[src]')) {
    if (img.src.includes('profile-displayphoto')) return img.src;
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

  it('costa-vasili real-HTML fixture: returns empty (he has no profile photo)', () => {
    const html = readFileSync('tests/fixtures/costa-vasili-topcard.html', 'utf8');
    const dom = new JSDOM(html);
    expect(extractAvatar(dom.window.document.body)).toBe('');
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
