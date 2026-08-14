/**
 * Shared, site-agnostic page classification helpers.
 *
 * SECURITY INVARIANT: nothing in this file may read `.value` from any element.
 * These helpers locate fields; they never inspect what is typed into them.
 * Enforced by test/security-invariants.test.js.
 */

const CHALLENGE_SELECTORS = [
  '.g-recaptcha',
  '#g-recaptcha',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.h-captcha',
  '#challenge-form',
  '#challenge-running',
  '#cf-challenge-running',
  'input[autocomplete="one-time-code"]',
  // Anchored rather than a bare `*="otp"` substring: an unanchored match
  // trips on innocent names like "hotpad", and a false challenge makes the
  // extension refuse to act on a perfectly good page.
  'input[name="otp"]',
  'input[name^="otp_"]',
  'input[name$="_otp"]',
  'input[name*="otp_attempt" i]',
  'input[name*="one_time" i]',
  'input[name*="two_factor" i]',
  'input[name*="two-factor" i]',
];

/**
 * Markers that only exist on a page rendered for a signed-in user.
 * A sign-out control is the most redesign-resistant signal available:
 * a logged-out page has no reason to render one.
 */
export const AUTHED_SELECTORS = [
  'a[href*="sign_out"]',
  'a[href*="signout"]',
  'a[href*="/logout"]',
  'form[action*="sign_out"]',
  'button[formaction*="sign_out"]',
];

function isUsable(el) {
  return !el.disabled && !el.hidden && el.type !== 'hidden';
}

export function matchesAny(doc, selectors) {
  for (const selector of selectors) {
    try {
      if (doc.querySelector(selector)) return true;
    } catch {
      // An invalid selector must never break classification.
    }
  }
  return false;
}

export function findPasswordInput(doc) {
  const inputs = doc.querySelectorAll('input[type="password"]');
  for (const input of inputs) {
    if (isUsable(input)) return input;
  }
  return null;
}

const CANDIDATE_SELECTOR = 'input[type="text"], input[type="email"], input:not([type])';

function candidatesWithin(root) {
  return [...root.querySelectorAll(CANDIDATE_SELECTOR)].filter(isUsable);
}

/**
 * The element to search for a username field.
 *
 * A real <form> is the fast path and covers every login page these three
 * sites currently render. Failing that — single-page apps increasingly ship
 * formless login widgets — walk up from the password field to the nearest
 * ancestor that also holds a candidate.
 *
 * The walk deliberately stops short of <body>. At document scope the nearest
 * "candidate" is as likely to be the site's own search box as a username
 * field, and focusing the wrong box is worse than focusing nothing: it puts
 * the cursor somewhere the user did not ask for it and Chrome's autofill
 * never appears. Returning null there is the project's uncertainty-resolves-
 * to-inaction rule doing its job.
 */
function loginScopeFor(password) {
  const form = password.closest('form');
  if (form) return form;

  const doc = password.ownerDocument;
  let scope = password.parentElement;
  while (scope && scope !== doc.body && scope !== doc.documentElement) {
    if (candidatesWithin(scope).length) return scope;
    scope = scope.parentElement;
  }
  return null;
}

/**
 * The username/email field belonging to the login form.
 *
 * Scoped so a site-wide search box in the page header is never mistaken for a
 * username field. Prefers the nearest candidate *preceding* the password
 * input, matching how login forms are ordered.
 */
export function findUsernameField(doc) {
  const password = findPasswordInput(doc);
  if (!password) return null;

  const scope = loginScopeFor(password);
  if (!scope) return null;

  const candidates = candidatesWithin(scope);

  let nearestPreceding = null;
  for (const candidate of candidates) {
    const precedesPassword =
      password.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_PRECEDING;
    if (precedesPassword) nearestPreceding = candidate;
  }

  return nearestPreceding || candidates[0] || null;
}

export function hasChallenge(doc) {
  return matchesAny(doc, CHALLENGE_SELECTORS);
}

/**
 * The shared classification ladder every adapter walks, in a fixed order.
 * `isResultsUrl` is the only per-site variation.
 */
/**
 * True when `pathname` is exactly `prefix`, or a path segment beneath it.
 *
 * A bare `pathname.startsWith('/search')` also matches `/searchers`, which
 * would classify an unrelated page as results — silently clearing a pending
 * intent on a page that is nothing of the kind. `pathname` never carries a
 * query string, so exact-or-slash is the whole boundary.
 */
export function isPathUnder(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function classify(doc, url, isResultsUrl) {
  if (hasChallenge(doc)) return 'challenge';
  if (findPasswordInput(doc)) return 'login';

  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = '';
  }
  if (pathname && isResultsUrl(pathname)) return 'results';

  if (matchesAny(doc, AUTHED_SELECTORS)) return 'authed';
  return 'unknown';
}
