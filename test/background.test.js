import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAdapter } from '../src/sites/index.js';
import { createIntent } from '../src/lib/intents.js';

/**
 * Exercises the REAL, unmodified src/background.js — including the real
 * src/lib/intents.js, src/lib/autofill-policy.js and src/lib/credentials.js
 * it imports — against a stubbed chrome global.
 *
 * This is the coverage for the outbound sign-in redirect: SFPL (and
 * Goodreads' /search) serve search results to logged-out visitors, so a tab
 * this extension opened can land on `results` while signed out and never
 * see the login page at all, meaning stored-credential autofill never gets
 * a chance to fire. background.js now sends such a tab to the site's real
 * login page instead, once, and lets the existing intent/resume machinery
 * carry it back to the results page once the owner signs in.
 *
 * background.js otherwise has no other automated tests (see README's "known
 * gap" note) — search dispatch and the plain login-focus/autofill hand-out
 * path outside of this flow stay untested here.
 */

const sfpl = getAdapter('sfpl');
const goodreads = getAdapter('goodreads');
const storygraph = getAdapter('storygraph');
const LOGIN_URL = `https://${sfpl.hostMatch}${sfpl.loginPath}`;
const RESULTS_URL = `https://${sfpl.hostMatch}/v2/search?query=Dune&searchType=keyword`;
const GOODREADS_RESULTS_URL = `https://${goodreads.hostMatch}/search?q=Dune`;
const GOODREADS_LOGIN_URL = `https://${goodreads.hostMatch}${goodreads.loginPath}`;
const STORYGRAPH_RESULTS_URL = `https://${storygraph.hostMatch}/browse?search_term=Dune`;
const NOW = 1_700_000_000_000;

function makeFakeArea(initial = {}) {
  let store = { ...initial };
  const get = vi.fn((keys) => {
    if (typeof keys === 'string') {
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(store, keys) ? { [keys]: store[keys] } : {}
      );
    }
    if (Array.isArray(keys)) {
      const result = {};
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
      }
      return Promise.resolve(result);
    }
    if (keys && typeof keys === 'object') {
      return Promise.resolve({ ...keys, ...store });
    }
    return Promise.resolve({ ...store });
  });
  const set = vi.fn((partial) => {
    store = { ...store, ...partial };
    return Promise.resolve();
  });
  const remove = vi.fn((keys) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
    return Promise.resolve();
  });
  return { get, set, remove, _dump: () => ({ ...store }) };
}

async function loadBackground({ localInitial = {}, sessionInitial = {} } = {}) {
  vi.resetModules();

  const local = makeFakeArea(localInitial);
  const session = makeFakeArea(sessionInitial);
  let onMessageListener = null;
  let onRemovedListener = null;

  globalThis.chrome = {
    storage: { local, session },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          onMessageListener = fn;
        },
      },
    },
    tabs: {
      create: vi.fn(async ({ url, active }) => ({ id: 1, url, active })),
      update: vi.fn(async () => {}),
      onRemoved: {
        addListener: (fn) => {
          onRemovedListener = fn;
        },
      },
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
    },
  };

  await import('../src/background.js');

  return {
    local,
    session,
    chrome: globalThis.chrome,
    sendMessage: (message, sender) =>
      new Promise((resolve) => {
        onMessageListener(message, sender, resolve);
      }),
    removeTab: (tabId) => onRemovedListener(tabId),
  };
}

function pageReport(state, signedIn, site = 'sfpl') {
  const message = { type: 'page', site, state };
  if (signedIn !== undefined) message.signedIn = signedIn;
  return message;
}

function sender(tabId, url) {
  return { tab: { id: tabId }, url };
}

function seededIntent(tabId, targetUrl = RESULTS_URL, now = NOW, site = 'sfpl') {
  return createIntent({ tabId, site, targetUrl, now });
}

const CREDENTIAL = { username: 'card-1', secret: '1234' };

beforeEach(() => {
  delete globalThis.chrome;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('outbound sign-in redirect', () => {
  it('redirects to the login page: results + signedIn:false + credential + a live prior intent', async () => {
    const { sendMessage, chrome, session } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    const reply = await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));

    expect(reply).toEqual({ focus: false });
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: LOGIN_URL });

    // Finding 1: the marker is a bare one-shot-forever flag now — no site,
    // no expiry, nothing that could ever let it be waited out or cleared
    // by anything other than the tab closing.
    expect(session._dump()['signinAttempt:1']).toBe(true);

    const newIntent = session._dump()['intent:1'];
    expect(newIntent.targetUrl).toBe(RESULTS_URL);
    expect(newIntent.site).toBe('sfpl');
    expect(newIntent.resumed).toBe(false);
  });

  it('redirects at most once per tab per TTL window, even reported 10 times in a row', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));
    }

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: LOGIN_URL });
  });

  it('Finding 1: signedIn:true does NOT clear an existing marker (it is one-shot forever)', async () => {
    const { sendMessage, chrome, session } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: {
        'intent:1': seededIntent(1),
        'signinAttempt:1': true,
      },
    });

    await sendMessage(pageReport('results', true), sender(1, RESULTS_URL));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
    // The old behavior cleared the marker here, on the exact report that
    // immediately precedes a resume — which is what let a genuinely
    // signed-in owner get bounced back to the login page again. The marker
    // must survive every report except the tab actually closing.
    expect(session._dump()['signinAttempt:1']).toBe(true);
  });

  it('does not redirect when signedIn is false but no credential is stored', async () => {
    const { sendMessage, chrome } = await loadBackground({
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('does not redirect ordinary browsing the extension never opened (no live prior intent)', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      // No intent seeded for this tab at all — this tab was not opened by runSearch.
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('does not redirect when signedIn is missing/undefined', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', undefined), sender(1, RESULTS_URL));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('Finding 1: the marker never expires — a marker set long ago still blocks a further redirect', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: {
        'intent:1': seededIntent(1),
        // Old design would have called this expired (`expiresAt: NOW - 1`)
        // and let a further redirect through. There is no expiresAt at all
        // now — presence alone means "never again".
        'signinAttempt:1': true,
      },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('a marker on one tab does not block a redirect on a different tab', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: {
        'signinAttempt:1': true,
        'intent:2': seededIntent(2),
      },
    });

    await sendMessage(pageReport('results', false), sender(2, RESULTS_URL));

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { url: LOGIN_URL });
  });

  it('tab removal clears both the intent and the sign-in-attempt marker', async () => {
    const { session, removeTab } = await loadBackground({
      sessionInitial: {
        'intent:1': seededIntent(1),
        'signinAttempt:1': true,
      },
    });

    removeTab(1);
    await Promise.resolve();

    expect(session._dump()['intent:1']).toBeUndefined();
    expect(session._dump()['signinAttempt:1']).toBeUndefined();
  });
});

describe('the round trip back through login and resume', () => {
  it('after the redirect, the login page reports login and autofill is handed out', async () => {
    const { sendMessage } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));
    const loginReply = await sendMessage(pageReport('login', false), sender(1, LOGIN_URL));

    expect(loginReply.autofill).toEqual(CREDENTIAL);
  });

  it('an authed report after that resumes to the results URL exactly once', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));
    await sendMessage(pageReport('login', false), sender(1, LOGIN_URL));
    chrome.tabs.update.mockClear();

    await sendMessage(pageReport('authed', true), sender(1, LOGIN_URL));
    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: RESULTS_URL });

    // The one-resume guarantee: a second authed report must not resume again.
    chrome.tabs.update.mockClear();
    await sendMessage(pageReport('authed', true), sender(1, LOGIN_URL));
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('end-to-end: results (logged out) -> login -> authed -> back at results, one redirect and one resume total', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));
    await sendMessage(pageReport('login', false), sender(1, LOGIN_URL));
    await sendMessage(pageReport('authed', true), sender(1, LOGIN_URL));
    await sendMessage(pageReport('results', true), sender(1, RESULTS_URL));

    const loginCalls = chrome.tabs.update.mock.calls.filter(([, opts]) => opts.url === LOGIN_URL);
    const resultsCalls = chrome.tabs.update.mock.calls.filter(([, opts]) => opts.url === RESULTS_URL);

    expect(loginCalls).toHaveLength(1);
    expect(resultsCalls).toHaveLength(1);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);
  });
});

/**
 * Coverage for the five DO-NOT-SHIP findings from the adversarial audit of
 * the outbound sign-in redirect: an infinite results<->login ping-pong
 * (Finding 1), cross-site marker evasion (Finding 2), a page-supplied `site`
 * untied to the real host (Finding 3), a non-atomic guard race (Finding 4),
 * and a resume/redirect double-navigation race (Finding 5).
 */
describe('adversarial audit fixes', () => {
  it('Finding 1: results(logged out) -> login -> authed -> resume -> results reported AGAIN logged out must NOT redirect a second time', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL)); // redirect #1
    await sendMessage(pageReport('login', false), sender(1, LOGIN_URL));
    await sendMessage(pageReport('authed', true), sender(1, LOGIN_URL)); // resume
    // The resumed results page fails to render an AUTHED_SELECTORS control
    // in time (client-rendered account menu) and reports logged-out again —
    // this is the exact report that used to disarm the guard and loop.
    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));

    const loginCalls = chrome.tabs.update.mock.calls.filter(([, opts]) => opts.url === LOGIN_URL);
    expect(loginCalls).toHaveLength(1);
  });

  it('Finding 1: a 40-step honest sign-in simulation produces exactly one redirect total', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    const cycle = [
      pageReport('results', false),
      pageReport('login', false),
      pageReport('authed', true),
      pageReport('results', false), // resumed page still looks logged-out
    ];
    const urlFor = (message) => (message.state === 'login' ? LOGIN_URL : RESULTS_URL);

    for (let step = 0; step < 40; step += 1) {
      const message = cycle[step % cycle.length];
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(message, sender(1, urlFor(message)));
    }

    const loginCalls = chrome.tabs.update.mock.calls.filter(([, opts]) => opts.url === LOGIN_URL);
    expect(loginCalls).toHaveLength(1);
  });

  it('Finding 2: alternating sites in one tab (sfpl -> goodreads -> storygraph -> sfpl, x10) produces exactly one redirect', async () => {
    // Credentials stored for all three sites — the realistic case, and the
    // one that actually exercises the bug: the old code's cross-site hole
    // only matters when a credential exists for the site being hijacked to.
    const { sendMessage, chrome } = await loadBackground({
      localInitial: {
        'cred:sfpl': CREDENTIAL,
        'cred:goodreads': CREDENTIAL,
        'cred:storygraph': CREDENTIAL,
      },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(pageReport('results', false, 'sfpl'), sender(1, RESULTS_URL));
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(pageReport('results', false, 'goodreads'), sender(1, GOODREADS_RESULTS_URL));
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(pageReport('results', false, 'storygraph'), sender(1, STORYGRAPH_RESULTS_URL));
    }

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: LOGIN_URL });
  });

  it('Finding 3: a Goodreads-hosted page reporting site:"sfpl" is refused (page-supplied site must match sender.url host)', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', false, 'sfpl'), sender(1, GOODREADS_RESULTS_URL));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('Finding 3: a Goodreads page correctly reporting site:"goodreads" still redirects to Goodreads login, not SFPL', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:goodreads': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1, GOODREADS_RESULTS_URL, NOW, 'goodreads') },
    });

    await sendMessage(pageReport('results', false, 'goodreads'), sender(1, GOODREADS_RESULTS_URL));

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: GOODREADS_LOGIN_URL });
  });

  it('Finding 4: N concurrent identical reports for one tab produce exactly one redirect', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    const N = 12;
    await Promise.all(
      Array.from({ length: N }, () => sendMessage(pageReport('results', false), sender(1, RESULTS_URL)))
    );

    const loginCalls = chrome.tabs.update.mock.calls.filter(([, opts]) => opts.url === LOGIN_URL);
    expect(loginCalls).toHaveLength(1);
  });

  it('Finding 5: concurrent authed + results reports for one tab produce exactly one chrome.tabs.update', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await Promise.all([
      sendMessage(pageReport('authed', true), sender(1, LOGIN_URL)),
      sendMessage(pageReport('results', false), sender(1, RESULTS_URL)),
    ]);

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
  });

  it('the marker survives across many reports and is removed only on tabs.onRemoved', async () => {
    const { sendMessage, session, removeTab } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));
    expect(session._dump()['signinAttempt:1']).toBe(true);

    await sendMessage(pageReport('login', false), sender(1, LOGIN_URL));
    await sendMessage(pageReport('authed', true), sender(1, LOGIN_URL));
    await sendMessage(pageReport('results', true), sender(1, RESULTS_URL));
    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));
    expect(session._dump()['signinAttempt:1']).toBe(true);

    removeTab(1);
    await Promise.resolve();

    expect(session._dump()['signinAttempt:1']).toBeUndefined();
  });

  it('a different tab is still free to redirect once, unaffected by another tab\'s marker or race guards', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: {
        'signinAttempt:1': true,
        'intent:2': seededIntent(2),
      },
    });

    await sendMessage(pageReport('results', false), sender(2, RESULTS_URL));

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { url: LOGIN_URL });
  });

  it('re-verify: still exactly ONE outbound redirect per tab across a 100-step honest cycle, and one resume max', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    const cycle = [
      pageReport('results', false),
      pageReport('login', false),
      pageReport('authed', true),
      pageReport('results', true),
    ];
    const urlFor = (message) => (message.state === 'login' ? LOGIN_URL : RESULTS_URL);

    for (let step = 0; step < 100; step += 1) {
      const message = cycle[step % cycle.length];
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(message, sender(1, urlFor(message)));
    }

    const loginCalls = chrome.tabs.update.mock.calls.filter(([, opts]) => opts.url === LOGIN_URL);
    const resultsCalls = chrome.tabs.update.mock.calls.filter(([, opts]) => opts.url === RESULTS_URL);
    expect(loginCalls).toHaveLength(1);
    expect(resultsCalls).toHaveLength(1);
  });
});

/**
 * N1: a report refused because the tab is busy (see `busyTabs`) used to be
 * dropped completely — no autofill hand-out, no badge, no resume, and no
 * signal that anything was skipped. The worker now says so (`busy: true`)
 * so src/content/runner.js (see test/runner.test.js for its own coverage)
 * can retry once. These tests cover the worker's half: producing that
 * signal, and actually landing the resume once the refused report is
 * resent.
 */
describe('N1: busy refusal signals busy:true and a resend recovers it', () => {
  it('a busy-refused report replies { focus: false, busy: true }', async () => {
    const { sendMessage } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    const [loginReply, authedReply] = await Promise.all([
      sendMessage(pageReport('login', false), sender(1, LOGIN_URL)),
      sendMessage(pageReport('authed', true), sender(1, LOGIN_URL)),
    ]);

    // JS is single-threaded (see the busyTabs comment in background.js), so
    // dispatch order is deterministic: `login` is evaluated first and claims
    // the lock; `authed` — the one report actually carrying the resume — is
    // the one refused.
    expect(loginReply.busy).toBeUndefined();
    expect(authedReply).toEqual({ focus: false, busy: true });
  });

  it('reproduction: concurrent login+authed on one tab drops the resume; resending the refused report lands it', async () => {
    const { sendMessage, chrome, session } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    const [, authedReply] = await Promise.all([
      sendMessage(pageReport('login', false), sender(1, LOGIN_URL)),
      sendMessage(pageReport('authed', true), sender(1, LOGIN_URL)),
    ]);

    // Before the fix, this refusal was the end of the story: zero
    // navigations, ever, and the intent stuck with resumed:false forever.
    expect(authedReply).toEqual({ focus: false, busy: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(session._dump()['intent:1'].resumed).toBe(false);

    // src/content/runner.js is what actually performs this resend on a
    // `busy: true` reply (test/runner.test.js covers that half in
    // isolation) — simulated here directly to prove the worker now has a
    // resume to give it once it does.
    await sendMessage(pageReport('authed', true), sender(1, LOGIN_URL));

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: RESULTS_URL });
    expect(session._dump()['intent:1'].resumed).toBe(true);
  });
});

/**
 * N2: a handler that is still running when its tab closes (it awaited
 * storage/adapter work started before `chrome.tabs.onRemoved` fired) used to
 * be able to write `intent:<id>` / `signinAttempt:<id>` back into session
 * storage AFTER `onRemoved` had already cleared them, leaking that state
 * forever — nothing else ever revisits a closed tab's keys. `closedTabs`
 * (background.js) now makes those write paths skip persisting once a tab is
 * known closed.
 */
describe('N2: a tab closed mid-flight leaves no leaked session-storage keys', () => {
  it('the outbound-redirect writes started before close do not resurrect intent:/signinAttempt: after the tab is gone', async () => {
    const { sendMessage, session, removeTab } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    // Delay the very first storage read this report makes (readIntent, at
    // the top of handlePageReport) so the tab can be closed while this
    // report is still "in flight" between that read and its later writes —
    // exactly the race N2 closes. The snapshot returned once released is
    // fixed to what the intent looked like at the moment the read was
    // issued — NOT re-queried from the live store, which `removeTab` below
    // will have already cleared by the time this resolves. That distinction
    // is the whole test: the handler saw live state that the tab's closure
    // invalidated out from under it while the read was still pending.
    let releaseRead;
    const gate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const snapshot = { 'intent:1': seededIntent(1) };
    session.get.mockImplementationOnce(async () => {
      await gate;
      return snapshot;
    });

    const reportPromise = sendMessage(pageReport('results', false), sender(1, RESULTS_URL));

    removeTab(1);
    await Promise.resolve();
    await Promise.resolve();

    releaseRead();
    await reportPromise;

    expect(session._dump()['intent:1']).toBeUndefined();
    expect(session._dump()['signinAttempt:1']).toBeUndefined();
  });
});

/**
 * N3: the redirect path's host check must require `https:` too, exactly
 * like `shouldAutofill`'s own scheme guard, or a (currently unreachable —
 * content_scripts only match https://*) http: sender URL would pass on host
 * alone, get redirected, and pin its http: URL into the fresh intent as the
 * resume target.
 */
describe('N3: the redirect path requires https:, not just a matching host', () => {
  it('an http: sender URL is refused even though the host matches', async () => {
    const { sendMessage, chrome, session } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: { 'intent:1': seededIntent(1) },
    });

    const httpResultsUrl = RESULTS_URL.replace('https://', 'http://');
    await sendMessage(pageReport('results', false), sender(1, httpResultsUrl));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(session._dump()['signinAttempt:1']).toBeUndefined();
    expect(session._dump()['intent:1']).toBeUndefined();
  });
});

/**
 * N4: writeIntent/writeSigninAttempt in `chrome.tabs.onRemoved` are
 * fire-and-forget (nothing awaits `onRemoved`'s listener). A rejected
 * `storage.session.remove` — e.g. a torn-down session store on shutdown —
 * used to surface as an unhandled promise rejection.
 */
describe('N4: onRemoved cleanup does not produce unhandled rejections', () => {
  it('a failing storage.remove during tab removal is swallowed, not unhandled', async () => {
    const { session, removeTab } = await loadBackground({
      sessionInitial: { 'intent:1': seededIntent(1), 'signinAttempt:1': true },
    });
    session.remove.mockRejectedValueOnce(new Error('boom'));

    const unhandled = [];
    const onUnhandledRejection = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      removeTab(1);
      // Flush the microtask queue the rejected/caught promise chain runs on.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandled).toHaveLength(0);
  });
});
