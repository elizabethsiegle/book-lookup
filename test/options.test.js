import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Exercises the REAL, unmodified src/options/options.js against the REAL
// src/options/options.html, driven with real DOM events and a stubbed chrome
// API. Locks in a bug that was found and fixed by hand: an earlier click's
// "Saved." resolving after a later click's refusal used to overwrite the
// refusal message, and unchecking every site could leave storage holding an
// empty (i.e. "search nothing") site list.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function source(relativePath) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function loadOptionsMarkup() {
  const html = source('src/options/options.html');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

const ALL_SITES = ['sfpl', 'goodreads', 'storygraph'];

/**
 * A fake chrome.storage.local whose get()/set() resolve after a configurable
 * delay per call, so tests can force resolution order that does not match
 * call order — exactly the condition that produced the original bug.
 */
function makeFakeStorageLocal({ initial = {}, setDelays = [], getDelays = [] } = {}) {
  let store = { ...initial };
  let setCalls = 0;
  let getCalls = 0;
  const set = vi.fn((partial) => {
    const delay = setDelays[setCalls] ?? 0;
    setCalls += 1;
    return new Promise((resolve) => {
      setTimeout(() => {
        store = { ...store, ...partial };
        resolve();
      }, delay);
    });
  });
  // Mirrors real chrome.storage.local.get's three call shapes: a single key
  // string (credentials.js's usage), an array of keys, or an object of
  // key -> default (prefs.js's usage). Getting this shape-faithful matters
  // once options.js also reads per-site credential keys on init.
  const get = vi.fn((keys) => {
    const delay = getDelays[getCalls] ?? 0;
    getCalls += 1;
    return new Promise((resolve) => {
      setTimeout(() => {
        if (typeof keys === 'string') {
          resolve(Object.prototype.hasOwnProperty.call(store, keys) ? { [keys]: store[keys] } : {});
        } else if (Array.isArray(keys)) {
          const result = {};
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
          }
          resolve(result);
        } else {
          resolve({ ...keys, ...store });
        }
      }, delay);
    });
  });
  const remove = vi.fn((keys) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete store[key];
        }
        resolve();
      }, 0);
    });
  });
  return { get, set, remove, _dump: () => ({ ...store }) };
}

function flushPromises(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOptions({ storageLocal, tabsCreate } = {}) {
  vi.resetModules();
  loadOptionsMarkup();

  const local = storageLocal || makeFakeStorageLocal({ initial: { sites: [...ALL_SITES] } });
  const create = vi.fn(tabsCreate || (() => {}));
  globalThis.chrome = {
    storage: { local },
    tabs: { create },
  };

  await import('../src/options/options.js');
  await flushPromises(50);

  return {
    sitesBox: document.getElementById('sites'),
    credentialsBox: document.getElementById('credentials'),
    status: document.getElementById('status'),
    openPasswords: document.getElementById('open-passwords'),
    storageLocal: local,
    tabsCreate: create,
  };
}

function credentialEls(siteId) {
  return {
    username: document.getElementById(`cred-username-${siteId}`),
    secret: document.getElementById(`cred-secret-${siteId}`),
    save: document.getElementById(`cred-save-${siteId}`),
    clear: document.getElementById(`cred-clear-${siteId}`),
    status: document.getElementById(`cred-status-${siteId}`),
  };
}

function setInput(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function checkboxFor(sitesBox, id) {
  return sitesBox.querySelector(`input[value="${id}"]`);
}

function uncheck(checkbox) {
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('options: unchecking every site', () => {
  it('never persists an empty array and leaves the refusal message as the final status', async () => {
    // Staggered delays: the two earlier "still has a site left" saves resolve
    // LATER than the final "you unchecked the last one" refusal check — the
    // exact resolution order that produced the original bug (an earlier
    // click's "Saved." overwriting a later click's refusal).
    const storageLocal = makeFakeStorageLocal({
      initial: { sites: [...ALL_SITES] },
      setDelays: [80, 40],
      getDelays: [0, 5],
    });
    const { sitesBox, status } = await loadOptions({ storageLocal });

    uncheck(checkboxFor(sitesBox, 'sfpl'));
    uncheck(checkboxFor(sitesBox, 'goodreads'));
    uncheck(checkboxFor(sitesBox, 'storygraph'));

    await flushPromises(150);

    for (const call of storageLocal.set.mock.calls) {
      const [partial] = call;
      if ('sites' in partial) {
        expect(partial.sites.length).toBeGreaterThan(0);
      }
    }

    expect(status.textContent).not.toBe('Saved.');
    expect(status.textContent.length).toBeGreaterThan(0);
  });
});

describe('options: a single uncheck', () => {
  it('still saves the two remaining sites', async () => {
    const { sitesBox, status, storageLocal } = await loadOptions();

    uncheck(checkboxFor(sitesBox, 'sfpl'));
    await flushPromises();

    const sitesCalls = storageLocal.set.mock.calls
      .map(([partial]) => partial)
      .filter((partial) => 'sites' in partial);
    expect(sitesCalls).toHaveLength(1);
    expect(sitesCalls[0].sites.sort()).toEqual(['goodreads', 'storygraph'].sort());
    expect(status.textContent).toBe('Saved.');
  });
});

describe('options: password manager button', () => {
  it('opens exactly chrome://settings/passwords', async () => {
    const { openPasswords, tabsCreate } = await loadOptions();

    openPasswords.click();

    expect(tabsCreate).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome://settings/passwords' });
  });
});

describe('options: credentials — initial render', () => {
  it('reports "Not stored" for every site with no saved credential', async () => {
    await loadOptions();

    for (const site of ALL_SITES) {
      const { status, username, secret } = credentialEls(site);
      expect(status.textContent).toBe('Not stored');
      // Never pre-filled, whether or not a credential exists.
      expect(username.value).toBe('');
      expect(secret.value).toBe('');
    }
  });

  it('reports "Stored" for a site with a saved credential, without ever putting the secret in the password field', async () => {
    const storageLocal = makeFakeStorageLocal({
      initial: {
        sites: [...ALL_SITES],
        'cred:sfpl': { username: 'card-1234', secret: 'super-secret-pin' },
      },
    });

    await loadOptions({ storageLocal });

    const { status, username, secret } = credentialEls('sfpl');
    expect(status.textContent).toBe('Stored');
    // The whole point: the stored secret is never read back into the DOM.
    expect(secret.value).toBe('');
    expect(username.value).toBe('');
  });
});

describe('options: saving a credential', () => {
  it('stores the typed username and secret, clears the fields, and reports "Stored"', async () => {
    const storageLocal = makeFakeStorageLocal({ initial: { sites: [...ALL_SITES] } });
    await loadOptions({ storageLocal });

    const { username, secret, save, status } = credentialEls('sfpl');
    setInput(username, 'card-9999');
    setInput(secret, '4321');
    save.click();
    await flushPromises(20);

    // saveCredential's effect: chrome.storage.local.set with the credential
    // key, which is the observable proxy for "options.js called
    // saveCredential" without reaching into its internals.
    const setCalls = storageLocal.set.mock.calls.map(([partial]) => partial);
    expect(setCalls).toContainEqual({ 'cred:sfpl': { username: 'card-9999', secret: '4321' } });

    expect(status.textContent).toBe('Stored');
    // Fields are wiped after save — nothing sensitive lingers in the DOM.
    expect(username.value).toBe('');
    expect(secret.value).toBe('');
  });
});

describe('options: saving a blank credential', () => {
  it('refuses when both fields are empty: no write, message flashed', async () => {
    const storageLocal = makeFakeStorageLocal({ initial: { sites: [...ALL_SITES] } });
    const { status } = await loadOptions({ storageLocal });

    const { save } = credentialEls('sfpl');

    save.click();
    await flushPromises(20);

    const setCalls = storageLocal.set.mock.calls.map(([partial]) => partial);
    expect(setCalls.some((partial) => 'cred:sfpl' in partial)).toBe(false);
    expect(status.textContent).toMatch(/required/i);
  });

  it('refuses when only the username is filled in', async () => {
    const storageLocal = makeFakeStorageLocal({ initial: { sites: [...ALL_SITES] } });
    const { status } = await loadOptions({ storageLocal });

    const { username, secret, save } = credentialEls('goodreads');
    setInput(username, 'reader99');
    save.click();
    await flushPromises(20);

    const setCalls = storageLocal.set.mock.calls.map(([partial]) => partial);
    expect(setCalls.some((partial) => 'cred:goodreads' in partial)).toBe(false);
    expect(status.textContent).toMatch(/required/i);
    // The typed username is left as-is — this is a refusal, not a clear.
    expect(username.value).toBe('reader99');
    expect(secret.value).toBe('');
  });

  it('refuses when only the secret is filled in', async () => {
    const storageLocal = makeFakeStorageLocal({ initial: { sites: [...ALL_SITES] } });
    const { status } = await loadOptions({ storageLocal });

    const { secret, save } = credentialEls('storygraph');
    setInput(secret, 'pin-only');
    save.click();
    await flushPromises(20);

    const setCalls = storageLocal.set.mock.calls.map(([partial]) => partial);
    expect(setCalls.some((partial) => 'cred:storygraph' in partial)).toBe(false);
    expect(status.textContent).toMatch(/required/i);
  });
});

describe('options: clearing a credential', () => {
  it('removes the stored credential, clears the fields, and reports "Not stored"', async () => {
    const storageLocal = makeFakeStorageLocal({
      initial: {
        sites: [...ALL_SITES],
        'cred:storygraph': { username: 'reader', secret: 'pin' },
      },
    });
    await loadOptions({ storageLocal });

    const { username, secret, clear, status } = credentialEls('storygraph');
    expect(status.textContent).toBe('Stored');

    clear.click();
    await flushPromises(20);

    // clearCredential's effect: chrome.storage.local.remove with the
    // credential key.
    expect(storageLocal.remove).toHaveBeenCalledWith('cred:storygraph');
    expect(status.textContent).toBe('Not stored');
    expect(username.value).toBe('');
    expect(secret.value).toBe('');
  });
});
