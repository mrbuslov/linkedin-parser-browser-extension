# Plan — LinkedIn Parser

Roadmap derived from user feedback on the v1.0.0 launch post + maintainer additions.
Priority is **rough**; we'll do them one at a time and revisit after each ship.

---

## P0 — Critical bugs from real users

### 1. Profiles appear in Accepted/Marked without actually being a connection
Reported by Maksim Tsvetkov after running the v1.0.0 scan. Symptoms: people showing
status "accepted" who he never actually connected with. Root cause unknown — needs
investigation. Likely candidates:
- `profile.js` auto-add logic triggers on a profile that has a `/messaging/` link
  even when the visitor isn't actually a 1st-degree connection (e.g. LinkedIn might
  render Message-with-credit-cost link for 2nd-degree paid users / Sales Navigator).
- `content.js` diff marks /sent/ disappearances as accepted indiscriminately, including
  withdrawn-by-user cases.

Fix path: tighten the "connected" signal in `profile.js` (look for the actual 1st-degree
badge: `· 1st` text near the name, which is present in the user's reference HTML),
and add a separate withdrawn-tracking flow (see P1.1 below).

### 2. Withdrawn invitations are misclassified as accepted
The spec called this out explicitly and we didn't fix it. When the user clicks Withdraw
on /sent/, the card disappears just like an accepted one does — the next scan moves
the person to Accepted. Fix:
- Add a passive click listener on /sent/ for elements with text matching "Withdraw"
  (or its localized variants — better: closest button parent of the card that's
  disappearing).
- Stamp the affected profileUrl with `withdrawnAt: now` in a new `withdrawn` map.
- During the next diff, missing URLs that have a recent `withdrawnAt` are moved to
  `withdrawn`, not to `accepted`.

---

## P1 — High-value features from real users

### 1. Source of truth for acceptance dates: /mynetwork/invite-connect/connections/
Eduard Parsadanyan pointed out that this page shows every connection with the date
they accepted ("Connected on 2026-05-12" style). Right now we guess the acceptance
date by when a profile disappeared from /sent/, which is approximate and only works
for invitations we tracked from the start.

Plan:
- Add a third content_script entry for `/mynetwork/invite-connect/connections/*`.
- Parse the connection list (same `[role="listitem"]` pattern likely works).
- For each connection, extract: name, profile URL, headline, `connectedAt` date.
- Merge into the existing `accepted` store: prefer the LinkedIn-provided `connectedAt`
  over our guessed `acceptedAt`.
- This also gives us the "ghost detection" Leyla mentioned for free — we no longer
  need to auto-add from profile visits because we have a canonical list of all our
  connections.

### 2. Opt-in profile capture (recruiter concern)
Leyla Mammadzada flagged that auto-capturing every visited profile pollutes the
recruiter's mental "CRM" and burns their LinkedIn 30k-contact quota with non-targets.
She proposed an opt-in workflow.

Plan:
- In Settings, add a toggle: "Auto-save profiles I visit to Contacts" — default ON
  for casual users, but easy to flip off.
- When the toggle is OFF, do not write to `contacts` automatically. Instead, inject
  a small floating "Save to tracker" button on the profile page that the user clicks
  manually when they want to capture someone.
- Keep `accepted` updates from profile visits regardless of the toggle (we want to
  know who actually connected vs withdrew/declined — that's verification, not capture).

### 3. 30k LinkedIn contact limit awareness
Same Leyla feedback. LinkedIn caps total connections at 30,000 — once you hit it,
you can't send new invites until you remove some.

Plan:
- In Settings → Stats, show "Tracked connections: N / 30,000" with a horizontal bar.
- Display a yellow warning at 24k (80%) and a red one at 27k (90%).
- This is informational only — we don't have a way to read the user's real LinkedIn
  contact count, only our tracked subset. But for active users the tracked count
  usually approximates the real one.

### 4. Activity / dormancy detection
Ruslan Kuchma's ask. He wants to know which of his contacts are still active on
LinkedIn (logging in, posting, commenting) so he can:
- Skip dormant people when sending new invites
- Identify completely dead contacts to unfollow and improve his network quality score

Plan:
- On profile pages, look for "last active" indicators: green dot near avatar, "Active
  X ago" text, posting recency in the Activity section.
- Store `lastActiveAt` in the contact record.
- Add a "Dormant" filter / column in the popup (e.g. >6 months inactive).
- Stretch goal: surface a "Cleanup candidates" tab listing connections with no activity
  in a year+.

---

## P2 — Quality-of-life features

### 1. Per-contact notes
Free-form text field per accepted/marked entry. Stored locally. Searchable through the
existing search field. Useful for "we met at Web Summit", "interested in Q4 partnership",
etc. Was in the original spec, never built.

### 2. Tags / categories
Manual tagging system. Each contact can have multiple tags ("client-prospect", "old-coworker",
"founder", "no-response"). Filter views by tag. Cheap analytics: count of accepts per tag.

### 3. Welcome message templates with auto-substitution
From the original spec. Template editor in Settings, `{firstName}` and `{name}` substitution.
Copy-to-clipboard button per accepted entry. Doesn't auto-send anything (that would be
automation we explicitly avoid).

### 4. Reminders for accepted-without-welcome
`chrome.alarms`-driven check: if an accepted entry has `marked === false` for >3 days,
fire a desktop notification. User-configurable threshold in Settings.

### 5. Withdrawn list as a separate tab
After implementing P0.2 (withdrawn detection), expose `withdrawn` in the UI as its own
tab between Marked and Settings. Useful for analytics ("I sent 200 invites, 80 accepted,
50 declined, 70 I withdrew because stale").

---

## P3 — Larger / speculative

### 1. Sales Navigator support
Parse `linkedin.com/sales/...` page formats. Different DOM, but the workflow concept is
the same. Audience overlap: recruiters who use Sales Navigator daily.

### 2. Job/vacancy parsing from the LinkedIn feed
Tim Agayev's request — parse job posts that people share in their feed. This is a
different product mentally (job tracker, not contact tracker), so probably belongs in
a separate companion extension. Documented here for completeness; happy to merge a PR.

### 3. Recruiter-tuned UI mode
After P1.2 (opt-in) and P1.4 (activity) ship, consider a "Recruiter mode" toggle that
hides Pending tab clutter, surfaces dormancy info more prominently, and adjusts default
behaviors. Decide after recruiter feedback on those base features.

---

## Cross-cutting / polish

- `CHANGELOG.md` is now maintained per release.
- Every shipped feature = version bump (semver: patch for fixes, minor for features)
  + entry in changelog + git tag.
- Re-upload to Chrome Web Store happens per minor release, not per dev commit.
- `README.md` to get screenshots and a short demo GIF before promoting on ProductHunt.

---

## Order of work (proposed)

We're doing one feature at a time. Suggested order based on highest user impact +
lowest implementation cost:

1. **P0.1** — investigate & fix the "phantom accepted" bug. Without this, real users
   distrust the data and the whole product credibility erodes.
2. **P0.2** — withdrawn detection. Same trust issue; small code change.
3. **P1.1** — parse /mynetwork/invite-connect/connections/. Replaces our guesses with
   ground truth and obsoletes part of profile.js ghost logic.
4. **P1.2** — opt-in profile capture toggle. Quick win after recruiter feedback.
5. **P1.3** — 30k limit indicator. Trivial, ~30 lines.
6. **P1.4** — activity detection. Higher complexity, save for after the above land.

After each ships, we revisit this list and re-prioritize based on the next round of
user feedback.
