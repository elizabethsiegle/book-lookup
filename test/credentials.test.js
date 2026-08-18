import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadCredential,
  saveCredential,
  clearCredential,
  loadFailures,
  saveFailures,
} from '../src/lib/credentials.js';

/**
 * A minimal fake of chrome.storage.local backed by an in-memory object,
 * matching the real API's shape closely enough for these modules: get()
 * accepts a string key or a defaults object, set()/remove() take a
 * partial/key and resolve.
 */
function makeFakeStorageLocal(initial = {}) {
  let store = { ...initial };
  const get = vi.fn((query) => {
    if (typeof query === 'string') {
      return Promise.resolve(query in store ? { [query]: store[query] } : {});
    }
    // Object form: defaults merged under stored values (mirrors prefs.js usage).
    return Promise.resolve({ ...query, ...store });
  });
  const set = vi.fn((partial) => {
    store = { ...store, ...partial };
    return Promise.resolve();
  });
  const remove = vi.fn((key) => {
    const next = { ...store };
    delete next[key];
    store = next;
    return Promise.resolve();
  });
  return { get, set, remove, _dump: () => store };
}

beforeEach(() => {
  globalThis.chrome = { storage: { local: makeFakeStorageLocal() } };
});

describe('loadCredential / saveCredential', () => {
  it('returns null when nothing is stored', async () => {
    expect(await loadCredential('sfpl')).toBeNull();
  });

  it('round-trips a saved credential', async () => {
    await saveCredential('sfpl', { username: 'card123', secret: '4321' });
    expect(await loadCredential('sfpl')).toEqual({ username: 'card123', secret: '4321' });
  });

  it('treats a blank username as absent', async () => {
    await saveCredential('sfpl', { username: '', secret: '4321' });
    expect(await loadCredential('sfpl')).toBeNull();
  });

  it('treats a whitespace-only username as absent', async () => {
    await saveCredential('sfpl', { username: '   ', secret: '4321' });
    expect(await loadCredential('sfpl')).toBeNull();
  });

  it('treats a blank secret as absent', async () => {
    await saveCredential('sfpl', { username: 'card123', secret: '' });
    expect(await loadCredential('sfpl')).toBeNull();
  });

  it('treats a whitespace-only secret as absent', async () => {
    await saveCredential('sfpl', { username: 'card123', secret: '\t\n ' });
    expect(await loadCredential('sfpl')).toBeNull();
  });

  it('never returns another site\'s credential', async () => {
    await saveCredential('sfpl', { username: 'sfpl-user', secret: 'sfpl-pin' });
    expect(await loadCredential('goodreads')).toBeNull();

    await saveCredential('goodreads', { username: 'gr-user', secret: 'gr-pin' });
    expect(await loadCredential('sfpl')).toEqual({ username: 'sfpl-user', secret: 'sfpl-pin' });
    expect(await loadCredential('goodreads')).toEqual({ username: 'gr-user', secret: 'gr-pin' });
  });

  it('saveCredential resets that site\'s failure count to 0', async () => {
    await saveFailures('sfpl', 2);
    expect(await loadFailures('sfpl')).toBe(2);

    await saveCredential('sfpl', { username: 'card123', secret: '4321' });
    expect(await loadFailures('sfpl')).toBe(0);
  });

  it('saveCredential does not reset a different site\'s failure count', async () => {
    await saveFailures('goodreads', 2);
    await saveCredential('sfpl', { username: 'card123', secret: '4321' });
    expect(await loadFailures('goodreads')).toBe(2);
  });
});

describe('clearCredential', () => {
  it('removes a stored credential', async () => {
    await saveCredential('sfpl', { username: 'card123', secret: '4321' });
    await clearCredential('sfpl');
    expect(await loadCredential('sfpl')).toBeNull();
  });

  it('does not touch the failure count', async () => {
    await saveCredential('sfpl', { username: 'card123', secret: '4321' });
    await saveFailures('sfpl', 1);
    await clearCredential('sfpl');
    expect(await loadFailures('sfpl')).toBe(1);
  });

  it('does not affect another site\'s credential', async () => {
    await saveCredential('sfpl', { username: 'sfpl-user', secret: 'sfpl-pin' });
    await saveCredential('goodreads', { username: 'gr-user', secret: 'gr-pin' });
    await clearCredential('sfpl');
    expect(await loadCredential('goodreads')).toEqual({ username: 'gr-user', secret: 'gr-pin' });
  });
});

describe('loadFailures / saveFailures', () => {
  it('defaults to 0 when nothing is stored', async () => {
    expect(await loadFailures('sfpl')).toBe(0);
  });

  it('round-trips a stored count', async () => {
    await saveFailures('sfpl', 1);
    expect(await loadFailures('sfpl')).toBe(1);
  });

  it('keeps counts namespaced per site', async () => {
    await saveFailures('sfpl', 2);
    expect(await loadFailures('goodreads')).toBe(0);
  });

  it('treats a malformed stored value as 0 rather than throwing', async () => {
    globalThis.chrome.storage.local = makeFakeStorageLocal({
      'autofillFailures:sfpl': 'not-a-number',
    });
    expect(await loadFailures('sfpl')).toBe(0);
  });

  it('treats a negative stored value as 0', async () => {
    globalThis.chrome.storage.local = makeFakeStorageLocal({ 'autofillFailures:sfpl': -1 });
    expect(await loadFailures('sfpl')).toBe(0);
  });
});
