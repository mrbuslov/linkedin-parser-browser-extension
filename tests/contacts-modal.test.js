import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseContactsModal,
  splitTrailingLabel,
} from '../linkedin-tracker/core/contacts-modal.js';

// Make decodeLinkedInRedirect available to contacts-modal.js the same way
// content scripts see it — via globalThis.LITUrl.
import * as LITUrlMod from '../linkedin-tracker/core/url.js';
globalThis.LITUrl = LITUrlMod;

const SCREEN = 'com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay';

function mountModal(innerHtml) {
  document.body.innerHTML = `<div data-sdui-screen="${SCREEN}">${innerHtml}</div>`;
  return document;
}

function section(label, valueHtml) {
  return `
    <div componentkey="${Math.random()}">
      <p>${label}</p>
      <p>${valueHtml}</p>
    </div>
  `;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('parseContactsModal', () => {
  it('returns null when modal is not in DOM', () => {
    document.body.innerHTML = '<main><h1>Just a profile, no modal</h1></main>';
    expect(parseContactsModal(document)).toBeNull();
  });

  it('returns null when modal is present but has no recognized sections', () => {
    mountModal('<div>something else entirely</div>');
    expect(parseContactsModal(document)).toBeNull();
  });

  it('extracts email from mailto link', () => {
    mountModal(section('Email', '<a href="mailto:foo@bar.com" target="_blank">foo@bar.com</a>'));
    expect(parseContactsModal(document)).toMatchObject({ email: 'foo@bar.com' });
  });

  it('lowercases email', () => {
    mountModal(section('Email', '<a href="mailto:Foo@Bar.COM">Foo@Bar.COM</a>'));
    expect(parseContactsModal(document).email).toBe('foo@bar.com');
  });

  it('extracts phone with parenthesized label', () => {
    mountModal(section('Phone',
      '<span>+375292999370</span><span> </span>(Home)'));
    const r = parseContactsModal(document);
    expect(r.phone).toBe('+375292999370');
    expect(r.phoneLabel).toBe('Home');
  });

  it('extracts phone without label', () => {
    mountModal(section('Phone', '<span>+1 415 555 0100</span>'));
    const r = parseContactsModal(document);
    expect(r.phone).toBe('+1 415 555 0100');
    expect(r.phoneLabel).toBeUndefined();
  });

  it('extracts website behind LinkedIn safety redirect', () => {
    // The safety redirect's `url=` param is the actual destination, urlencoded.
    const redirect = 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Ft%2Eme%2F%2Ba89_MGzNllpmZmUy&urlhash=2Sd1&isSdui=true';
    mountModal(section('Website',
      `<a href="${redirect}" target="_blank"><strong><span>t.me</span></strong></a><span> </span>(Blog)`));
    const r = parseContactsModal(document);
    expect(r.website).toBe('https://t.me/+a89_MGzNllpmZmUy');
    expect(r.websiteLabel).toBe('Blog');
  });

  it('extracts website without safety redirect (direct href)', () => {
    mountModal(section('Website',
      '<a href="https://example.com/blog">example.com</a>'));
    const r = parseContactsModal(document);
    expect(r.website).toBe('https://example.com/blog');
  });

  it('extracts address as plain text', () => {
    mountModal(section('Address', 'Минск'));
    expect(parseContactsModal(document).address).toBe('Минск');
  });

  it('extracts birthday as plain text', () => {
    mountModal(section('Birthday', 'December 31'));
    expect(parseContactsModal(document).birthday).toBe('December 31');
  });

  it('extracts connected-since text', () => {
    mountModal(section('Connected', 'May 14, 2026'));
    expect(parseContactsModal(document).connectedSinceText).toBe('May 14, 2026');
  });

  it('handles Russian labels (Email/Phone/Website/Address/Birthday)', () => {
    mountModal(
      section('Эл. почта',     '<a href="mailto:ru@x.com">ru@x.com</a>') +
      section('Телефон',       '<span>+7 999 123 4567</span> (Мобильный)') +
      section('Сайт',          '<a href="https://ru.example.com">ru.example.com</a>') +
      section('Адрес',         'Москва') +
      section('День рождения', '5 мая')
    );
    const r = parseContactsModal(document);
    expect(r.email).toBe('ru@x.com');
    expect(r.phone).toBe('+7 999 123 4567');
    expect(r.phoneLabel).toBe('Мобильный');
    expect(r.website).toBe('https://ru.example.com');
    expect(r.address).toBe('Москва');
    expect(r.birthday).toBe('5 мая');
  });

  it('handles Ukrainian labels', () => {
    mountModal(
      section('Електронна пошта', '<a href="mailto:ua@x.com">ua@x.com</a>') +
      section('Адреса',           'Київ')
    );
    const r = parseContactsModal(document);
    expect(r.email).toBe('ua@x.com');
    expect(r.address).toBe('Київ');
  });

  it('captures multiple websites (first stays primary, rest in extraWebsites)', () => {
    mountModal(
      section('Website', '<a href="https://primary.example">primary</a> (Personal)') +
      section('Website', '<a href="https://secondary.example">secondary</a> (Company)')
    );
    const r = parseContactsModal(document);
    expect(r.website).toBe('https://primary.example');
    expect(r.websiteLabel).toBe('Personal');
    expect(r.extraWebsites).toEqual([{ url: 'https://secondary.example', label: 'Company' }]);
  });

  it('full Mikhail-Kurilovich modal (real captured fixture, abridged)', () => {
    mountModal(
      section('Email',     '<a href="mailto:mihail.ne.promax@gmail.com">mihail.ne.promax@gmail.com</a>') +
      section('Phone',     '<span>+375292999370</span> (Home)') +
      section('Website',   '<a href="https://www.linkedin.com/safety/go/?url=https%3A%2F%2Ft%2Eme%2F%2Ba89_MGzNllpmZmUy&urlhash=2Sd1&isSdui=true">t.me</a> (Blog)') +
      section('Address',   'Минск') +
      section('Birthday',  'December 31') +
      section('Connected', 'May 14, 2026')
    );
    expect(parseContactsModal(document)).toEqual({
      email: 'mihail.ne.promax@gmail.com',
      phone: '+375292999370',
      phoneLabel: 'Home',
      website: 'https://t.me/+a89_MGzNllpmZmUy',
      websiteLabel: 'Blog',
      address: 'Минск',
      birthday: 'December 31',
      connectedSinceText: 'May 14, 2026',
    });
  });

  it('ignores unknown section labels', () => {
    mountModal(
      section('Some unknown field', 'whatever') +
      section('Email', '<a href="mailto:y@x.com">y@x.com</a>')
    );
    expect(parseContactsModal(document)).toEqual({ email: 'y@x.com' });
  });

  it('label normalization tolerates colons and extra whitespace', () => {
    mountModal(section('  Email:  ', '<a href="mailto:a@b.co">a@b.co</a>'));
    expect(parseContactsModal(document).email).toBe('a@b.co');
  });
});

describe('parseContactsModal — real LinkedIn HTML fixtures', () => {
  it('parses Igor Alentyev fixture (current 2026-06-11 LinkedIn markup)', () => {
    // Regression for "ничего не собрало, даже тултипа не было" — Igor's
    // profile uses the latest LinkedIn markup where the per-section
    // `componentkey` attribute was removed from the contact-info DOM.
    // The new parser anchors on SVG icon ids first (envelope-medium,
    // phone-handset-small, link-medium, calendar-medium, people-medium)
    // which are stable across LinkedIn UI rewrites. Label-text fallback
    // also covered.
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(
      path.resolve(__dirname, 'fixtures/igor-contacts-modal.html'),
      'utf8'
    );
    document.body.innerHTML = html;
    const result = parseContactsModal(document);
    expect(result).toBeTruthy();
    expect(result.email).toBe('igoralentyev@gmail.com');
    expect(result.phone).toBe('+37443066745');
    expect(result.phoneLabel).toBe('Mobile');
    expect(result.website).toBe('https://linktr.ee/igoralentyev');
    expect(result.websiteLabel).toBe('Personal');
    expect(result.extraWebsites).toEqual([
      { url: 'https://hirify.me', label: 'Company' },
    ]);
    expect(result.birthday).toBe('April 30');
    expect(result.connectedSinceText).toBe('Sep 16, 2025');
  });
});

describe('splitTrailingLabel', () => {
  it('splits value and parenthesized label', () => {
    expect(splitTrailingLabel('+375292999370 (Home)')).toEqual({ value: '+375292999370', label: 'Home' });
  });
  it('returns empty label when none present', () => {
    expect(splitTrailingLabel('just a value')).toEqual({ value: 'just a value', label: '' });
  });
  it('collapses whitespace', () => {
    expect(splitTrailingLabel('  foo   bar   (Tag)  ')).toEqual({ value: 'foo bar', label: 'Tag' });
  });
  it('handles empty/null input', () => {
    expect(splitTrailingLabel('')).toEqual({ value: '', label: '' });
    expect(splitTrailingLabel(null)).toEqual({ value: '', label: '' });
  });
});
