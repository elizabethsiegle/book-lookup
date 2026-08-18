import { ADAPTERS, getAdapter } from './sites/index.js';
import { createIntent, decide } from './lib/intents.js';
import { BADGE } from './lib/badges.js';
import { normalizeQuery, normalizeMode } from './lib/query.js';
import { loadCredential, loadFailures, saveFailures } from './lib/credentials.js';
import { shouldAutofill, recordOutcome } from './lib/autofill-policy.js';

const intentKey = (tabId) => `intent:${tabId}`;
const autofillPendingKey = (tabId) => `autofillPending:${tabId}`;

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

async function readAutofillPending(tabId) {
  const key = autofillPendingKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return Boolean(stored[key]);
}

async function markAutofillPending(tabId) {
  await chrome.storage.session.set({ [autofillPendingKey(tabId)]: true });
}

async function clearAutofillPending(tabId) {
  await chrome.storage.session.remove(autofillPendingKey(tabId));
}

/**
 * Folds the outcome of a submission made on the PREVIOUS page load into that
 * site's consecutive-failure count, if one is pending for this tab. A
 * failure is: we submitted, the page reloaded, and it still classifies as
 * `login`; anything else counts as success. The marker clears either way —
 * it only ever judges the one page load right after a submission.
 */
async function resolvePendingAutofill(tabId, site, state) {
  const pending = await readAutofillPending(tabId);
  if (!pending) return;

  const outcome = state === 'login' ? 'failure' : 'success';
  const currentFailures = await loadFailures(site);
  const { failures } = recordOutcome(currentFailures, outcome);
  await saveFailures(site, failures);
  await clearAutofillPending(tabId);
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
 */
async function handlePageReport({ site, state }, tabId, url) {
  const adapter = getAdapter(site);
  if (!adapter) return { focus: false };

  await resolvePendingAutofill(tabId, site, state);

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

  if (autofillDecision.reason === 'disabled') {
    await setBadge(tabId, 'AUTOFILL_OFF');
  }

  if (autofillDecision.fill) {
    return { focus: false, autofill: { username: credential.username, secret: credential.secret } };
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

  if (message.type === 'autofill-submitted') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false });
      return false;
    }
    markAutofillPending(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

// Abandon an intent when its tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  writeIntent(tabId, null);
  clearAutofillPending(tabId);
});

// There is deliberately no chrome.tabs.onUpdated listener here. Without the
// `tabs` permission, Chrome withholds changeInfo.url for exactly the
// off-host navigations such a handler would need to see, so it could never
// fire for the case it exists to catch. Acquiring `tabs` to make it work
// would cost more — URL visibility across every tab — than the guard is
// worth: the `resumed` flag plus the intent TTL already make
// double-navigation impossible without it.
