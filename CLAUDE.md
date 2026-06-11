# LinkedIn Parser Extension — project rules

## ZERO FALLBACKS in DOM parsing

This codebase scrapes a hostile, ever-changing target (LinkedIn). Fallbacks
are the #1 source of silent corruption — they hide upstream breakage, ship
junk into the user's local CRM, and stay there forever. The rule:

**If you can't identify something with a stable, scoped anchor — RAISE or
return null. Never guess.**

### Forbidden patterns (delete on sight, even in your own freshly-written code)

- Scanning a broad container for "any button that looks pending/connect/follow"
  — sidebars / mutuals / recommendations have those too and will leak in.
- Taking the "first text node after the heading" as a headline. The first
  text node is frequently a hidden SR-only label, a "Video Player is loading."
  badge, or a degree marker like "· 1st".
- Class-name selectors (`_4cd5ec1b`, `f7af8794`, etc). LinkedIn rotates these
  on every build. They are NOT anchors.
- "If this regex doesn't match, fall through to the looser one" — that's how
  the wrong mutual connection's `networkDistance` gets attributed to the
  viewed profile.
- Catching parse failures and writing "" or `null` or a placeholder. That
  garbage shows up in the popup forever.
- Name-based dedup ("two records with the same name → merge them"). Two real
  people can share a name. `memberId` or don't dedup.
- Length filters (`text.length < 500`, `length > 100`) — they silently drop
  real, long-real-world content (long headlines, locations, button labels).

### Required patterns (use these instead)

- **Anchor on what LinkedIn can't change.** In order of stability:
  1. `data-sdui-screen="com.linkedin.sdui.flagshipnav.*"` — LinkedIn's own
     internal screen IDs. Rare to rename.
  2. `<svg id="envelope-medium">` / `id="phone-handset-small">` / etc —
     icons from the shared icon library, used in hundreds of places. If they
     ever rename one, hundreds of pages break — they won't.
  3. `aria-label="<Name> [Premium Profile] <1st|2nd|3rd>"` — screen reader
     accessibility, locale-stable, can't be dropped.
  4. Stable URL patterns (`mailto:`, `tel:`, `profile-displayphoto` substring).
  5. Localized label TEXT (`Email`/`Phone`/`Эл. почта`/...) — needs a
     `LABEL_MAP`, but the text itself is what's shown to users so it can't
     get rotated like a hash class.

- **Scope before you query.** Find the bounded region (top-card SECTION,
  contact-info modal, /sent/ card) and call `querySelectorAll` on THAT —
  never on `<main>` or `document` unless you can prove there's only one
  match in the whole page.

- **Specificity first, fallback NEVER.** If the strict anchor fails, return
  null. Don't try a looser one. The caller decides what null means
  (skip-this-tick / show-empty / surface-error). Hiding the failure with
  a guess is what creates the bugs we then chase for two weeks.

- **One source of truth per field.** `name` comes from RSC `firstName +
  lastName` if available, else `heading.textContent`. Not "RSC name OR
  heading OR some text node that looks short enough". One path, well-tested.

- **Detect, don't assume.** Before adding an `if (something)` branch, verify
  that "something" is actually a deterministic signal — not "I think this
  is usually the case". If you're not sure, find a real DOM sample, add it
  as a fixture in `tests/fixtures/`, and write a regression test that pins
  the actual structure.

### When you DO need a fallback (extremely narrow)

The only acceptable fallback chain is across **structurally different LinkedIn
output shapes that legitimately exist** — e.g. RSC payload is present on
some profiles and missing on others (Premium accounts ship `rehydrate-data`
instead of `__next_f`). In that case the chain is documented inline:

```js
// 1) aria-label degree — bulletproof, exists on every profile shape
// 2) RSC networkDistance — exists on most non-Premium profiles
// 3) return null — every profile has at least one of (1) or (2);
//    if neither, LinkedIn changed something and we should NOT guess.
```

Each branch covers a known, named LinkedIn shape. Never `if (foo) bar else
default_guess()`. Either the next branch is named and justified or there's
no next branch.

## Regression fixtures

`tests/fixtures/` holds real HTML samples from profiles that broke a
parser. Every new class of bug gets:

1. Extracted HTML region (the smallest piece that reproduces) saved as a
   fixture file.
2. A test that loads the fixture and asserts the parser's expected output.
3. The fixture file committed to git with a name that says what bug it
   pins (`igor-contacts-modal.html` — the case where `componentkey`
   wrappers were dropped from contact rows).

If a class of bug recurs after a fixture exists for it, the test will fail
loudly — that's the whole point. Do NOT modify the fixture to make the
test pass; the fixture is the canonical record of "what LinkedIn looked
like when the bug hit." Fix the parser instead.

## Version bumping

**The user controls when versions bump.** Do not increment `package.json`
or `manifest.json` versions on your own. Write fixes into the current
working version's section in the CHANGELOG under `## [Unreleased]` (or
append to the current `## [x.y.z]` entry if the user has explicitly said
"keep adding to this one"). The user will tell you when to cut a new
version number and update the changelog header.

## Storage discipline

- Each profile lives in EITHER `sentInvitations` OR `accepted` OR neither
  (only `contacts`). Never both. The `applyProfileVisit` function enforces
  this — preserve it.
- Records carry `memberId` and `vanityName` from RSC when available. Use
  `memberId` for any cross-URL dedup. Never name-based.
- `connectedOnText` is the "canonical /connections/ scan said this is a
  real connection" guard. Profile-page visits do NOT downgrade entries
  that carry it.
- Auto-delete is forbidden. If we can't classify a record, preserve it and
  flip its `verified` to `'declined'` so the user can decide manually.
