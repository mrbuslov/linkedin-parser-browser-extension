// Runs on every linkedin.com/search/results/people/* page visit.
// When the URL has `connectionOf=<URN>` (which means "mutual connections
// with the person whose URN is <URN>"), we look up our local records for
// any whose `mutualsUrl` contains that URN. If found, we parse the visible
// search results into a minimal list — {name, profileUrl, avatar} — and
// persist it onto the owner record as `mutualsCollected` + `mutualsCollectedAt`.
//
// The popup uses presence of `mutualsCollected` to flip the chip from a
// "not collected yet" CTA style (solid blue) to "data captured" (white).
//
// SPA navigation: LinkedIn replaces the search page contents in-place when
// the user changes filters. Re-running on every tick handles that for free.

console.log('[LI Tracker] search-mutuals script loaded:', location.pathname);

const POLL_INTERVAL_MS = 1500;
let lastCommit = { urn: '', key: '' };

async function tick() {
  if (!LITUrl.isPeopleSearchPath(window.location.pathname)) return;
  const urn = LITUrl.extractURNFromConnectionOf(window.location.href);
  if (!urn) return;

  const main = document.querySelector('main') || document.body;
  const list = LITSearchResults.extractMutualsList(main, LITUrl.normalizeProfileUrl);
  if (list.length === 0) return;

  // Dedup so we don't write on every tick while data is unchanged.
  const key = list.map((x) => x.profileUrl).join('|');
  if (lastCommit.urn === urn && lastCommit.key === key) return;
  lastCommit = { urn, key };

  const stored = await dbGet(['contacts', 'accepted', 'sentInvitations']);
  const patch = {};
  let ownersTouched = 0;
  for (const storeName of ['contacts', 'accepted', 'sentInvitations']) {
    const store = stored[storeName] || {};
    let changed = false;
    for (const rec of Object.values(store)) {
      if (rec.mutualsUrl && rec.mutualsUrl.includes(urn)) {
        rec.mutualsCollected = list;
        rec.mutualsCollectedAt = Date.now();
        changed = true;
        ownersTouched += 1;
      }
    }
    if (changed) patch[storeName] = store;
  }

  if (Object.keys(patch).length > 0) {
    await dbSet(patch);
    console.log(`[LI Tracker] saved ${list.length} mutuals for URN ${urn} (touched ${ownersTouched} record(s))`);
  } else {
    console.log(`[LI Tracker] URN ${urn} on search page but no local record references it — not saving`);
  }
}

setInterval(tick, POLL_INTERVAL_MS);
tick();
