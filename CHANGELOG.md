# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

In development for the next release. See [plan.md](plan.md) for the prioritized roadmap.

## [1.2.7] — 2026-06-15

### Fixed
- **Avatar pointed at the wrong person on profiles that have no photo.**
  Real case: Costa Vasili has no profile photo on LinkedIn — LinkedIn
  shows a default person-accent SVG placeholder instead. The legacy
  parser scanned for the first `<img src=…profile-displayphoto…>` in the
  top-card section and grabbed a stranger's avatar from a "People also
  view" carousel that lives inside the top card. New extraction anchors
  on `aria-label="Profile photo"` — LinkedIn's own accessibility marker,
  exactly one per profile, language-stable. Inside that element:
  - If there's an `<img profile-displayphoto>` → that IS the canonical
    photo URL. Use it.
  - If there's only an SVG (placeholder) → user has no photo. Record an
    empty string AFFIRMATIVELY (with `avatarConfirmed=true`) so the
    refresh policy clears any stale wrong URL we captured earlier.
  Fallback to the legacy in-scope pick only when the anchor is missing
  entirely (sets `avatarConfirmed=false` so a stored good value isn't
  wiped by a mid-render best-effort empty read).
- **Stale avatar / metadata never refreshed.** When a LinkedIn user
  updated their photo, headline, location, etc., the extension kept
  showing the original values we captured on the first visit. Root: the
  refresh-metadata policy was "set-only-if-empty" for avatar — once a
  non-empty URL was stored, no subsequent visit could overwrite it.
  Headline / location / country / mutuals* already updated on every
  fresh non-empty read; avatar is now aligned with that same rule. Empty
  fresh reads (mid-render lazy-load) still don't wipe known-good stored
  data, so this is a pure improvement, no regression on the lazy-load
  edge case.

### Changed
- **Pending list sorts newest-first.** New invitations appear at the top
  of the Pending tab instead of the bottom, so you can immediately
  confirm that an invite you just sent was captured. Long-pending ones
  drift to the bottom (their row-age color class still flags them no
  matter where they sit in the list). Summary text updated to "sorted
  newest first."

## [1.2.6] — 2026-06-15

### Fixed (search-results parser hardening)
- **Glued/doubled names captured for some mutuals.** Real-world examples
  from a 3-mutuals capture: `"Kanstantsin Hupalau Kanstantsin Hupalau"`
  (name appears twice — SR-only label + visible text inside one anchor's
  `textContent`), and `"Patrice Dussault, s.a.h., b.a. • 1stCommunication
  consultant…"` (everything after `"• 1st"` glued together with no
  whitespace, headline+location+followers all concatenated). Two
  independent root causes — fixed together:
  1. **Wrong anchor picked when a card has multiple links to the same
     profile.** LinkedIn renders 2–3 anchors per card to the same /in/
     vanity: the photo wrapper (empty text), the name-only link
     ("Kelsey Frick"), and a wider card-click target wrapping
     name+headline+location+follower-count+mutual-snippet all glued
     together. The previous "first link with non-empty text" heuristic
     sometimes picked the wider one. Now: among all anchors to the
     result URL, pick the SHORTEST-text one — that's the name-only link.
  2. **Degree-marker strip didn't cover the no-space case.** Old regex
     used `\b` after `1st/2nd/3rd`, which doesn't match when the
     headline node renders glued ("1stCommunication" has no word
     boundary between "t" and "C"). New `sanitizeName()` cuts everything
     starting at `" • 1st/2nd/3rd"` with no trailing boundary, so the
     glued-headline case strips cleanly. Also dedupes the
     "Foo Bar Foo Bar" doubled-name pattern (split on whitespace, if
     length is even and the halves are equal, keep one half).

### Migration note
Existing `mutualsCollected[]` lists in storage stay as-captured until the
content script re-runs on the relevant `/search/results/people/
?…connectionOf=…` page. To clean up: open the popup → click the 🤝 chip
on the affected contact → wait for the `[LI Tracker] saved N mutuals…`
console log; the list is overwritten with sanitized names.

## [1.2.5] — 2026-06-12

### Added (Favorites)
- **Favorites tab** with a star toggle on every row. Click ☆ next to anyone's
  name in Pending / Accepted / Marked to flip it to ★ — they appear in the
  new ★ tab (between Marked and Settings), sorted by when you favorited
  them. Favoriting is a cross-cutting tag, not a state change: a favorited
  person STAYS visible in their original tab. Aggregation pulls from all
  three stores (sentInvitations, accepted, contacts) and dedupes by
  profileUrl with accepted > sentInvitations > contacts precedence (richer
  data wins). New record fields: `favorite: boolean`, `favoritedAt: ts|null`.
- Favorite star also appears in the detail-view header (`ⓘ` panel) — same
  toggle, same writes.
- **One-time migration on popup open** (`migrateAutoMarkedToUnmarked`)
  unsticks legacy pre-1.2.5 auto-marked records: sets `marked: false,
  markedAt: null` and deletes `autoMarked` so a second pass is no-op.
  Records the user explicitly Marked are left alone (no autoMarked flag
  on those).

### Fixed (mutuals capture on /search/results/people/)
- **Parser was collecting connections-of-connections, not the actual search
  results.** The legacy implementation scanned every `<a href="/in/...">`
  in the page DOM — which also matches the mutual-connection chips
  rendered INSIDE each result card ("X, Y and 5 others connect with Z"),
  the sidebar widgets ("People you may know"), and a few one-off
  recommendation anchors. Result: the user saw 13-18 names captured per
  search instead of the 10 actual results, with strangers mixed in. New
  anchor: `componentkey="SearchResults<URN>"` (LinkedIn's own internal
  card identifier — the `<URN>` matches `ACoA…` member URN shape). The
  componentkey sits on an INNER card element; we walk up via
  `.closest('[role="listitem"]')` to get the card root, then take the
  first /in/ anchor with non-empty visible text. Snippet sub-area
  (`componentkey="SearchResultssnippet_<URN>"`) is filtered out so the
  same card doesn't count twice. Real-HTML fixture replaced with a
  bounded results-section from a fresh /search/ visit; tests pin the
  exact 10-result count plus the three target names the user flagged in
  the bug report and explicitly reject 3 known-noise vanities.

### Fixed (detail-view favorite star)
- **Star didn't turn yellow when toggled from inside the detail view.** The
  list panels re-render via the `DB_CHANGED` broadcast that fires on every
  dbSet, but the detail panel is rendered once at openDetailView() time
  and is not on the broadcast path. Added `currentDetailUrl` tracking +
  `refreshDetailView()`; toggleFavorite now awaits the write and then
  re-renders the panel from the freshly-stored record, so the visible
  star flips state immediately.

### Changed
- **Brand-new accepted profile visits no longer auto-mark.** Previously, the
  first time we visited a profile that LinkedIn marked "connected" and we
  had no prior tracking (no `sentInvitations` entry, no `accepted` entry),
  we wrote the record as `marked: true, autoMarked: true` on the
  assumption "user is discovering a pre-install contact, hide it from the
  Accepted tab." That heuristic also fired on the much more common case
  of "user invited someone via /mynetwork/ or /search/ without ever
  visiting their profile during the pending phase; person accepted; user
  now opens their profile" — silently burying fresh acceptances in
  Marked. Same thing happened when the pre-1.2.3 pending detector failed
  on a profile (rotated class names → "Kimberly bug"): the missed pending
  surfaced as brand-new-accepted and got auto-marked. New behavior: land
  in Accepted with `marked: false`. Users with a real pre-install
  backlog can clear it once via the existing "Mark all" button.

### Fixed
- **profile.js tick dedup ignored fresh `recentActivity`.** LinkedIn renders
  the Activity card incrementally — tick #1 typically reads
  `<h2>Activity</h2>` before its children hydrate (recentActivity=[]),
  tick #2 sees all 10 SSR cards. The old dedup key
  `(url, status, contactsKey)` was unchanged between ticks → tick #2 was
  short-circuited and the parsed activity never got persisted. Result:
  "I see posts on the LinkedIn profile but the extension shows none."
  Added `activityFingerprint` (joined URN ids) to the dedup key so
  changes in the parsed list trigger a re-write.

### Added
- **Recent-activity capture on profile visits**. The Activity card LinkedIn
  SSR-renders directly into the /in/<vanity>/ DOM (10 cards before any
  scroll) is now parsed into three new fields on every record (contacts,
  sentInvitations, accepted):
  - `lastActivityAt` — ISO timestamp of the freshest activity (any type)
  - `lastPostAt` — ISO timestamp of the freshest OWN post (where the card
    author equals the profile owner)
  - `recentActivity[]` — up to 5 most-recent items, each
    `{ urnActivityId, url, author, type, text, postedAt, postedAtText }`.
    `type` is one of `post` (own), `share` (someone else's), `unknown`.
    Full body text is included — LinkedIn renders the full post in the DOM
    even when CSS-collapses it behind a "...more" button, so the parser
    captures everything visible to the user without expanding anything.
- **Detail view "Recent activity" section** (popup `ⓘ` button → detail
  panel). Shows the two timestamps + a scrollable list of cards with type
  badge (green for own posts, blue for shares), relative-time pill, author
  name (when not own), 4-line text snippet, and an "Open ↗" deep link to
  the post on LinkedIn.
- CSV export now includes `lastActivityAt` and `lastPostAt` columns
  (falling back to the value joined from the contacts store when the
  pending/accepted row's own copy is empty).

### Parser anchors (per the project ZERO-FALLBACKS rule)
1. `<h2>Activity</h2>` heading text — localized variants kept in
   `ACTIVITY_HEADINGS` (`Activity`, `Активность`, `Активність`,
   `Aktivität`, `Activité`, `Aktywność`).
2. `<button aria-label="Open control menu for post by <NAME>">` — per-card
   menu button. Anchors author name AND lets us walk up to the card
   wrapper (the nearest ancestor that also contains an expandable-text-box).
3. `<svg aria-label="Visibility: ...">` — visibility icon. Its parent `<p>`
   begins with the relative-time text (`"4d •"`, `"1mo •"`, etc).
4. `<span data-testid="expandable-text-box">` — the full post body. The
   `...more` expand button is stripped from `textContent`.
5. `urn:li:activity:<id>` in any descendant href — canonical post ID and
   dedup key. URL pattern: `/feed/update/urn:li:activity:<id>/`.

When any anchor fails on a card, we SKIP that card — never guess from
class names or text patterns. Half-parsed garbage is worse than missing.

### Merge semantics
Subsequent visits dedupe `recentActivity` by `urnActivityId` (fresh wins
on collision), sort by `postedAt` desc, and cap at 5. `lastActivityAt` and
`lastPostAt` track the LATER of (stored, fresh) — the stored copy stays
when the user re-visits an old profile whose top 5 cards have since
rotated and we'd otherwise lose the more-recent record.

### Tests
- `tests/activity-parser.test.js` — 20 cases covering time-unit parsing
  (`5m`/`3h`/`4d`/`2w`/`1mo`/`5mo`/`1y`), merge-by-URN with cap, the
  full Lija T. fixture (single-author profile, 5 cards parsed, full body
  text including the long "translation agency" post), the Igor Alentyev
  fixture (mixed authors → correct `type` classification of own posts vs
  reshares), degenerate input handling, and localized heading matching.
- `tests/profile-state.test.js` — 6 new cases for the persistence path:
  fields land on sentInvitations / accepted / contacts; later-of merge
  for the two scalar timestamps; URN-dedup merge for `recentActivity[]`
  with cap-at-5 push-out of the oldest item; preservation of stored
  activity when the current tick yields an empty list.
- Real-HTML fixtures added:
  `tests/fixtures/lija-activity-section.html` (single author, 10 cards)
  and `tests/fixtures/igor-activity-section.html` (6 distinct authors).

### Added
- **In-popup detail view**: tiny `ⓘ` button next to every name (Pending /
  Accepted / Marked / Declined block) opens a full-popup detail panel
  showing all stored fields for that profile — headline, location,
  email/phone/website/address/birthday (with one-click Copy), captured
  mutuals (scrollable list with avatars + names, each clickable to open
  on LinkedIn), connection metadata (status, accepted-at, days-pending,
  first-seen, marked-at), and technical fields (profileUrl, memberId,
  vanityName, contactsCapturedAt). Back arrow returns to the previously-
  active tab. No new storage path — pure render of existing record fields.
- **Mutuals LIST captured on `/search/results/people/?...connectionOf=...`**.
  New content script `search-mutuals.js` runs on LinkedIn's people-search
  page, extracts the URN from `connectionOf=` (deterministic — anchored on
  `ACoA[A-Za-z0-9_-]+` shape), looks up any local record whose
  `mutualsUrl` contains that URN, and persists the visible search results
  onto it as `mutualsCollected: [{name, profileUrl, avatar}, ...]` plus
  `mutualsCollectedAt`. Polls every 1.5s so SPA filter changes and infinite
  scroll are picked up automatically. New `core/search-results-parser.js`
  exports `extractMutualsList(root, normalizeFn)` — pure DOM parsing,
  anchored on `<a href="https://www.linkedin.com/in/...">` and the
  `profile-displayphoto` image substring. Names are deduped by canonical
  profileUrl and stripped of the trailing "• 1st/2nd/3rd" degree marker
  and the "Premium" badge label. Real-HTML regression fixture
  `tests/fixtures/common-connections-search.html`.
- **Popup mutuals chip now signals capture state via color**: solid blue
  ("call to action — click to capture the list") when `mutualsCollected`
  is empty or missing; white outlined ("data captured locally") when we
  have the list. Tooltip changes accordingly. The word "mutuals" was
  dropped from the label (per user request) — chip shows `🤝 N` or
  `🤝` alone.
- **Mutuals captured for `pending` and `accepted` records too**, not just
  in the `contacts` journal. Previously only `contacts[url]` and accepted
  entries updated via `refreshMetadata` got the mutuals fields. Now:
  (1) new `sentInvitations` entries (status=pending) write
  `mutualsUrl`/`mutualsText`/`mutualsCount` immediately;
  (2) existing `sentInvitations` entries refresh mutuals on every visit
  (count drifts as your network grows);
  (3) new `accepted` entries (brand-new pre-existing contact OR promoted
  from `sentInvitations`) write mutuals immediately.
  Refactor introduces `metadataFromInfo(info)` — single source of truth
  for which fields flow from extractor into every store, so no future
  branch can silently drop a metadata field. Four new regression tests in
  `profile-state.test.js`.
- **`refreshMetadata` now overwrites headline/location/country with fresh
  data on every visit**, not just on first-set. Old policy
  (`info.X && !target.X`) was "first non-empty wins" — designed to prevent
  mid-render junk from overwriting good data. Now that the extractor is
  deterministically clean (video.js skip, degree-badge skip, name-glued
  strip), the latest visit is the freshest truth and should win. Without
  this, Clare Suttie's headline stayed permanently stuck on
  "Video Player is loading." even after the extractor stopped producing
  it. Avatar still uses the conservative "set only if empty" policy
  because LinkedIn lazy-loads the cover/photo images and a mid-render
  scrape can yield `""`. Identity fields (name) are still never overwritten
  here — sticky identity is enforced upstream by cross-URL `memberId` dedup.
- **Headline scan skips video.js elements**: LinkedIn renders profile-cover
  videos using video.js (videojs.com). The loading spinner contains a span
  `<span class="vjs-control-text">Video Player is loading.</span>` which
  used to be grabbed as the headline (Clare Suttie regression — her
  popup row showed "Video Player is loading." as her headline). We now
  skip any node with a `vjs-*` ancestor class. The prefix is a stable
  upstream-library convention LinkedIn can't rename without forking
  video.js. Headline extraction logic extracted to
  `LITPopupLogic.extractHeadlineFromScope` for testability; new fixture
  `tests/fixtures/clare-suttie-headline.html` pins the regression.
- **Mutual connections capture**: on every profile visit we read the
  "mutual connections" deep link from LinkedIn's top-card. Anchor is
  deterministic — `a[href*="connectionOf="]` filtered to the link with
  `network=["F"]` (mutual = first-degree common). The other connectionOf
  link on the same page (with `network=["F","S"]`) is "all her connections"
  and gets ignored. Scoped to the top-card section so sidebar widgets
  ("People who follow X also follow") can't bleed in.
  Each contact record now carries `mutualsUrl`, `mutualsText`
  ("Anton, Mikhail and 79 other mutual connections") and a deterministic
  `mutualsCount` (parsed from the text — null if the format doesn't yield
  a count).
- Popup rows render a blue "🤝 N" chip next to the name when the field is
  set; click opens LinkedIn's mutual-connections search in a new tab.
  Hover shows the full mutuals text as a tooltip.

### Changed
- The CRM nudge no longer renders a visible "💾 Save to local CRM" pill
  next to the Contact info link. It's now a plain browser tooltip
  attached to the link itself via the `title` attribute — hover the
  link to see "💾 Click to save contact info to your local CRM. Nothing
  leaves your device." The tooltip is removed automatically once email/
  phone/website are captured. Less visual noise on every 1st-degree
  profile.

### Fixed
- **CRITICAL: `profile.js` SyntaxError "Identifier 'parseMutualsCount' has
  already been declared"** — same class of bug that previously hit
  `cleanHeadline`. `core/popup-logic.js` declared `function parseMutualsCount`
  and `profile.js` re-declared `const parseMutualsCount = LITPopupLogic...`
  in the same shared global scope. Result: `profile.js` failed to parse,
  nothing in the content script ran, no profile-visit writes happened
  (this explains Clare Suttie not being re-added to Pending after delete).
  Call site now uses the `LITPopupLogic.parseMutualsCount(...)` namespace
  form directly — no local re-declaration.
- **New `tests/content-script-bundle.test.js` regression guard**: loads
  every content-script bundle declared in manifest.json into a fresh
  Node `vm` sandbox in the same order Chrome would, and fails the test
  on any `SyntaxError` (parse failure OR top-level identifier collision).
  This is the third bug of this class we've shipped; the test is the
  hard backstop that prevents the fourth.
- **Kimberly Martinez "stuck in Pending" + entire class of sidebar-leak
  bugs**: the detector used to scan EVERY `<button>` / `<a>` / `[role=button]`
  in `<main>`, so action buttons belonging to other people in sidebars
  ("People who follow X also follow", mutuals, recommendations) were
  attributed to the viewed profile. A 1st-degree contact ended up
  classified as `'pending'` because the sidebar had a Pending button.
  Same scope-leak hit headline extraction (grabbed "Video Player is
  loading." from autoplay video) and location extraction. Fix: introduced
  `findTopCardContainer` in `core/detect.js` that anchors on the
  `aria-label` degree element (the most stable per-profile marker LinkedIn
  ships) and walks up to the enclosing top-card container. All action-
  button scanning, headline extraction, and location extraction now scope
  to that container. Sidebar content is invisible to the parsers by
  construction. Regression tests cover Kimberly's DOM shape and "junk
  text outside top-card stays out of headline".

### Migration note
- Existing stuck records (Kimberly et al.) auto-correct on the next
  profile visit: `applyProfileVisit` with the corrected `status='connected'`
  enters the sentInvitations→accepted promotion branch and removes the
  stale pending entry. Headline garbage refreshes from the corrected
  extractor on revisit.

## [1.2.4] — 2026-06-11

CRM nudge — a non-intrusive prompt that reminds the user to open the
LinkedIn "Contact info" overlay on 1st-degree profiles where we haven't
yet captured their email/phone/website. The pill sits inline next to
the link, clicks through to open the modal, and disappears the moment
the parser captures any contact data. Deliberately NOT auto-opening
the modal — that pattern is a textbook anti-automation signal that
gets LinkedIn accounts banned within weeks.

### Added
- `profile.js` renders an inline "💾 Save to local CRM" pill next to
  LinkedIn's "Contact info" link when:
  (1) status === 'connected' (1st-degree); AND
  (2) no `email`/`phone`/`website` is stored for this profile in either
      the `contacts` or `accepted` store.
  Clicking the pill is equivalent to clicking the link — it opens the
  modal LinkedIn rendered, and our existing parser captures from there.
  Tooltip on hover explains the local-only data policy.
- The nudge auto-hides as soon as `persistVisit` saves contact data
  (cache busts → next 250 ms tick re-reads storage → pill removed).
- On profile URL change (SPA navigation or new tab), the nudge cache
  invalidates and the new profile gets a fresh check.

### Notes
- Why not auto-open the modal: opening Contact info on every profile
  visit creates a deterministic detection signal for LinkedIn's
  anti-automation systems. Real users open it on 5-15% of profiles;
  an extension that opens it on 100% gets flagged inside one weekly
  retrain. The cost (account ban, extension removal from CWS) far
  outweighs the convenience. The nudge is the conscious-action
  alternative — UI hint, not automation.

## [1.2.3] — 2026-06-11

Hardening release on top of 1.2.2. Real-world testing surfaced layout
overflow, duplicate records, headline/name corruption, and a parser
that broke when LinkedIn updated its Contact-info markup. Every fix is
grounded in actual user-reported data — no speculative changes.

### Added
- `core/contacts-modal.js` parser now anchors primarily on **SVG icon ids**
  (`envelope-medium`, `phone-handset-small`, `link-medium`, `calendar-medium`,
  `people-medium`, `house-medium`, `linkedin-bug-medium`). LinkedIn ships
  these from a shared icon library used across the entire UI — renaming one
  would break hundreds of pages, so they're effectively frozen. Label-text
  matching kept as fallback for the case where icons disappear. Regression
  fixture (Igor Alentyev's actual modal HTML, 15 KB) pinned in
  `tests/fixtures/igor-contacts-modal.html` and exercised by the test
  suite — multi-website extraction included.
- DOM **aria-label degree detector** as the new top-priority signal in
  the connection detector. LinkedIn renders the connection degree as
  `aria-label="<Name> [Premium Profile] <1st|2nd|3rd>"` for screen
  readers across every profile shape, including Premium profiles that
  ship NO RSC payload at all. Priority chain: DOM Pending → aria-label
  degree → RSC degree → DOM fallback.
- **Cross-URL dedup by `memberId`** (zero name-based fallback). When
  LinkedIn changes a profile's vanity slug, the new record's `memberId`
  from RSC matches an existing entry's `memberId`, and the records get
  merged into the current-URL key (contact info, marked status, earlier
  firstSeenAt/acceptedAt, `verified='accepted'` all carry over). Name
  matching was deliberately rejected because two real people can share
  a name and silently merging them corrupts data with no recovery.
  Records now persist `memberId` / `vanityName` on every visit.
- Per-row **Delete** button across all popup tabs (Pending, Accepted,
  Marked, Declined block). One click + confirm dialog → entry purged
  from `sentInvitations` / `accepted` / `contacts` in one transaction.
- Settings → Privacy → **Forget all contact details** button. Wipes
  email/phone/website/address/birthday/connectedSinceText from every
  record. Names, headlines, profile URLs, accepted/marked status are
  preserved.
- **`extractRSCTextCached`** in `core/rsc-parser.js` — URL-keyed cache
  for the parsed RSC payload. Previously re-parsed 1.5 MB of script
  bytes on every 250 ms poll tick. Cache invalidates on URL change so
  SPA navigation between profiles still picks up the new payload.
- Popup **on-page toast** for contact-info capture confirmation:
  white card with green check, field chips ("📧 email · 📞 phone · 🌐
  website · 📍 address · 🎂 birthday"), rendered via Popover API in the
  browser top layer so LinkedIn's `<dialog>`-based modal can't hide it.
- `LITPopupLogic.cleanHeadline` and `LITPopupLogic.fixSwappedNameHeadline`
  in `core/popup-logic.js` — defensive cleanup helpers run on every
  popup render plus a one-shot storage migration on popup load.

### Fixed
- **Contact-info parser broke on the new LinkedIn markup** (Igor Alentyev's
  profile, observed 2026-06-11): per-section `componentkey` attribute
  was dropped from contact rows. Parser now uses SVG icon ids first and
  label-text as fallback; both shapes parse correctly.
- **5 duplicate records of the same person** caused by three independent
  bugs: (1) `normalizeProfileUrl` didn't collapse `/in/<vanity>/overlay/…`
  sub-paths, so opening Contact info stored under a different key;
  (2) content script kept running after SPA navigation and wrote a
  `https://www.linkedin.com/search/results/people/` keyed entry;
  (3) cross-URL dedup didn't exist. All three closed: normalizer
  collapses any `/in/<vanity>/<sub-path>...` to canonical, profile.js
  tick gates writes via `isProfilePath(location.pathname)`, and dedup
  merges by `memberId`.
- **`name` and `headline` swapped in legacy records** ("Daniil
  StankevichFullstack developer | …" stored as `name`, "Daniil
  Stankevich" stored as `headline`). `fixSwappedNameHeadline` detects
  the signature (`name` starts with `headline` AND is longer), swaps
  them, and strips any leading separator. Runs both at render time
  (instant visual fix on all tabs) and as a one-shot storage migration
  on popup load (so CSV exports get the clean shape too).
- **Name glued to headline** in newly-extracted records (LinkedIn ships
  an accessibility text node that combines both). `stripNamePrefix` in
  `extractProfileInfo` strips the name at extract; `cleanHeadline` at
  render time cleans legacy data without requiring a re-visit.
- **"· 1st" badge text** was being captured as headline. Skip filter
  in `extractProfileInfo` matches the degree-badge pattern (EN/RU/UA).
- **Zhenia Mohyla "stuck declined" canonical fix**: detector gained the
  aria-label degree signal, RSC `findNetworkDistance` rewritten to be
  robust against LinkedIn reordering fields in the payload, and
  `applyContactInfo` now flows into `accepted[url]` regardless of the
  visit status branch (was only `connected`).
- **Popup layout horizontal/vertical overflow**: `flex-wrap: wrap` on
  `.row .name-row`, `min-width: 0` chain through `.row-body`/`.name-row`/
  `.name`, ellipsis on long names, hard 380×600 cap on html/body.
- **popup.js SyntaxError** ("Identifier 'cleanHeadline' has already been
  declared") — `popup-logic.js` declared it as `function`, `popup.js`
  re-declared via `const` in the same global scope. Removed the `const`,
  use the global directly.
- Toast restyled to **white LinkedIn-style** card with max z-index and
  Popover API so it sits in the browser top layer (`<dialog>`-based
  LinkedIn modals can't hide it).
- CSV export now includes `email`, `phone`, `phoneLabel`, `website`,
  `address`, `birthday` columns (joined from the contacts store).
- Popup search matches against email/phone/website/address.

### Internal
- `temp/` directory untracked from git (it was already in `.gitignore`
  but legacy fixture HTMLs were committed under it).
- `tests/fixtures/` is the new home for real-world HTML samples used in
  regression tests.

## [1.2.2] — 2026-06-11

Contact-info harvest. When the user opens the "Contact info" overlay on any
profile, the extension now reads the fields LinkedIn shows there (email,
phone, website, address, birthday, connected-since) and stores them on the
contact record. Nothing is ever sent off-device. The popup grows a small
copy button per captured field — one click puts the value on the clipboard.

### Added
- `core/contacts-modal.js` — parser keyed off the stable
  `data-sdui-screen="com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay"`
  attribute. Each section's two `<p>` tags (label + value) are mapped to a
  canonical field name. Localized labels handled for English / Russian /
  Ukrainian.
- `decodeLinkedInRedirect` in `core/url.js` — strips LinkedIn's
  `safety/go/?url=…` wrapper so the website we store is the actual
  destination URL, not the obfuscated redirect.
- `applyContactInfo` state helper — overwrite-on-visit semantics with a
  `contactsCapturedAt` timestamp. Fields absent from the latest modal
  snapshot are preserved (no destructive wipe if the user opens the modal
  on a profile where only Phone is visible).
- Popup: small copy buttons (📧 📞 🌐) appear next to a contact's name in
  the Accepted/Marked tabs when the corresponding field is stored. Click =
  one-shot toast "email copied" / "phone copied" / "website copied".
- Popup search now matches against email/phone/website/address too — typing
  "t.me" finds the contact whose website is t.me/…
- 25 new unit tests across `contacts-modal.test.js`, `url.test.js`, and the
  contact-info section of `profile-state.test.js`. 152 tests total.
- CSV export now includes email, phone, phoneLabel, website, address, birthday
  columns (joined from the contacts store by profileUrl).
- Settings → Privacy → "Forget all contact details" button that wipes the
  captured fields from every record (names, headlines, profile URLs and
  accepted/marked status are preserved). Requires explicit confirmation.
- `extractRSCTextCached` — URL-keyed cache for the parsed RSC payload. We
  used to re-parse 1.5 MB of script bytes every 250 ms poll tick; we now
  parse once per page load. Cache invalidates on URL change so SPA navigation
  between profiles still picks up the new payload. 3 new tests pin the
  cache-hit, URL-change-invalidate, and resetRSCCache behaviors.
- On-page toast on the profile when Contact info modal data is captured —
  "✓ Contact info saved — 📧 📞 🌐" (2.2 sec, bottom-right, dedup'd). User
  no longer has to open the popup to know whether the harvest worked.
- Contact-info fields now also flow into `sentInvitations[url]` when the
  profile is pending, so the Pending tab in the popup renders the same
  copy buttons (📧 📞 🌐) as Accepted/Marked. Symmetric across all three
  tabs now.

### Fixed
- **Zhenia Mohyla "stays declined after profile visit" root-cause fix**:
  detector gained a new top-priority signal — DOM `aria-label` degree. LinkedIn
  always renders `<element aria-label="<Name> [Premium Profile] <1st|2nd|3rd>">`
  on the top-card for screen-reader accessibility. Some profile variants
  (Premium accounts in particular) ship NO RSC payload at all — the previous
  detector then fell to DOM heuristics, where a Follow button (Creator mode)
  was mis-read as "not connected". With aria-degree the detector now
  authoritatively says "1st degree" from a signal LinkedIn cannot remove.
  Priority chain is now: DOM Pending → aria-label degree → RSC degree → DOM
  fallback. Six regression tests including the exact Zhenia DOM shape.
- **Cross-URL dedup** by memberId ONLY (no name fallback) when LinkedIn
  changes a profile's vanity slug. `applyProfileVisit` scans
  `contacts`/`accepted`/`sentInvitations` for a record with a matching
  `memberId` — LinkedIn's canonical numeric profile ID, read from RSC.
  When found, contact-info fields, marked status, earlier
  firstSeenAt/acceptedAt and any `verified='accepted'` carry over into
  the current-URL record and the old key is deleted. Records gain
  `memberId` / `vanityName` on every visit so future dedup is rock-solid.
  Name-based fallback was deliberately rejected: two real people can share
  a name, and a silent name-merge corrupts data with no recovery. If
  memberId is missing on either side, we don't auto-merge — user can
  clean up manually if it bothers them.
- On-page toast restyled to **white LinkedIn-style** card: green ✓ in a
  circle, dark title text, light chip pills for each captured field
  (📧 email · 📞 phone · 🌐 website · 📍 address · 🎂 birthday). Larger
  padding (18px 22px), softer dual-layer shadow, max-z-index so the toast
  is never hidden by LinkedIn's own modal backdrops.
- `applyContactInfo` now flows into `accepted[url]` regardless of the visit
  status branch — previously only the `connected` branch wrote contact-info
  fields onto the accepted record. As a result, a profile that was stuck
  declined got its contact-modal data written only into the `contacts`
  journal, and the popup row showed no copy buttons (because the popup
  reads from `accepted`, not `contacts`). Now buttons appear whenever the
  user opens the Contact info modal, no matter the verified status.
- `findNetworkDistance` rewritten to be robust against LinkedIn reordering
  fields in the RSC payload. The previous version matched a hardcoded
  field sequence (`vieweeMemberUrn → viewerPrivacySetting → networkDistance`)
  — if LinkedIn ever inserts an extra field or reorders, the strict regex
  silently fails and the loose fallback picks up some mutual-connection's
  distance instead, mislabelling a real 1st-degree contact as 2nd-degree.
  This is the root cause behind "Zhenia Mohyla stays wrongly declined even
  after profile re-visit". New logic: anchor on `vieweeMemberUrn`, then
  search a 4 KB window forward for the FIRST `networkDistance`. No coupling
  to neighboring field order. Three new regression tests cover reordering,
  mutuals-sidebar contamination, and trailing unrelated distances.

### Notes
- Profile pages where the user never opens "Contact info" yield no extra
  fields — we don't auto-open anything, no extra requests.
- LinkedIn's RSC payload does not contain the contact-info fields. They're
  only loaded into the DOM when the overlay opens, so DOM scraping is the
  right (and only) path here.

## [1.2.1] — 2026-06-10

Canonical-source switch for the profile detector. Profile-page status now
comes from LinkedIn's own SSR payload (Next.js RSC), not from inspecting
which buttons happen to be visible at the moment we read the DOM. The
entire class of "DOM mis-read" bugs goes away with one change.

### Added
- `core/rsc-parser.js` — reads LinkedIn's streaming Next.js payload from
  `<script>` tags (`self.__next_f.push([1, "…"])`). Extracts the canonical
  `networkDistance` (1/2/3 ⇒ connection degree), `firstName`, `lastName`,
  `vanityName`, `memberId`, plus the set of primary actions (CONNECT,
  FOLLOW, WITHDRAW_INVITATION). Content-script safe — no MAIN-world
  injection, no extra permissions.
- 18 unit tests covering RSC extraction, escape decoding, status mapping,
  and the regression case behind Mira's "Follow→Unfollow flips to Accepted".

### Fixed
- profile.js status detection: primary source is now `networkDistance` from
  the SSR payload. Clicking Follow on a non-connection no longer causes a
  false "accepted" state, because the canonical degree doesn't change with
  follow-status. DOM heuristics remain as a fallback for SPA navigations
  where the payload isn't reloaded.
- profile.js name extraction: prefers `firstName + lastName` from the SSR
  payload before falling back to the page heading. Eliminates the
  long-headline-stuck-to-name family of bugs at the source.

## [1.2.0] — 2026-06-02

Big stability release driven by extensive real-world testing with Mira and
other beta users. Many bugs that had been silently dropping data are fixed,
and there's a new onboarding nudge in the popup so users know to run the
/connections/ scan when needed.

### Added
- Yellow warning banner in the Accepted tab that appears when declined entries
  exist AND the /connections/ scan was never run. One-click "Open connections
  page" CTA. Disappears permanently after the first /connections/ scan.
- `core/popup-logic.js` with pure-function helpers for popup decisions.

### Fixed
- profile.js: a real 1st-degree connection no longer gets wrongly flipped to
  ✗ DECLINED in the popup just because a profile-page visit briefly saw a
  Follow/Connect button mid-render. Entries whose `verified='accepted'` was
  written by the canonical /connections/ scan (i.e. carry a `connectedOnText`
  field) are now off-limits to profile.js downgrades — only a fresh
  /connections/ scan can revise them.
- content.js: /sent/ invitations sent to an email address (no /in/ link
  because the recipient has no LinkedIn profile yet, or LinkedIn's
  "you-must-know-them" wall hid the link) are now captured. They appear in
  the Pending tab keyed by `mailto:<email>`, with the email rendered as a
  non-clickable monospace span (no profile to open, no email client to fire).
- profile.js: replaced MutationObserver + debounce + stability-confirm logic
  with a simple 250ms polling loop. The latest DOM snapshot self-corrects on
  the next tick, so transient mid-render false positives disappear within a
  quarter-second. Net code reduction ~40 lines.
- connections.js: /connections/ scan no longer exits early when LinkedIn
  virtualizes its long list (top cards get removed from DOM as new ones load
  at bottom, keeping the visible count flat). We now parse cards on every
  tick and accumulate into a Map keyed by profileUrl, so total-seen growth
  is the real signal. Plus a hard `window.scrollTo(0, scrollHeight)` each
  tick to trigger LinkedIn's lazy-load handler reliably. Stable-rounds
  threshold bumped 4 → 6 (16-28s tolerance) for slow LinkedIn batches.
- connections.js: avatar URLs are now picked up correctly. Previously the
  parser would lock in `avatar=''` on the very first parse of a card (when
  LinkedIn hadn't lazy-loaded the `<img>` yet) and never re-attempt. Now
  cards are re-parsed every tick and non-empty fields are preferred.
- merge-connections.js: pre-existing connections discovered during the first
  /connections/ scan are now auto-marked (go straight to Marked tab) so they
  don't pollute the "to handle" count in Accepted. Newly accepted invites
  (those that were in sentInvitations before) stay unmarked — those are the
  ones the user actually needs to handle.
- content.js (Withdraw): clicking Withdraw on /sent/ now removes the entry
  from Pending immediately. Previously we just stamped `withdrawnAt` and
  the entry hung around in the popup until the next /sent/ scan.
- /connections/ card parser: cards whose `<a href="/in/...">` link wraps both
  the name AND a long headline (new LinkedIn UI) no longer get silently
  dropped. Name is now extracted from the first inner `<h1>/<h2>/<h3>/<p>`,
  not from the whole `link.textContent`. This was the root cause of Mira's
  "Luis/Ana/Bernardo stuck as ✗ DECLINED" — they never made it into the
  /connections/ scan snapshot, so the canonical "verified=accepted" override
  never applied to them.
- /connections/ scan now scrolls the actual scroll container (LinkedIn's
  `<main>` element) instead of the window. The newer LinkedIn UI uses an
  internal scroll layer with `scrollHeight` of ~40000 while the window
  itself doesn't scroll at all — earlier versions got stuck at ~280 cards
  out of 2000+. We now detect the right container per tick and force-scroll
  it to the bottom.
- All hardcoded upper text-length filters removed across content.js,
  connections.js, profile.js, and core/detect.js. Lower bounds (skip
  empty/single-char strings) retained as garbage filters. Long real-world
  content (headlines, locations, button labels) is now preserved verbatim.

### Tests
- 94 unit tests (was 82). New regression cases: long-headline /connections/
  card capture, "no upper length cap" semantics, detect.js defense against
  long button-text false positives, popup warning visibility rules.

## [1.1.1] — 2026-05-25

Reliability patch for profile-visit status detection. Two real-user bugs fixed
plus a behavioral simplification.

### Fixed
- profile.js: 1st-degree contacts no longer get nuked on profile visit because
  of a transient mid-page-load false positive. Destructive status changes are
  now confirmed via a 1.5-second stability re-check before being committed.
- profile-state.js: visiting a profile that LinkedIn now shows as `not_connected`
  (Connect button visible) no longer silently deletes the entry. The badge
  flips to ✗ declined and the record is preserved in the "Didn't accept"
  collapsible block at the bottom of the Accepted tab.

### Changed
- not_connected handling unified: regardless of how the entry got `verified='accepted'`
  (via /connections/ scan or a previous profile.js detection), the entry is now
  preserved and marked declined rather than auto-deleted. Surprise removals
  erode trust in the data more than a stale label does. User can clean up
  manually if desired.

## [1.1.0] — 2026-05-25

Stability release. Several real-user bug reports fixed plus the long-awaited
canonical connections-page parser. Internals refactored for testability: pure
logic now lives in `linkedin-tracker/core/` and is covered by 66 Vitest unit tests
that run in CI on every push and pull request.

### Added
- Parser for `linkedin.com/mynetwork/invite-connect/connections/` — the canonical
  list of accepted connections. Each entry includes LinkedIn's own "Connected on"
  date which we use as the source of truth for `acceptedAt`. Multi-locale date
  parser (English native, Russian/Ukrainian/German via regex fallback).
- "Scan connections" button in the Accepted tab — opens the connections page if
  not already there, triggers a scan if already there.
- Per-tab last-scanned indicator under each summary row showing relative time
  and either count of items captured or the failure reason in red.
- "Contact support / Report issue" button in Settings → opens GitHub Issues.
- `scanState` storage key tracking per-source scan metadata (`sent`, `connections`).
- Declined entries collapsed into a `<details>` block at the bottom of the
  Accepted tab — they no longer clutter the main "to handle" count.
- Withdraw click listener on /sent/: explicitly withdrawn invites are stamped
  with `withdrawnAt` and excluded from the missing→accepted diff for 7 days.
- Vitest test suite (66 tests) covering the date parser, status detector,
  profile state transitions, /sent/ diff, and /connections/ merge.
- GitHub Actions CI: ESLint + tests run on every push and PR; tagged releases
  produce a CWS-ready zip artifact.

### Fixed
- profile.js: "phantom-accepted" — visiting a 2nd/3rd-degree profile no longer
  adds them to Accepted just because LinkedIn renders a `/messaging/` link
  (used for InMail). Now requires absence of Follow/Connect/Pending buttons +
  presence of Message link.
- profile.js: Pending button (an `<a>`, not `<button>`) now detected.
- profile.js: Pending detection no longer breaks on non-English UIs ("Очікує на
  розгляд") or buttons with embedded screen-reader text. Uses Unicode-friendly
  prefix matching instead of ASCII `\b` boundaries.
- profile.js: enforces "one bucket at a time" invariant — sending Connect after
  withdrawing no longer leaves a stale accepted entry visible alongside Pending.
- profile.js: removing a real connection drops the entry from Accepted instead
  of mis-labelling it as Declined.
- profile.js: clicking Connect from a profile page now adds the person to
  Pending in real time via an always-on MutationObserver.
- parseConnectedDate: rejects dates without an explicit 4-digit 20xx year
  (previously `Date.parse("May 24")` would silently fall back to year 2001).
- popup: "N to handle" count in the Accepted tab no longer includes declined
  entries.

### Changed
- Profile-name links in the popup now navigate the current active tab via
  `chrome.tabs.update` instead of opening a new tab. Cmd/Ctrl-click preserves
  new-tab behavior.
- "Open profile" button removed from Accepted/Marked rows (name is already a link).
- Project structure: pure logic extracted to `linkedin-tracker/core/`, content
  scripts now consume it via the manifest's `js:` array. No bundler — each
  core file is dual-mode (classic script + CJS module).

## [1.0.0] — 2026-05-21

First public release on the Chrome Web Store.

### Added
- Parser for `linkedin.com/mynetwork/invitation-manager/sent/` that captures
  every sent invitation (name, headline, profile URL, avatar, "sent X ago")
- Diff algorithm: anyone who disappears from /sent/ between scans is moved to
  Accepted as a likely-accepted connection
- Age-based color coding for pending invites (yellow at 7 days, red at 14)
- Profile-page content script that auto-captures every `/in/...` profile the
  user visits (name, headline, location, country, photo URL, connection status)
- Cross-language connection-status detection via `/messaging/` link presence
  (works regardless of LinkedIn UI language)
- Auto-archive of pre-existing connections discovered through profile visits
  (they land directly in Marked rather than Accepted)
- Popup with four tabs: Pending, Accepted, Marked, Settings
- Status badges per accepted entry: ✓ accepted, ✗ declined, ? unverified
- Mark / Mark all / Unmark actions for moving entries between Accepted and Marked
- Search field that filters all lists by name or headline
- JSON export/import for full local backup and device migration
- CSV export for external analysis
- Custom tooltip explaining the unverified ? status
- Desktop notifications for newly accepted connections after a scan
- Scan progress UI with cancellable Stop button and animated spinner
- In-popup hint advising users to keep the LinkedIn tab visible during scans
  (Chrome throttles background tabs and pauses lazy-loads)
- Single header action button with three modes: Go to Sent page / Scan / Stop

### Changed
- Storage backend: IndexedDB instead of `chrome.storage.local`. Removes the
  10 MB ceiling; effectively unlimited on user's device (gigabytes available).
  All reads/writes proxied through the service worker so content scripts
  (linkedin.com origin) and the popup (extension origin) share one store.
- Popup layout: full-height flex layout eliminates the previous scroll-within-scroll

### Removed
- `storage` permission (no longer needed after IDB migration)
