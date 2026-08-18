import { adapterForUrl } from '../sites/index.js';
import { findUsernameField } from '../lib/detect-helpers.js';
import { fillAndSubmit } from './autofill.js';

/**
 * This module has exactly three side effects available to it:
 *   1. focus() a username field
 *   2. send a message to the background worker
 *   3. write a stored credential into the login form and submit it, via
 *      autofill.js — the one file permitted to write `.value`
 *
 * It never reads a field's contents, never navigates, and never makes a
 * network request. See test/security-invariants.test.js, which fails the
 * build if that stops being true.
 */

const RECHECK_DELAY_MS = 1500;

// Content scripts re-run fresh on every navigation, so this resets on its
// own — it exists only to stop a second submission within the same load
// (e.g. the 1500ms recheck below firing after an autofill already went out).
let submittedThisLoad = false;

async function report(adapter) {
  const state = adapter.detect(document, location.href);
  const reply = await chrome.runtime.sendMessage({
    type: 'page',
    site: adapter.id,
    state,
  });

  if (reply?.autofill && !submittedThisLoad) {
    const submitted = fillAndSubmit(document, reply.autofill);
    if (submitted) {
      submittedThisLoad = true;
      chrome.runtime
        .sendMessage({ type: 'autofill-submitted', site: adapter.id })
        .catch(() => {});
    }
    return state;
  }

  if (reply?.focus) {
    const field = findUsernameField(document);
    // Focus surfaces Chrome's own autofill suggestion. Chrome deliberately
    // blocks scripted password entry; we neither want nor attempt it.
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
