/**
 * Per-site credential storage, plus the failure counter the attempt-limit
 * policy reads and writes.
 *
 * Credentials are opt-in, per site, and stored in `chrome.storage.local` in
 * plaintext — extensions have no keychain access, so there is no honest way
 * to encrypt them at rest. See docs/superpowers/specs/2026-08-12-book-lookup-
 * extension-design.md, "Credential handling", for the reasoning.
 *
 * Storage keys are namespaced with a `cred:` / `autofillFailures:` prefix so
 * they cannot collide with the existing `mode` / `sites` / `lastQuery`
 * preference keys in src/lib/prefs.js.
 *
 * Nothing here logs a credential, in a message or otherwise.
 */

function credentialKey(siteId) {
  return `cred:${siteId}`;
}

function failuresKey(siteId) {
  return `autofillFailures:${siteId}`;
}

/** True for anything that is not a non-whitespace string. Exported so callers
 * (e.g. the options page) can refuse a blank save before it ever reaches
 * storage, using the exact same rule `loadCredential` uses to treat a
 * half-filled credential as absent. */
export function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Returns `{ username, secret }` for `siteId`, or `null` if no credential is
 * stored, or if either field is missing or blank/whitespace-only.
 *
 * A half-filled credential must never arm autofill, so it is treated as
 * fully absent rather than partially present.
 */
export async function loadCredential(siteId) {
  const key = credentialKey(siteId);
  const stored = await chrome.storage.local.get(key);
  const cred = stored[key];
  if (!cred || isBlank(cred.username) || isBlank(cred.secret)) return null;
  return { username: cred.username, secret: cred.secret };
}

/**
 * Stores `{ username, secret }` for `siteId` and resets that site's failure
 * count to 0 — re-saving a credential is the owner asserting it is correct
 * right now, so any earlier lockout no longer applies.
 */
export async function saveCredential(siteId, { username, secret }) {
  const key = credentialKey(siteId);
  await chrome.storage.local.set({ [key]: { username, secret } });
  await saveFailures(siteId, 0);
}

/** Removes any stored credential for `siteId`. Does not touch the failure count. */
export async function clearCredential(siteId) {
  await chrome.storage.local.remove(credentialKey(siteId));
}

/**
 * The current consecutive-failure count for `siteId`. Missing or malformed
 * storage reads as 0 rather than throwing or propagating garbage into the
 * policy layer.
 */
export async function loadFailures(siteId) {
  const key = failuresKey(siteId);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Persists the consecutive-failure count for `siteId`. */
export async function saveFailures(siteId, n) {
  await chrome.storage.local.set({ [failuresKey(siteId)]: n });
}
