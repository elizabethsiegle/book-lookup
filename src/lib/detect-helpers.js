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
  'input[name*="otp" i]',
  'input[name*="two_factor" i]',
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

/**
 * The username/email field belonging to the login form.
 *
 * Scoped to the password field's own form so a site-wide search box in the
 * header is never mistaken for a username field. Prefers the nearest candidate
 * *preceding* the password input, matching how login forms are ordered.
 */
export function findUsernameField(doc) {
  const password = findPasswordInput(doc);
  if (!password) return null;

  const scope = password.closest('form') || doc;
  const candidates = [
    ...scope.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'),
  ].filter(isUsable);

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
