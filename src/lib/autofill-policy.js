/**
 * The location and page-state guard policy for autofill. Pure functions
 * only — no chrome APIs, no I/O, no clock reads. Everything here is
 * deterministic and unit-testable without a browser.
 *
 * There used to be an attempt-limit policy here too: automated submission
 * meant a wrong PIN resubmitted on every page load could lock the owner out
 * of their own library card, so a consecutive-failure cap existed to stop
 * that. Automated submission has since been removed entirely (see
 * docs/superpowers/specs/2026-08-12-book-lookup-extension-design.md,
 * "Credential handling") — with no auto-submit there are no runaway
 * attempts, so the cap and everything it guarded against are gone too.
 * `shouldAutofill`'s remaining job is the location and page-state guards
 * below, which stop a credential reaching a page that merely happens to
 * have a password field.
 */

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
 *    state. A wrong-host page gets the exact same refusal whether or not a
 *    credential happens to be stored.
 * 2. **Page-state guard next** (`not-login`). Once location is confirmed,
 *    ask whether the page itself is a login form right now; a results or
 *    authed page on the right host/path still must not be filled.
 * 3. **Credential presence last** (`no-credential`). The narrowest, most
 *    mundane reason, so it never masks a more structural refusal above it.
 *
 * `reason: 'ok'` and `fill: true` only when every guard above has passed.
 */
export function shouldAutofill({ hasCredential, state, url, adapter }) {
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
  // `/user/login/change` would otherwise pass this guard and get filled
  // with the stored PIN. The login path itself is never a prefix worth
  // admitting children of.
  if (parsed.pathname !== adapter.loginPath) {
    return { fill: false, reason: 'wrong-path' };
  }

  if (state !== 'login') {
    return { fill: false, reason: 'not-login' };
  }

  if (!hasCredential) {
    return { fill: false, reason: 'no-credential' };
  }

  return { fill: true, reason: 'ok' };
}
