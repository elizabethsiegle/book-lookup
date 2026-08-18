import { ADAPTERS, getAdapter } from './sites/index.js';
import { createIntent, decide, liveIntent } from './lib/intents.js';
import { BADGE } from './lib/badges.js';
import { normalizeQuery, normalizeMode } from './lib/query.js';
import { loadCredential } from './lib/credentials.js';
import { shouldAutofill } from './lib/autofill-policy.js';

const intentKey = (tabId) => `intent:${tabId}`;

async function readIntent(tabId) {
  const key = intentKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function writeIntent(tabId, intent) {
  const key = intentKey(tabId);
  if (intent) {
    // N2: a handler that is still running when its tab closes must not
    // resurrect session-storage state for it after `onRemoved` has already
    // cleared that state — see `closedTabs`. Clearing (the `else` branch
    // below) is exempt from this guard: it must always be allowed to run,
    // including from `onRemoved`'s own cleanup call, regardless of ordering.
    if (closedTabs.has(tabId)) return;
    await chrome.storage.session.set({ [key]: intent });
  } else {
    await chrome.storage.session.remove(key);
  }
}

/**
 * The anti-ping-pong guard for the outbound sign-in redirect below.
 *
 * This USED to clear whenever a report had `signedIn === true` — which is
 * exactly the `authed` report that immediately precedes the resume back to
 * the results page. That disarmed the guard at the very moment the tab was
 * sent back to the page that triggered the redirect in the first place: if
 * the resumed results page didn't render an AUTHED_SELECTORS sign-out
 * control by `document_idle` (client-rendered account menus; `runner.js`
 * only re-checks when state is `unknown`), the next `results` report looked
 * identical to the very first landing and triggered a second redirect —
 * with nothing to stop a third, and a fourth, forever.
 *
 * The fix is a deliberate downgrade: the marker is written once, when a tab
 * is redirected, and is NEVER cleared by any page report — not on
 * `signedIn: true`, not on anything. It is removed only in
 * `chrome.tabs.onRemoved`, alongside the existing intent cleanup. There is
 * also no expiry: a marker that never expires cannot be waited out. One
 * outbound redirect per tab, for the life of that tab, full stop. Searches
 * always open a fresh tab (`runSearch` calls `chrome.tabs.create`), so this
 * costs the owner nothing in practice — do not "improve" this back into a
 * guard that can be disarmed or waited out.
 */
const signinAttemptKey = (tabId) => `signinAttempt:${tabId}`;

async function readSigninAttempt(tabId) {
  const key = signinAttemptKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return Boolean(stored[key]);
}

async function writeSigninAttempt(tabId, attempted) {
  const key = signinAttemptKey(tabId);
  if (attempted) {
    // N2: same guard as `writeIntent` above, same reason.
    if (closedTabs.has(tabId)) return;
    await chrome.storage.session.set({ [key]: true });
  } else {
    await chrome.storage.session.remove(key);
  }
}

/**
 * In-memory half of the one-shot-per-tab redirect guard. `readSigninAttempt`
 * / `writeSigninAttempt` above are `chrome.storage.session` calls — always
 * async — so a bare "read, check, write" sequence has awaits between the
 * check and the write, and concurrent reports can all read "no marker yet"
 * before any of them writes one. This Set is checked and claimed
 * synchronously, with no `await` between the check and the claim, which is
 * what actually closes that race: JavaScript is single-threaded, so nothing
 * else can run between those two lines for a given call. The persisted
 * marker above is kept as the backup that survives a service-worker
 * restart, which wipes this Set.
 *
 * Entries are added once and never removed except by `chrome.tabs.onRemoved`
 * — this is the same one-shot-forever marker as `signinAttemptKey`, just
 * mirrored in memory for atomicity.
 */
const redirectedTabs = new Set();

/**
 * Guards the ENTIRE per-report decision-and-navigate section of
 * `handlePageReport` for a tab — not just the instant of a `chrome.tabs
 * .update` call. A lock scoped only to the update call itself is not
 * enough: two concurrent reports for the same tab (e.g. `authed`, which
 * resumes, and `results`, which redirects) take a different number of
 * `await`s to reach their own update call, so one can finish — and release
 * a narrow lock — before the other ever reaches it, and both still
 * navigate. Checking and claiming `busyTabs` as the very first thing in
 * `handlePageReport`, before any `await`, means whichever report's
 * `onMessage` handler happened to run first (JS is single-threaded, so
 * that order is deterministic even for messages dispatched "concurrently")
 * gets to decide and act; every other report for that tab is refused
 * outright — synchronously, before touching any storage — until the first
 * one finishes. That closes both the Finding 4 read-modify-write race
 * (concurrent reports can no longer all observe "not yet redirected") and
 * the Finding 5 double-navigation race in one guard. Released once the
 * winning call finishes, so it never blocks a later, non-concurrent report
 * (e.g. a redirect now and a resume much later).
 */
const busyTabs = new Set();

/**
 * N2: tabs known to be closed, so that a `handlePageReport` call still
 * in flight when its tab closes (it awaited storage/adapter work started
 * before `chrome.tabs.onRemoved` fired) does not write `intent:<id>` or
 * `signinAttempt:<id>` back into session storage after `onRemoved` already
 * cleared them — which would otherwise leak that state forever, since
 * nothing else ever revisits a closed tab's keys. Never pruned: like
 * `redirectedTabs`, a tab id is done with this extension the moment it
 * closes, for the life of the service worker.
 */
const closedTabs = new Set();

async function setBadge(tabId, badgeName) {
  if (!badgeName) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'Book Lookup' });
    return;
  }
  const badge = BADGE[badgeName];
  await chrome.action.setBadgeText({ tabId, text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
  await chrome.action.setTitle({ tabId, title: badge.title });
}

/**
 * Open one tab per requested site. The first site in adapter order becomes the
 * active tab — SFPL, normally, because holds and waitlists are queue-based and
 * it is the one worth looking at first. The rest load in the background.
 */
async function runSearch({ query, mode, sites }) {
  const cleanQuery = normalizeQuery(query);
  const cleanMode = normalizeMode(mode);
  if (!cleanQuery) return { opened: 0 };

  const siteList = Array.isArray(sites) ? sites : [];
  const requested = ADAPTERS.filter((adapter) => siteList.includes(adapter.id));
  if (!requested.length) return { opened: 0 };

  let opened = 0;
  for (const [index, adapter] of requested.entries()) {
    const targetUrl = adapter.buildSearchUrl(cleanQuery, cleanMode);
    const tab = await chrome.tabs.create({ url: targetUrl, active: index === 0 });
    await writeIntent(
      tab.id,
      createIntent({ tabId: tab.id, site: adapter.id, targetUrl, now: Date.now() })
    );
    opened += 1;
  }
  return { opened };
}

/**
 * A content script has classified the page it is running on.
 * The worker owns every decision and every navigation; the content script only
 * ever reports and, if told to, focuses a field or fills a form with a
 * credential the worker hands it.
 *
 * `url` is `sender.url` from the runtime message — the page's own report of
 * its site/state is trusted for classification, but the URL used to decide
 * whether a credential ever leaves the worker always comes from the message
 * sender metadata, never from the message body. A compromised page can lie
 * about `state`; it cannot make Chrome lie about `sender.url`.
 *
 * There used to be an attempt-cap here: automated submission meant a wrong
 * PIN resubmitted on every page load could lock the owner's library card, so
 * failures were counted at hand-out time and autofill disabled itself after
 * two in a row. Three independent audits found six distinct ways to defeat
 * that cap, and each fix round introduced a new hole. Automated submission
 * has since been removed entirely — src/content/autofill.js fills the form
 * and stops; the owner presses Enter — which eliminates the runaway-attempts
 * risk rather than mitigating it. See
 * docs/superpowers/specs/2026-08-12-book-lookup-extension-design.md,
 * "Credential handling", for the history.
 *
 * OUTBOUND SIGN-IN REDIRECT: SFPL (and Goodreads' /search) serve search
 * results to logged-out visitors, so a tab this extension opened can land
 * on `results` while signed out — the login page never appears, so the
 * stored-credential autofill never gets a chance to fire. When that happens
 * on a tab this extension itself opened (proven by a *live* intent existing
 * for the tab before `decide()` runs, recorded for the SAME site as this
 * report — a live intent for a different site does not count, or one SFPL
 * search tab could authorize a redirect on Goodreads or StoryGraph just by
 * browsing there afterward — and a credential is on file, the worker sends
 * the tab to the site's real login page instead, recording a fresh intent
 * whose `targetUrl` is the current results page (from `sender.url`, never
 * the message body) so the existing `login` → `authed` → resume machinery
 * in decide() carries the tab back once the owner signs in.
 *
 * Before doing any of that, the adapter resolved from the page-supplied
 * `site` must have `hostMatch` exactly equal to `new URL(sender.url).host`
 * — mirroring `shouldAutofill`'s own host check, exact equality only, never
 * a substring test. `site` is attacker-controlled message content; without
 * this check a compromised page on one permitted host could name a
 * different site and get this tab driven to that site's login page with the
 * resume target pinned to the compromised page's own URL.
 *
 * The `redirectedTabs` / `signinAttempt` marker caps this at exactly one
 * redirect per tab, ever — see the comment above `redirectedTabs` for why
 * it is never cleared or expired. A tab whose intent already has
 * `resumed: true` is refused too: that intent already completed its one
 * round trip and must not be recycled into grounds for another redirect.
 *
 * This never touches a tab the extension did not open: ordinary browsing to
 * a `results` URL has no intent recorded for its tab at all, so the
 * live-intent check refuses it before the credential check is even reached.
 */
async function handlePageReport({ site, state, signedIn }, tabId, url) {
  // Finding 4 + 5: see the comment above `busyTabs`. This check-and-claim is
  // the very first thing the function does, synchronously, before any
  // `await` — that is what makes it atomic against concurrent reports for
  // the same tab.
  //
  // N1: a refused report used to just vanish — no autofill hand-out, no
  // badge, no resume, and nothing to say any of that was skipped. `busy:
  // true` tells the caller (src/content/runner.js) it lost the race so it
  // can retry instead of the page silently going unfilled. This is a hint,
  // not a promise: the retry is the content script's job, bounded there to
  // exactly one attempt.
  if (busyTabs.has(tabId)) return { focus: false, busy: true };
  busyTabs.add(tabId);

  try {
    const adapter = getAdapter(site);
    if (!adapter) return { focus: false };

    const now = Date.now();
    const priorIntent = await readIntent(tabId);
    const priorLive = liveIntent(priorIntent, now);
    // Finding 2: a live intent only authorizes a redirect for the site it
    // was actually recorded for.
    const hadLiveIntent = Boolean(priorLive) && priorLive.site === site;
    const alreadyResumed = Boolean(priorIntent && priorIntent.resumed);

    const decision = decide(priorIntent, { state, now });

    await writeIntent(tabId, decision.intent);
    await setBadge(tabId, decision.badge);

    if (decision.action === 'resume' && decision.targetUrl) {
      await chrome.tabs.update(tabId, { url: decision.targetUrl });
      return { focus: false };
    }

    const credential = await loadCredential(site);

    if (state === 'results' && signedIn === false && hadLiveIntent && credential && !alreadyResumed) {
      // Finding 3: never trust the message body's `site` on its own —
      // require it to name the adapter that matches the real host Chrome
      // reports for the sender.
      //
      // N3: this must also require `https:`, exactly like `shouldAutofill`'s
      // own scheme guard — without it, an `http:` sender URL would still
      // pass the host check, get redirected, and have its `targetUrl` (the
      // sender URL itself) pinned into the fresh intent, so the eventual
      // resume would navigate back to `http://…`. Unreachable today because
      // `content_scripts` only match `https://*`, but this check is meant to
      // mirror `shouldAutofill`'s and was one guard short of actually doing
      // so.
      let senderUrl = null;
      try {
        senderUrl = new URL(url);
      } catch {
        senderUrl = null;
      }
      const hostMatchesSender =
        senderUrl !== null && senderUrl.protocol === 'https:' && adapter.hostMatch === senderUrl.host;

      if (hostMatchesSender) {
        // Finding 1: synchronous check-and-claim of the permanent, never-
        // cleared marker. `busyTabs` above already guarantees only one call
        // can be executing this section for this tab at a time, but the
        // check and the claim stay adjacent here too, matching the pattern
        // and making the one-shot invariant obvious on its own.
        if (!redirectedTabs.has(tabId)) {
          redirectedTabs.add(tabId);

          // Backup check for a worker restart, which wipes redirectedTabs.
          const persisted = await readSigninAttempt(tabId);
          if (!persisted) {
            await writeSigninAttempt(tabId, true);
            await writeIntent(tabId, createIntent({ tabId, site, targetUrl: url, now }));
            await chrome.tabs.update(tabId, {
              url: `https://${adapter.hostMatch}${adapter.loginPath}`,
            });
          }
        }
        return { focus: false };
      }
    }

    const autofillDecision = shouldAutofill({
      hasCredential: Boolean(credential),
      state,
      url,
      adapter,
    });

    if (autofillDecision.fill) {
      return { focus: false, autofill: { username: credential.username, secret: credential.secret } };
    }

    return { focus: decision.action === 'focus' };
  } finally {
    busyTabs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'search') {
    runSearch(message).then(sendResponse).catch(() => sendResponse({ opened: 0 }));
    return true;
  }

  if (message.type === 'page') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ focus: false });
      return false;
    }
    handlePageReport(message, tabId, sender.url)
      .then(sendResponse)
      .catch(() => sendResponse({ focus: false }));
    return true;
  }

  return false;
});

// Abandon an intent, and the one-shot sign-in-redirect marker, when its tab
// closes. This is the ONLY place the redirect marker is ever cleared — see
// the comment above `redirectedTabs`.
chrome.tabs.onRemoved.addListener((tabId) => {
  // N2: mark the tab closed BEFORE anything else, so a `handlePageReport`
  // call already in flight for it (started before this event fired) sees
  // `closedTabs.has(tabId)` the next time it calls `writeIntent` /
  // `writeSigninAttempt` and skips writing real state back in. The removal
  // calls right below are exempt from that guard themselves (see their
  // `else` branches), so clearing here still runs regardless of ordering.
  closedTabs.add(tabId);
  // N4: fire-and-forget, same as everywhere else in this file — a rejected
  // `storage.remove` (e.g. a torn-down session store) must not surface as an
  // unhandled promise rejection.
  writeIntent(tabId, null).catch(() => {});
  writeSigninAttempt(tabId, null).catch(() => {});
  redirectedTabs.delete(tabId);
  // N2: `busyTabs` is deliberately left alone here. A handler still in
  // flight for this tab owns its own entry and releases it in its `finally`
  // block when it finishes — see the comment above `busyTabs`. Deleting it
  // here instead would briefly unlock a tab whose decide-and-navigate
  // section is still executing, defeating the very guard `busyTabs` exists
  // to provide.
});

// There is deliberately no chrome.tabs.onUpdated listener here. Without the
// `tabs` permission, Chrome withholds changeInfo.url for exactly the
// off-host navigations such a handler would need to see, so it could never
// fire for the case it exists to catch. Acquiring `tabs` to make it work
// would cost more — URL visibility across every tab — than the guard is
// worth: the `resumed` flag plus the intent TTL already make
// double-navigation impossible without it.
