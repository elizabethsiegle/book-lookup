import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This exercises the REAL, unmodified src/popup/popup.js against the REAL
// src/popup/popup.html, driven with real DOM events and a stubbed chrome
// API. It exists to lock in two bugs that were found and fixed by hand (a
// rejected sendMessage leaving the popup silently stuck open-looking, and a
// stale error message surviving a retry) so they cannot regress silently.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function source(relativePath) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function loadPopupMarkup() {
  const html = source('src/popup/popup.html');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
}

function makeFakeStorageLocal(initial = {}) {
  let store = { ...initial };
  return {
    get: vi.fn((defaults) => Promise.resolve({ ...defaults, ...store })),
    set: vi.fn((partial) => {
      store = { ...store, ...partial };
      return Promise.resolve();
    }),
  };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Loads a fresh copy of the real popup markup, stubs chrome, dynamically
 * imports the real popup.js, and waits for its async init() to settle.
 */
async function loadPopup({ sendMessageImpl } = {}) {
  vi.resetModules();
  loadPopupMarkup();

  const sendMessage = vi.fn(sendMessageImpl || (() => Promise.resolve({ opened: 3 })));
  globalThis.chrome = {
    storage: { local: makeFakeStorageLocal() },
    runtime: { sendMessage },
  };
  window.close = vi.fn();

  await import('../src/popup/popup.js');
  await flushPromises();

  return {
    form: document.getElementById('search-form'),
    queryInput: document.getElementById('query'),
    searchAll: document.getElementById('search-all'),
    sitesRow: document.getElementById('sites'),
    dispatchError: document.getElementById('dispatch-error'),
    sendMessage,
  };
}

function typeQuery(queryInput, value) {
  queryInput.value = value;
  queryInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function submitForm(form) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('popup: dispatch failure', () => {
  it('shows a non-empty #dispatch-error and does not close the popup when sendMessage rejects', async () => {
    const { form, queryInput, dispatchError } = await loadPopup({
      sendMessageImpl: () => Promise.reject(new Error('service worker asleep')),
    });

    typeQuery(queryInput, 'Dune');
    submitForm(form);
    await flushPromises();

    expect(dispatchError.hidden).toBe(false);
    expect(dispatchError.textContent.length).toBeGreaterThan(0);
    expect(window.close).not.toHaveBeenCalled();
  });
});

describe('popup: dispatch success', () => {
  it('closes the popup and keeps the error hidden when sendMessage resolves', async () => {
    const { form, queryInput, dispatchError } = await loadPopup();

    typeQuery(queryInput, 'Dune');
    submitForm(form);
    await flushPromises();

    expect(window.close).toHaveBeenCalledTimes(1);
    expect(dispatchError.hidden).toBe(true);
  });
});

describe('popup: recovering from an error', () => {
  it('re-hides the error as soon as the user types again', async () => {
    const { form, queryInput, dispatchError } = await loadPopup({
      sendMessageImpl: () => Promise.reject(new Error('nope')),
    });

    typeQuery(queryInput, 'Dune');
    submitForm(form);
    await flushPromises();
    expect(dispatchError.hidden).toBe(false);

    typeQuery(queryInput, 'Dune, again');
    expect(dispatchError.hidden).toBe(true);
  });
});

describe('popup: empty query', () => {
  it('disables every button, including per-site ones, when the query is empty', async () => {
    const { searchAll, sitesRow } = await loadPopup();

    expect(searchAll.disabled).toBe(true);
    const siteButtons = [...sitesRow.querySelectorAll('button')];
    expect(siteButtons.length).toBeGreaterThan(0);
    for (const button of siteButtons) {
      expect(button.disabled).toBe(true);
    }
  });
});
