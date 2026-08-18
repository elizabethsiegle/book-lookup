import { ADAPTERS, getAdapter } from './sites/index.js';
import { createIntent, decide } from './lib/intents.js';
import { BADGE } from './lib/badges.js';
import { normalizeQuery, normalizeMode } from './lib/query.js';
import { loadCredential, loadFailures, saveFailures } from './lib/credentials.js';
import { shouldAutofill, recordOutcome } from './lib/autofill-policy.js';

const intentKey = (tabId) => `intent:${tabId}`;

async function readIntent(tabId) {
  const key = intentKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function writeIntent(tabId, intent) {
  const key = intentKey(tabId);
  if (intent) {
    await chrome.storage.session.set({ [key]: intent });
  } else {
    await chrome.storage.session.remove(key);
  }
}

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
 * ever reports and, if told to, focuses a field or fills+submits a form with
 * a credential the worker hands it.
 *
 * `url` is `sender.url` from the runtime message — the page's own report of
 * its site/state is trusted for classification, but the URL used to decide
 * whether a credential ever leaves the worker always comes from the message
 * sender metadata, never from the message body. A compromised page can lie
 * about `state`; it cannot make Chrome lie about `sender.url`.
 *
 * ATTEMPT-CAP REDESIGN (2026-08-18 review, Finding 1): failures used to be
 * counted only once a later page load re-classified as `login`, confirmed by
 * a fire-and-forget `autofill-submitted` message from the content script.
 * That made the cap defeatable three ways at once: a `challenge` or
 * `unknown` page read as SUCCESS and reset the counter; a client-rendered
 * login page's `unknown` report at document_idle could consume the pending
 * marker before the content script's own recheck ever ran; and a lost
 * `autofill-submitted` message meant a real submission was never counted at
 * all. All three shared one root cause — counting happened at confirmation
 * time, which is exactly the step an unreliable channel (page content,
 * message delivery, timing) can suppress.
 *
 * The fix moves counting to hand-out time, which the worker fully controls:
 * the instant a credential is about to leave the worker, the failure count
 * is incremented and persisted, BEFORE the reply is sent. An attempt that is
 * never confirmed — fields not found, tab closed, message lost — still
 * counts. Over-counting is the safe direction: worst case, autofill disables
 * itself a little early. Under-counting is the direction that locks the
 * library card, and that is what this redesign eliminates structurally,
 * rather than by policing every way the old confirmation channel could fail.
 *
 * The count resets to 0 only on an explicit `signedIn` signal — never on
 * `state` alone, no matter which state. This was NOT always true: an
 * earlier version of this redesign reset on `state === 'authed' ||
 * state === 'results'`, which a 2026-08-25 review found to be a new
 * Critical defect (Finding 2). `classify()` in
 * src/lib/detect-helpers.js derives `results` from the URL PATH ALONE —
 * SFPL's `/v2/search` and Goodreads' `/search` serve results to
 * logged-out visitors too — and `runSearch` above opens exactly those
 * URLs as the extension's own core action. Resetting on `results` meant
 * three ordinary searches after a bad hand-out silently re-armed the cap
 * the extension exists to enforce, directly contradicting the spec's
 * "stays off until the owner re-saves the credential." `authed` is
 * inferred by classify() the same state-alone way and carries the same
 * risk in principle, so it gets no special exemption either.
 *
 * `signedIn` is computed by the content script from
 * `matchesAny(document, AUTHED_SELECTORS)` — a real sign-out-control
 * check, not a URL guess — and travels alongside `state` in the `page`
 * message. `challenge` and `unknown` remain INDETERMINATE regardless of
 * `signedIn`: they neither increment (nothing was just handed out for
 * them) nor reset. That is why the check below still gates on `state`
 * being `authed` or `results` as well as `signedIn` — `signedIn` narrows
 * those two states from "maybe" to "proven," it does not turn every state
 * into a reset trigger on its own.
 *
 * KNOWN LIMITATION, accepted: the content script — running in the page's
 * own origin — is what supplies `signedIn`, so a page compromised on one
 * of these three origins could claim `signedIn: true` and reset the cap
 * early. That is acceptable: this cap defends against the extension's
 * OWN repeated submissions locking the card, not against a hostile page,
 * and a page compromised on these origins could already do worse than
 * nudge a failure counter.
 */
async function handlePageReport({ site, state, signedIn }, tabId, url) {
  const adapter = getAdapter(site);
  if (!adapter) return { focus: false };

  if ((state === 'authed' || state === 'results') && signedIn === true) {
    // Definitive success, proven by an actual signed-in marker — not by
    // which URL happened to load. Whatever got here — an autofilled
    // submission or the owner logging in by hand — the credential (if any)
    // is proven good right now, so past failures stop counting against the
    // cap.
    await saveFailures(site, 0);
  }

  const intent = await readIntent(tabId);
  const decision = decide(intent, { state, now: Date.now() });

  await writeIntent(tabId, decision.intent);
  await setBadge(tabId, decision.badge);

  if (decision.action === 'resume' && decision.targetUrl) {
    await chrome.tabs.update(tabId, { url: decision.targetUrl });
    return { focus: false };
  }

  const credential = await loadCredential(site);
  const failures = await loadFailures(site);
  const autofillDecision = shouldAutofill({
    hasCredential: Boolean(credential),
    failures,
    state,
    url,
    adapter,
  });

  if (autofillDecision.fill) {
    // Count NOW, before the credential ever reaches the content script. See
    // the function-level comment above: this is the one point in the whole
    // flow that cannot be skipped, lost, or lied about by the page.
    const { failures: nextFailures, disabled } = recordOutcome(failures, 'failure');
    await saveFailures(site, nextFailures);
    if (disabled) {
      await setBadge(tabId, 'AUTOFILL_OFF');
    }
    return { focus: false, autofill: { username: credential.username, secret: credential.secret } };
  }

  if (autofillDecision.reason === 'disabled') {
    await setBadge(tabId, 'AUTOFILL_OFF');
  }

  return { focus: decision.action === 'focus' };
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

// Abandon an intent when its tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  writeIntent(tabId, null);
});

// There is deliberately no chrome.tabs.onUpdated listener here. Without the
// `tabs` permission, Chrome withholds changeInfo.url for exactly the
// off-host navigations such a handler would need to see, so it could never
// fire for the case it exists to catch. Acquiring `tabs` to make it work
// would cost more — URL visibility across every tab — than the guard is
// worth: the `resumed` flag plus the intent TTL already make
// double-navigation impossible without it.
