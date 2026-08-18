/**
 * The single file in this extension permitted to WRITE `.value` on a form
 * field.
 *
 * The extension may inject a credential it already holds into a field it
 * located itself; it may never learn what the user typed. That asymmetry —
 * write allowed, read banned — is the whole security property this feature
 * relies on, and it holds here too: this module never reads `.value` back,
 * not even to "verify" the fill worked.
 *
 * This module fills the form and stops. It never submits it — see
 * docs/superpowers/specs/2026-08-12-book-lookup-extension-design.md,
 * "Credential handling", for why automated submission was tried, audited,
 * and removed rather than further hardened.
 *
 * Every other content-script file keeps the original total ban on `.value`.
 * See test/security-invariants.test.js, which enforces both halves of the
 * split.
 */
import { findPasswordInput, findUsernameField } from '../lib/detect-helpers.js';

function fireChangeEvents(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Fills the page's login form with a credential the caller already holds.
 * Does not submit it — the owner presses Enter. Returns `true` once both
 * fields are filled, `false` if the fields could not be located — in that
 * case, nothing is written.
 *
 * At most one fill per page load is the caller's responsibility (see the
 * `filledThisLoad` guard in runner.js); this function itself has no memory
 * of prior calls.
 */
export function fillCredential(doc, { username, secret }) {
  const password = findPasswordInput(doc);
  const usernameField = findUsernameField(doc);
  if (!password || !usernameField) return false;

  usernameField.value = username;
  fireChangeEvents(usernameField);

  password.value = secret;
  fireChangeEvents(password);

  return true;
}
