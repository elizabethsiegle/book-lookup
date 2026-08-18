/**
 * The single file in this extension permitted to WRITE `.value` on a form
 * field.
 *
 * The extension may inject a credential it already holds into a field it
 * located itself; it may never learn what the user typed. That asymmetry —
 * write allowed, read banned — is the whole security property this feature
 * relies on, and it holds here too: this module never reads `.value` back,
 * not even to "verify" the fill worked. Verification happens by classifying
 * the NEXT page load in background.js, not by inspecting the field.
 *
 * Every other content-script file keeps the original total ban on `.value`.
 * See test/security-invariants.test.js, which enforces both halves of the
 * split, and docs/superpowers/specs/2026-08-12-book-lookup-extension-design.md,
 * "Credential handling", for the reasoning.
 */
import { findPasswordInput, findUsernameField } from '../lib/detect-helpers.js';

function fireChangeEvents(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Fills the page's login form with a credential the caller already holds,
 * and submits it. Returns `true` once submitted, `false` if the fields
 * could not be located or there is no form to submit — in either case,
 * nothing is written and nothing is submitted.
 *
 * At most one submission per page load is the caller's responsibility
 * (see the `submittedThisLoad` guard in runner.js); this function itself
 * has no memory of prior calls.
 */
export function fillAndSubmit(doc, { username, secret }) {
  const password = findPasswordInput(doc);
  const usernameField = findUsernameField(doc);
  if (!password || !usernameField) return false;

  usernameField.value = username;
  fireChangeEvents(usernameField);

  password.value = secret;
  fireChangeEvents(password);

  const form = password.form || usernameField.form;
  if (!form) return false;

  const submitControl = form.querySelector('[type="submit"]');
  if (submitControl) {
    submitControl.click();
  } else if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  } else {
    form.submit();
  }
  return true;
}
