import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAdapter } from '../src/sites/index.js';
import { createIntent, INTENT_TTL_MS } from '../src/lib/intents.js';

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
const LOGIN_URL = `https://${sfpl.hostMatch}${sfpl.loginPath}`;
const RESULTS_URL = `https://${sfpl.hostMatch}/v2/search?query=Dune&searchType=keyword`;
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

function pageReport(state, signedIn) {
  const message = { type: 'page', site: 'sfpl', state };
  if (signedIn !== undefined) message.signedIn = signedIn;
  return message;
}

function sender(tabId, url) {
  return { tab: { id: tabId }, url };
}

function seededIntent(tabId, targetUrl = RESULTS_URL, now = NOW) {
  return createIntent({ tabId, site: 'sfpl', targetUrl, now });
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

    expect(session._dump()['signinAttempt:1']).toEqual({
      site: 'sfpl',
      expiresAt: NOW + INTENT_TTL_MS,
    });

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

  it('does not redirect when signedIn is true, and clears any existing marker', async () => {
    const { sendMessage, chrome, session } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: {
        'intent:1': seededIntent(1),
        'signinAttempt:1': { site: 'sfpl', expiresAt: NOW + INTENT_TTL_MS },
      },
    });

    await sendMessage(pageReport('results', true), sender(1, RESULTS_URL));

    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(session._dump()['signinAttempt:1']).toBeUndefined();
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

  it('an expired marker is treated as absent and allows a further redirect', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: {
        'intent:1': seededIntent(1),
        'signinAttempt:1': { site: 'sfpl', expiresAt: NOW - 1 },
      },
    });

    await sendMessage(pageReport('results', false), sender(1, RESULTS_URL));

    expect(chrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: LOGIN_URL });
  });

  it('a marker on one tab does not block a redirect on a different tab', async () => {
    const { sendMessage, chrome } = await loadBackground({
      localInitial: { 'cred:sfpl': CREDENTIAL },
      sessionInitial: {
        'signinAttempt:1': { site: 'sfpl', expiresAt: NOW + INTENT_TTL_MS },
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
        'signinAttempt:1': { site: 'sfpl', expiresAt: NOW + INTENT_TTL_MS },
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
