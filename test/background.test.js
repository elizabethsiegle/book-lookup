import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getAdapter } from '../src/sites/index.js';

/**
 * Exercises the REAL, unmodified src/background.js — including the real
 * src/lib/autofill-policy.js and src/lib/credentials.js it imports — against
 * a stubbed chrome global. This is the permanent regression coverage for the
 * 2026-08-18 review's Finding 1 (attempt-cap redesign): failures must now be
 * counted at hand-out time, not at confirmation time, so a lost/skipped
 * confirmation can never keep the cap from tripping.
 *
 * background.js otherwise has no automated tests (see README's "known gap"
 * note); this file covers only the autofill hand-out/count/reset path, not
 * search dispatch or intent/resume behavior, which stay untested here.
 */

const sfpl = getAdapter('sfpl');
const LOGIN_URL = `https://${sfpl.hostMatch}${sfpl.loginPath}`;

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

async function loadBackground({ localInitial = {} } = {}) {
  vi.resetModules();

  const local = makeFakeArea(localInitial);
  const session = makeFakeArea({});
  let onMessageListener = null;

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
      onRemoved: { addListener: vi.fn() },
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
  };
}

function pageReport(state) {
  return { type: 'page', site: 'sfpl', state };
}

function sender(tabId = 1) {
  return { tab: { id: tabId }, url: LOGIN_URL };
}

beforeEach(() => {
  delete globalThis.chrome;
});

describe('attempt-cap redesign: counting happens at hand-out, not confirmation', () => {
  it('hands out the credential on the first login-page report', async () => {
    const { sendMessage, local } = await loadBackground({
      localInitial: { 'cred:sfpl': { username: 'card-1', secret: '1234' } },
    });

    const reply = await sendMessage(pageReport('login'), sender());

    expect(reply.autofill).toEqual({ username: 'card-1', secret: '1234' });
    expect(local._dump()['autofillFailures:sfpl']).toBe(1);
  });

  it('two hand-outs disable the site, with no confirmation message ever sent', async () => {
    const { sendMessage, local } = await loadBackground({
      localInitial: { 'cred:sfpl': { username: 'card-1', secret: '1234' } },
    });

    // Two separate page loads, each independently deciding to hand out the
    // credential. Nothing resembling the old `autofill-submitted` message is
    // ever sent — there is no such message anymore, and the cap must still
    // trip on hand-outs alone.
    const first = await sendMessage(pageReport('login'), sender());
    const second = await sendMessage(pageReport('login'), sender());

    expect(first.autofill).toBeTruthy();
    expect(second.autofill).toBeTruthy();
    expect(local._dump()['autofillFailures:sfpl']).toBe(2);

    const third = await sendMessage(pageReport('login'), sender());
    expect(third.autofill).toBeUndefined();
    expect(local._dump()['autofillFailures:sfpl']).toBe(2);
  });

  it('a lost confirmation cannot prevent the cap from tripping', async () => {
    // Simulates exactly the reproduced failure from the review: N page loads
    // in a row, each a wrong-PIN submission, with the content script's
    // confirmation never modeled at all (because it no longer exists). If
    // counting still depended on a confirmation step, this would stay armed
    // forever, same as the review's "6/6 loads armed, cap never trips" repro.
    const { sendMessage, local } = await loadBackground({
      localInitial: { 'cred:sfpl': { username: 'card-1', secret: 'wrong-pin' } },
    });

    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(pageReport('login'), sender());
    }

    expect(local._dump()['autofillFailures:sfpl']).toBe(2);
    const stillArmed = await sendMessage(pageReport('login'), sender());
    expect(stillArmed.autofill).toBeUndefined();
  });

  it('a challenge page after a hand-out does NOT reset the count', async () => {
    const { sendMessage, local } = await loadBackground({
      localInitial: { 'cred:sfpl': { username: 'card-1', secret: '1234' } },
    });

    await sendMessage(pageReport('login'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(1);

    await sendMessage(pageReport('challenge'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(1);

    // The count survived the challenge, so the very next hand-out reaches
    // the cap — proving the challenge was neither a success nor a no-op that
    // quietly erased history.
    await sendMessage(pageReport('login'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(2);
  });

  it('an unknown page after a hand-out does NOT reset the count', async () => {
    const { sendMessage, local } = await loadBackground({
      localInitial: { 'cred:sfpl': { username: 'card-1', secret: '1234' } },
    });

    await sendMessage(pageReport('login'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(1);

    // The document_idle recheck reporting `unknown` on a still-rendering
    // client-side login page — the exact shape of the second reproduced bug.
    await sendMessage(pageReport('unknown'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(1);

    await sendMessage(pageReport('login'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(2);
  });

  it('an authed page DOES reset the count', async () => {
    const { sendMessage, local } = await loadBackground({
      localInitial: {
        'cred:sfpl': { username: 'card-1', secret: '1234' },
        'autofillFailures:sfpl': 2,
      },
    });

    // Disabled going in: a login-page report gets no credential.
    const disabled = await sendMessage(pageReport('login'), sender());
    expect(disabled.autofill).toBeUndefined();

    await sendMessage(pageReport('authed'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(0);

    // Re-armed: the very next login page gets the credential again.
    const rearmed = await sendMessage(pageReport('login'), sender());
    expect(rearmed.autofill).toBeTruthy();
  });

  it('a results page DOES reset the count', async () => {
    const { sendMessage, local } = await loadBackground({
      localInitial: {
        'cred:sfpl': { username: 'card-1', secret: '1234' },
        'autofillFailures:sfpl': 2,
      },
    });

    await sendMessage(pageReport('results'), sender());
    expect(local._dump()['autofillFailures:sfpl']).toBe(0);
  });
});
