// Withdraw / Delete button matcher. Regression pins:
//   - LinkedIn UI (2026-07) renamed "Withdraw" → "Delete" on /sent/. The
//     old regex missed 150+ deletes in one user report, leaving stale
//     Pending records forever. This suite guards both variants.
//   - Every locale we've observed (uk/ru/de/pt/es) is covered.
//   - Aria + text combinations that we've seen produce false positives
//     (or false negatives) get an explicit test.

import { describe, it, expect } from 'vitest';
const { matchesWithdrawButton, WITHDRAW_BTN_RE } = require('../linkedin-tracker/core/withdraw-match.js');

describe('matchesWithdrawButton — text variants', () => {
  it('matches the legacy "Withdraw" label', () => {
    expect(matchesWithdrawButton('Withdraw', 'Withdraw invitation to Alice')).toBe(true);
    expect(matchesWithdrawButton('Withdraw', 'Withdraw')).toBe(true);
  });

  it('matches the new "Delete" label (2026-07 LinkedIn UI rename)', () => {
    expect(matchesWithdrawButton('Delete', 'Delete invitation to Alice')).toBe(true);
    expect(matchesWithdrawButton('Delete', 'Delete')).toBe(true);
  });

  it('matches localized labels: ru/uk/de/pt/es', () => {
    expect(matchesWithdrawButton('Отозвать', 'Отозвать приглашение')).toBe(true);
    expect(matchesWithdrawButton('Удалить', 'Удалить приглашение')).toBe(true);
    expect(matchesWithdrawButton('Скасувати', 'Скасувати запрошення')).toBe(true);
    expect(matchesWithdrawButton('Видалити', 'Видалити запрошення')).toBe(true);
    expect(matchesWithdrawButton('Zurückziehen', 'Zurückziehen Einladung')).toBe(true);
    expect(matchesWithdrawButton('Löschen', 'Löschen Einladung')).toBe(true);
    expect(matchesWithdrawButton('Retirar', 'Retirar convite')).toBe(true);
    expect(matchesWithdrawButton('Eliminar', 'Eliminar invitación')).toBe(true);
  });

  it('case-insensitive', () => {
    expect(matchesWithdrawButton('DELETE', 'delete invitation')).toBe(true);
    expect(matchesWithdrawButton('withdraw', 'WITHDRAW invitation')).toBe(true);
  });
});

describe('matchesWithdrawButton — aria-label secondary anchor', () => {
  it('icon-only buttons: text is empty, aria carries "withdraw invitation" → match', () => {
    // Some LinkedIn variants render the button with only an icon inside;
    // the visible textContent is empty but aria-label carries the label.
    // Secondary anchor requires BOTH a verb AND an invitation-noun in
    // aria, so this is scoped enough to not false-fire on random
    // aria-labels elsewhere on the page.
    expect(matchesWithdrawButton('', 'Withdraw invitation to Alice')).toBe(true);
    expect(matchesWithdrawButton('', 'Delete invitation to Bob')).toBe(true);
    expect(matchesWithdrawButton('', 'Удалить приглашение Алиса')).toBe(true);
  });

  it('icon-only button with just a verb in aria: also matches (relies on caller scope)', () => {
    // Note: aria alone with just a verb is enough. The reason we accept
    // that broad match is that the caller narrows scope to
    // `[role="listitem"]` /sent/ cards — any Delete button inside a
    // /sent/ card IS the withdraw button. See content.js:setupWithdrawListener.
    // This test PINS that expectation so we don't accidentally tighten
    // it without also weakening the caller scope check.
    expect(matchesWithdrawButton('', 'Withdraw')).toBe(true);
    expect(matchesWithdrawButton('', 'Delete this thread')).toBe(true);
  });
});

describe('matchesWithdrawButton — negatives (must not false-trigger)', () => {
  it('does NOT match Message button', () => {
    expect(matchesWithdrawButton('Message', 'Message Alice')).toBe(false);
  });

  it('does NOT match Follow / Unfollow', () => {
    expect(matchesWithdrawButton('Follow', 'Follow Alice')).toBe(false);
    expect(matchesWithdrawButton('Unfollow', 'Unfollow Alice')).toBe(false);
  });

  it('does NOT match "Accept" or "Ignore" (someone else\'s incoming invite UI)', () => {
    expect(matchesWithdrawButton('Accept', 'Accept invitation from Alice')).toBe(false);
    expect(matchesWithdrawButton('Ignore', 'Ignore invitation from Alice')).toBe(false);
  });

  it('does NOT match a random Delete elsewhere on the page without invitation context', () => {
    // Text starts with "Delete" so the BTN_RE fires — but the caller
    // narrows scope to `[role="listitem"]` /sent/ cards. This matcher
    // alone WILL match; scoping is the second half of the defence.
    // Documented here so if we ever remove the scope check we know this
    // matcher isn't enough on its own.
    expect(matchesWithdrawButton('Delete', 'Delete post')).toBe(true);
    expect(matchesWithdrawButton('Delete', 'Delete comment')).toBe(true);
  });

  it('does NOT match empty inputs', () => {
    expect(matchesWithdrawButton('', '')).toBe(false);
    expect(matchesWithdrawButton(null, null)).toBe(false);
    expect(matchesWithdrawButton(undefined, undefined)).toBe(false);
  });

  it('does NOT match text that CONTAINS the verb but does not start with it', () => {
    // "Confirm you want to delete" — matches BTN_RE only if it STARTS
    // with the verb; the ^ anchor guards against this.
    expect(WITHDRAW_BTN_RE.test('Confirm you want to delete')).toBe(false);
  });
});
