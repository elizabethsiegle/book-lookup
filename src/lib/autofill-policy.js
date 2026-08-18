/**
 * The attempt-limit and guard policy for autofill. Pure functions only — no
 * chrome APIs, no I/O, no clock reads. Everything here is deterministic and
 * unit-testable without a browser.
 *
 * Library systems lock a card after a small number of failed PIN attempts.
 * Without a hard cap, an extension that resubmits a wrong PIN on every page
 * load would lock the owner out of their own account within seconds. This
 * module is what prevents that — treat it as the deliverable, not as
 * bookkeeping around it.
 */
export const MAX_CONSECUTIVE_FAILURES = 2;

/** `failures >= MAX_CONSECUTIVE_FAILURES` — the shared boundary check. */
export function isDisabled(failures) {
  return failures >= MAX_CONSECUTIVE_FAILURES;
}

/**
 * Folds one autofill outcome into the next failure count.
 *
 * A success resets the count to 0: the credential just worked, so past
 * failures (typos now corrected, a transient site hiccup) no longer predict
 * anything. A failure increments, and `disabled` reports whether the new
 * count has reached the cap — the caller uses this to decide whether to
 * surface `BADGE.AUTOFILL_OFF`.
 */
export function recordOutcome(failures, outcome) {
  if (outcome === 'success') {
    return { failures: 0, disabled: false };
  }
  const next = failures + 1;
  return { failures: next, disabled: isDisabled(next) };
}

/**
 * Whether autofill should fire on this page load, and why.
 *
 * Pure and defensive: given a malformed/unparseable `url`, this returns a
 * refusing decision rather than throwing, because a thrown exception in the
 * worker's guard path is itself a bug the owner would not see coming.
 *
 * Checks run in this fixed order, each a strictly narrower question than the
 * last:
 *
 * 1. **Location guards first** (`insecure`, `wrong-host`, `wrong-path`).
 *    These ask "are we even looking at this site's real login page?" and
 *    the answer must not depend on — or leak anything about — credential
 *    state or failure history. A wrong-host page gets the exact same
 *    refusal whether or not a credential happens to be stored.
 * 2. **Page-state guard next** (`not-login`). Once location is confirmed,
 *    ask whether the page itself is a login form right now; a results or
 *    authed page on the right host/path still must not be filled.
 * 3. **Policy guard** (`disabled`). Only on a real login page does the
 *    attempt-limit history matter, and it is checked before credential
 *    presence: a site that tripped the cap should read as "disabled," not
 *    silently reclassified as "no credential" if the credential is ever
 *    absent for an unrelated reason.
 * 4. **Credential presence last** (`no-credential`). The narrowest, most
 *    mundane reason, so it never masks a more structural refusal above it.
 *
 * `reason: 'ok'` and `fill: true` only when every guard above has passed.
 */
export function shouldAutofill({ hasCredential, failures, state, url, adapter }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Cannot confirm scheme/host/path at all — fail closed as insecure
    // rather than throw or guess.
    return { fill: false, reason: 'insecure' };
  }

  if (!adapter || typeof adapter.hostMatch !== 'string' || typeof adapter.loginPath !== 'string') {
    // No adapter to check the host/path against — fail closed the same way
    // an actual host mismatch would.
    return { fill: false, reason: 'wrong-host' };
  }

  if (parsed.protocol !== 'https:') {
    return { fill: false, reason: 'insecure' };
  }

  // Exact host equality only — never a substring/suffix test, or
  // `www.goodreads.com.evil.test` would pass.
  if (parsed.host !== adapter.hostMatch) {
    return { fill: false, reason: 'wrong-host' };
  }

  // Exact path equality, NOT isPathUnder's subpath match. classify() returns
  // 'login' for any page with a usable password field, regardless of path —
  // a password-change or registration page living under
  // `/user/login/change` would otherwise pass this guard and get filled and
  // submitted with the stored PIN. The login path itself is never a prefix
  // worth admitting children of.
  if (parsed.pathname !== adapter.loginPath) {
    return { fill: false, reason: 'wrong-path' };
  }

  if (state !== 'login') {
    return { fill: false, reason: 'not-login' };
  }

  if (isDisabled(failures)) {
    return { fill: false, reason: 'disabled' };
  }

  if (!hasCredential) {
    return { fill: false, reason: 'no-credential' };
  }

  return { fill: true, reason: 'ok' };
}
