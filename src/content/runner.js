import { adapterForUrl } from '../sites/index.js';
import { findUsernameField, matchesAny, AUTHED_SELECTORS } from '../lib/detect-helpers.js';
import { fillCredential } from './autofill.js';

/**
 * This module has exactly three side effects available to it:
 *   1. focus() a username field
 *   2. send a message to the background worker
 *   3. write a stored credential into the login form, via autofill.js — the
 *      one file permitted to write `.value`
 *
 * It never reads a field's contents, never navigates, and never makes a
 * network request. See test/security-invariants.test.js, which fails the
 * build if that stops being true.
 */

const RECHECK_DELAY_MS = 1500;

// Content scripts re-run fresh on every navigation, so this resets on its
// own — it exists only to stop a second fill within the same load (e.g. the
// 1500ms recheck below firing after a fill already went out), so a re-check
// does not overwrite a field the owner is now typing into.
let filledThisLoad = false;

async function report(adapter) {
  const state = adapter.detect(document, location.href);
  // A URL path alone is not proof of being signed in: SFPL's /v2/search and
  // Goodreads' /search classify as `state === 'results'` for logged-out
  // visitors too, and runSearch() opens exactly those URLs as this
  // extension's core action. `signedIn` is a separate, honest signal — a
  // real sign-out control actually present in the DOM — so the worker can
  // tell "this URL happens to be a results page" apart from "this page
  // proves a credential worked." This is a boolean classification, not
  // field content: matchesAny() only checks for the presence of selectors,
  // never reads a field's `.value`.
  const signedIn = matchesAny(document, AUTHED_SELECTORS);
  const reply = await chrome.runtime.sendMessage({
    type: 'page',
    site: adapter.id,
    state,
    signedIn,
  });

  if (reply?.autofill && !filledThisLoad) {
    const filled = fillCredential(document, reply.autofill);
    if (filled) {
      filledThisLoad = true;
    }
    return state;
  }

  if (reply?.focus) {
    const field = findUsernameField(document);
    // Focus surfaces Chrome's own autofill suggestion. This is the read-only
    // path used when the owner has NOT opted in to autofill for this site:
    // Chrome does not block scripted password entry for extension content
    // scripts (see the spec's "Credential handling" section, which retracts
    // that earlier claim) — src/content/autofill.js does exactly that, on
    // purpose, when a credential is on file. This branch simply doesn't
    // attempt it, because there is no credential to fill with here.
    if (field) field.focus();
  }

  return state;
}

export async function run() {
  const adapter = adapterForUrl(location.href);
  if (!adapter) return;

  const state = await report(adapter);

  // Two of these sites render client-side, so a page can still be assembling
  // itself at document_idle. Exactly one delayed re-check — never a loop.
  if (state === 'unknown') {
    setTimeout(() => {
      report(adapter).catch(() => {});
    }, RECHECK_DELAY_MS);
  }
}
