import { describe, it, expect } from 'vitest';
import { createIntent, decide, INTENT_TTL_MS } from '../src/lib/intents.js';

const NOW = 1_700_000_000_000;
const TARGET = 'https://app.thestorygraph.com/browse?search_term=Dune';

function freshIntent(overrides = {}) {
  return { ...createIntent({ tabId: 7, site: 'storygraph', targetUrl: TARGET, now: NOW }), ...overrides };
}

describe('createIntent', () => {
  it('starts unresumed and expiring ten minutes out', () => {
    const intent = createIntent({ tabId: 7, site: 'storygraph', targetUrl: TARGET, now: NOW });
    expect(intent).toEqual({
      tabId: 7,
      site: 'storygraph',
      targetUrl: TARGET,
      resumed: false,
      expiresAt: NOW + INTENT_TTL_MS,
    });
    expect(INTENT_TTL_MS).toBe(600_000);
  });
});

describe('decide: results', () => {
  it('clears the intent and shows no badge', () => {
    expect(decide(freshIntent(), { state: 'results', now: NOW })).toEqual({
      action: 'none', targetUrl: null, badge: null, intent: null,
    });
  });

  it('is harmless with no intent at all', () => {
    expect(decide(null, { state: 'results', now: NOW })).toEqual({
      action: 'none', targetUrl: null, badge: null, intent: null,
    });
  });
});

describe('decide: login', () => {
  it('asks for focus, badges KEY, and preserves the intent for later resume', () => {
    const intent = freshIntent();
    expect(decide(intent, { state: 'login', now: NOW })).toEqual({
      action: 'focus', targetUrl: null, badge: 'KEY', intent,
    });
  });

  it('still asks for focus when there is no intent, so any login page benefits', () => {
    expect(decide(null, { state: 'login', now: NOW })).toEqual({
      action: 'focus', targetUrl: null, badge: 'KEY', intent: null,
    });
  });

  it('drops an expired intent but still focuses', () => {
    const stale = freshIntent();
    expect(decide(stale, { state: 'login', now: NOW + INTENT_TTL_MS + 1 })).toEqual({
      action: 'focus', targetUrl: null, badge: 'KEY', intent: null,
    });
  });
});

describe('decide: authed', () => {
  it('resumes to the target url exactly once and marks the intent resumed', () => {
    const intent = freshIntent();
    const decision = decide(intent, { state: 'authed', now: NOW + 5_000 });
    expect(decision.action).toBe('resume');
    expect(decision.targetUrl).toBe(TARGET);
    expect(decision.badge).toBeNull();
    expect(decision.intent).toEqual({ ...intent, resumed: true });
  });

  it('never resumes a second time', () => {
    const already = freshIntent({ resumed: true });
    expect(decide(already, { state: 'authed', now: NOW + 5_000 })).toEqual({
      action: 'none', targetUrl: null, badge: null, intent: null,
    });
  });

  it('never resumes an expired intent', () => {
    const stale = freshIntent();
    expect(decide(stale, { state: 'authed', now: NOW + INTENT_TTL_MS + 1 })).toEqual({
      action: 'none', targetUrl: null, badge: null, intent: null,
    });
  });

  it('does nothing when signed in with no pending search', () => {
    expect(decide(null, { state: 'authed', now: NOW })).toEqual({
      action: 'none', targetUrl: null, badge: null, intent: null,
    });
  });

  it('does not mutate the intent it was given', () => {
    const intent = freshIntent();
    decide(intent, { state: 'authed', now: NOW + 5_000 });
    expect(intent.resumed).toBe(false);
  });
});

describe('decide: challenge', () => {
  it('badges ALERT, clears the intent, and takes no action', () => {
    expect(decide(freshIntent(), { state: 'challenge', now: NOW })).toEqual({
      action: 'none', targetUrl: null, badge: 'ALERT', intent: null,
    });
  });
});

describe('decide: unknown', () => {
  it('badges QUESTION, clears the intent, and takes no action', () => {
    expect(decide(freshIntent(), { state: 'unknown', now: NOW })).toEqual({
      action: 'none', targetUrl: null, badge: 'QUESTION', intent: null,
    });
  });

  it('treats an unrecognized state string the same as unknown', () => {
    expect(decide(freshIntent(), { state: 'wat', now: NOW })).toEqual({
      action: 'none', targetUrl: null, badge: 'QUESTION', intent: null,
    });
  });
});

describe('the no-loop guarantee', () => {
  it('cannot produce two resumes from one intent no matter how many authed pages load', () => {
    let intent = freshIntent();
    let resumes = 0;
    for (let i = 0; i < 25; i += 1) {
      const decision = decide(intent, { state: 'authed', now: NOW + i * 1_000 });
      if (decision.action === 'resume') resumes += 1;
      intent = decision.intent;
    }
    expect(resumes).toBe(1);
  });

  it('cannot resume after a challenge cleared the intent', () => {
    const cleared = decide(freshIntent(), { state: 'challenge', now: NOW }).intent;
    expect(decide(cleared, { state: 'authed', now: NOW + 1_000 }).action).toBe('none');
  });
});
