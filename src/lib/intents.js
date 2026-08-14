/**
 * The pending-search state machine. Pure — no Chrome APIs, no clock reads.
 * `now` is always passed in so expiry is deterministically testable.
 */

export const INTENT_TTL_MS = 10 * 60 * 1000;

export function createIntent({ tabId, site, targetUrl, now }) {
  return {
    tabId,
    site,
    targetUrl,
    resumed: false,
    expiresAt: now + INTENT_TTL_MS,
  };
}

function liveIntent(intent, now) {
  if (!intent) return null;
  return now < intent.expiresAt ? intent : null;
}

const NOTHING = { action: 'none', targetUrl: null, badge: null, intent: null };

/**
 * Decide what to do about a classified page.
 *
 * The returned `intent` is what the caller must store for this tab; `null`
 * means delete it. Every ambiguous outcome clears the intent and takes no
 * action — uncertainty resolves to inaction, by design.
 */
export function decide(intent, { state, now }) {
  const live = liveIntent(intent, now);

  switch (state) {
    case 'results':
      return { ...NOTHING };

    case 'login':
      // Keep a live intent so the resume can fire once login succeeds.
      return { action: 'focus', targetUrl: null, badge: 'KEY', intent: live };

    case 'authed':
      if (live && !live.resumed) {
        return {
          action: 'resume',
          targetUrl: live.targetUrl,
          badge: null,
          intent: { ...live, resumed: true },
        };
      }
      return { ...NOTHING };

    case 'challenge':
      return { action: 'none', targetUrl: null, badge: 'ALERT', intent: null };

    case 'unknown':
    default:
      return { action: 'none', targetUrl: null, badge: 'QUESTION', intent: null };
  }
}
