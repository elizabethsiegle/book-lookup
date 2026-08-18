import { describe, it, expect } from 'vitest';
import {
  MAX_CONSECUTIVE_FAILURES,
  recordOutcome,
  isDisabled,
  shouldAutofill,
} from '../src/lib/autofill-policy.js';
import { getAdapter } from '../src/sites/index.js';

const sfpl = getAdapter('sfpl');
const goodreads = getAdapter('goodreads');

const baseArgs = () => ({
  hasCredential: true,
  failures: 0,
  state: 'login',
  url: `https://${sfpl.hostMatch}${sfpl.loginPath}`,
  adapter: sfpl,
});

describe('shouldAutofill: every reason branch', () => {
  it('ok — every guard passes', () => {
    expect(shouldAutofill(baseArgs())).toEqual({ fill: true, reason: 'ok' });
  });

  it('no-credential — no credential stored', () => {
    expect(shouldAutofill({ ...baseArgs(), hasCredential: false })).toEqual({
      fill: false,
      reason: 'no-credential',
    });
  });

  it('not-login — state is not "login"', () => {
    for (const state of ['results', 'authed', 'challenge', 'unknown']) {
      expect(shouldAutofill({ ...baseArgs(), state })).toEqual({
        fill: false,
        reason: 'not-login',
      });
    }
  });

  it('disabled — failures have reached the cap', () => {
    expect(shouldAutofill({ ...baseArgs(), failures: MAX_CONSECUTIVE_FAILURES })).toEqual({
      fill: false,
      reason: 'disabled',
    });
  });

  it('insecure — scheme is not https:', () => {
    expect(
      shouldAutofill({ ...baseArgs(), url: `http://${sfpl.hostMatch}${sfpl.loginPath}` })
    ).toEqual({ fill: false, reason: 'insecure' });
  });

  it('wrong-host — host does not exactly match', () => {
    expect(
      shouldAutofill({ ...baseArgs(), url: `https://not-${sfpl.hostMatch}${sfpl.loginPath}` })
    ).toEqual({ fill: false, reason: 'wrong-host' });
  });

  it('wrong-path — path is not under the login path', () => {
    expect(
      shouldAutofill({ ...baseArgs(), url: `https://${sfpl.hostMatch}/v2/search` })
    ).toEqual({ fill: false, reason: 'wrong-path' });
  });

  it('wrong-path — a subpath of the login path is refused, not admitted', () => {
    // A password-change or registration page living under the login path
    // (e.g. /user/login/change) must not be treated as the login page
    // itself — only an exact path match may fill and submit the stored PIN.
    expect(
      shouldAutofill({ ...baseArgs(), url: `https://${sfpl.hostMatch}${sfpl.loginPath}/change` })
    ).toEqual({ fill: false, reason: 'wrong-path' });
  });
});

describe('shouldAutofill: exact-host check', () => {
  it('rejects a lookalike host that merely contains the real one as a substring', () => {
    const url = `https://${goodreads.hostMatch}.evil.test${goodreads.loginPath}`;
    expect(shouldAutofill({ ...baseArgs(), url, adapter: goodreads })).toEqual({
      fill: false,
      reason: 'wrong-host',
    });
  });

  it('rejects a host that is a prefix of the real one', () => {
    // e.g. "www.goodreads.com" must not match as a substring of
    // "evil-www.goodreads.com" or similar prefix tricks.
    const url = `https://evil-${goodreads.hostMatch}${goodreads.loginPath}`;
    expect(shouldAutofill({ ...baseArgs(), url, adapter: goodreads })).toEqual({
      fill: false,
      reason: 'wrong-host',
    });
  });

  it('accepts the exact real host', () => {
    const url = `https://${goodreads.hostMatch}${goodreads.loginPath}`;
    expect(shouldAutofill({ ...baseArgs(), url, adapter: goodreads })).toEqual({
      fill: true,
      reason: 'ok',
    });
  });
});

describe('shouldAutofill: malformed input', () => {
  it('returns a refusing reason for an unparseable URL rather than throwing', () => {
    expect(() => shouldAutofill({ ...baseArgs(), url: 'not a url' })).not.toThrow();
    const result = shouldAutofill({ ...baseArgs(), url: 'not a url' });
    expect(result.fill).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  it('returns a refusing reason for an empty URL', () => {
    expect(() => shouldAutofill({ ...baseArgs(), url: '' })).not.toThrow();
    expect(shouldAutofill({ ...baseArgs(), url: '' }).fill).toBe(false);
  });

  it('returns a refusing reason when adapter is missing', () => {
    expect(() => shouldAutofill({ ...baseArgs(), adapter: undefined })).not.toThrow();
    expect(shouldAutofill({ ...baseArgs(), adapter: undefined }).fill).toBe(false);
  });
});

describe('shouldAutofill: guard ordering', () => {
  it('an insecure, wrong-host page reports insecure, not wrong-host', () => {
    // Location guards are checked scheme-first; wrong-host must not mask an
    // insecure scheme, since both would refuse anyway.
    expect(
      shouldAutofill({ ...baseArgs(), url: `http://not-${sfpl.hostMatch}${sfpl.loginPath}` })
    ).toEqual({ fill: false, reason: 'insecure' });
  });

  it('a disabled site with no credential reports disabled, not no-credential', () => {
    expect(
      shouldAutofill({
        ...baseArgs(),
        hasCredential: false,
        failures: MAX_CONSECUTIVE_FAILURES,
      })
    ).toEqual({ fill: false, reason: 'disabled' });
  });

  it('wrong-host on a non-login page reports wrong-host, not not-login', () => {
    expect(
      shouldAutofill({
        ...baseArgs(),
        state: 'results',
        url: `https://not-${sfpl.hostMatch}${sfpl.loginPath}`,
      })
    ).toEqual({ fill: false, reason: 'wrong-host' });
  });
});

describe('recordOutcome', () => {
  it('increments on failure', () => {
    expect(recordOutcome(0, 'failure')).toEqual({ failures: 1, disabled: false });
  });

  it('reaches the disabled threshold', () => {
    expect(recordOutcome(1, 'failure')).toEqual({
      failures: MAX_CONSECUTIVE_FAILURES,
      disabled: true,
    });
  });

  it('holds at the threshold on further failures rather than reporting anything special', () => {
    expect(recordOutcome(MAX_CONSECUTIVE_FAILURES, 'failure')).toEqual({
      failures: MAX_CONSECUTIVE_FAILURES + 1,
      disabled: true,
    });
  });

  it('resets to 0 on success from a fresh count', () => {
    expect(recordOutcome(0, 'success')).toEqual({ failures: 0, disabled: false });
  });

  it('resets to 0 on success even after reaching the cap', () => {
    expect(recordOutcome(MAX_CONSECUTIVE_FAILURES, 'success')).toEqual({
      failures: 0,
      disabled: false,
    });
  });
});

describe('isDisabled', () => {
  it('is false below the cap', () => {
    expect(isDisabled(MAX_CONSECUTIVE_FAILURES - 1)).toBe(false);
  });

  it('is true exactly at the cap', () => {
    expect(isDisabled(MAX_CONSECUTIVE_FAILURES)).toBe(true);
  });

  it('is true above the cap', () => {
    expect(isDisabled(MAX_CONSECUTIVE_FAILURES + 1)).toBe(true);
  });

  it('is false at 0', () => {
    expect(isDisabled(0)).toBe(false);
  });
});
