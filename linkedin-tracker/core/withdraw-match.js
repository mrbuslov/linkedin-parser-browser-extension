// Matcher for the /sent/ page's Withdraw/Delete button. Extracted from
// content.js so the pattern is testable without wiring up jsdom for the
// full content-script bundle.
//
// Two anchors, both must match (belt-and-suspenders):
//   1) Button text starts with a WITHDRAW_VERB (i18n).
//   2) EITHER (a) same verb in aria-label, OR (b) aria-label contains an
//      invitation-related noun ("invitation" / "запрош" / "приглаш") plus
//      a verb.
//
// Scope check (must be inside a `[role="listitem"]` /sent/ card) lives in
// the caller — this file cares only about the button semantics.
//
// LinkedIn UI change (2026-07): the button label was renamed
// "Withdraw" → "Delete" in the English locale (other locales followed).
// The verb list below covers both variants and every locale we've seen —
// keep them in sync with the aria noun list below.
//
// Wrapped in IIFE — same reason as the other core/* files.

(function () {

const WITHDRAW_VERB_RE = /(withdraw|delete|отозвать|удалить|скасувати|видалити|zurückziehen|löschen|retirar|eliminar)/i;
const WITHDRAW_BTN_RE  = new RegExp('^' + WITHDRAW_VERB_RE.source + '\\b', 'i');
const WITHDRAW_ARIA_RE = /(withdraw|delete|invitation|отозвать|удалить|скасувати|видалити|запрош|приглаш)/i;

function matchesWithdrawButton(text, ariaLabel) {
  const t = (text || '').trim();
  const a = (ariaLabel || '').toLowerCase();
  return WITHDRAW_BTN_RE.test(t)
    || (WITHDRAW_ARIA_RE.test(a) && WITHDRAW_VERB_RE.test(a));
}

const LITWithdrawMatch = {
  matchesWithdrawButton,
  WITHDRAW_VERB_RE,
  WITHDRAW_BTN_RE,
  WITHDRAW_ARIA_RE,
};
if (typeof globalThis !== 'undefined') globalThis.LITWithdrawMatch = LITWithdrawMatch;
if (typeof module !== 'undefined' && module.exports) module.exports = LITWithdrawMatch;

})();
