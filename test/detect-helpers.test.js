import { describe, it, expect } from 'vitest';
import {
  findPasswordInput,
  findUsernameField,
  hasChallenge,
  matchesAny,
} from '../src/lib/detect-helpers.js';

function docFrom(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('findPasswordInput', () => {
  it('finds a password input', () => {
    const doc = docFrom('<form><input type="text"><input type="password"></form>');
    expect(findPasswordInput(doc)).not.toBeNull();
    expect(findPasswordInput(doc).type).toBe('password');
  });

  it('returns null when there is no password input', () => {
    const doc = docFrom('<form><input type="search"></form>');
    expect(findPasswordInput(doc)).toBeNull();
  });

  it('ignores a hidden password input', () => {
    const doc = docFrom('<form><input type="password" hidden></form>');
    expect(findPasswordInput(doc)).toBeNull();
  });

  it('ignores a disabled password input', () => {
    const doc = docFrom('<form><input type="password" disabled></form>');
    expect(findPasswordInput(doc)).toBeNull();
  });
});

describe('findUsernameField', () => {
  it('returns the text input preceding the password input', () => {
    const doc = docFrom(`
      <form>
        <input type="text" id="user">
        <input type="password" id="pw">
      </form>`);
    expect(findUsernameField(doc).id).toBe('user');
  });

  it('returns the email input preceding the password input', () => {
    const doc = docFrom(`
      <form>
        <input type="email" id="email">
        <input type="password" id="pw">
      </form>`);
    expect(findUsernameField(doc).id).toBe('email');
  });

  it('treats an input with no type attribute as a text input', () => {
    const doc = docFrom('<form><input id="user"><input type="password"></form>');
    expect(findUsernameField(doc).id).toBe('user');
  });

  it('picks the nearest preceding candidate when several exist', () => {
    const doc = docFrom(`
      <form>
        <input type="text" id="first">
        <input type="text" id="second">
        <input type="password" id="pw">
      </form>`);
    expect(findUsernameField(doc).id).toBe('second');
  });

  it('ignores a site-wide search box outside the login form', () => {
    const doc = docFrom(`
      <input type="text" id="sitesearch">
      <form>
        <input type="email" id="email">
        <input type="password" id="pw">
      </form>`);
    expect(findUsernameField(doc).id).toBe('email');
  });

  it('ignores hidden and disabled candidates', () => {
    const doc = docFrom(`
      <form>
        <input type="hidden" id="token">
        <input type="text" id="decoy" disabled>
        <input type="text" id="real">
        <input type="password" id="pw">
      </form>`);
    expect(findUsernameField(doc).id).toBe('real');
  });

  it('falls back to a following candidate if none precedes the password field', () => {
    const doc = docFrom('<form><input type="password" id="pw"><input type="text" id="user"></form>');
    expect(findUsernameField(doc).id).toBe('user');
  });

  it('returns null when there is no password input at all', () => {
    const doc = docFrom('<form><input type="text" id="user"></form>');
    expect(findUsernameField(doc)).toBeNull();
  });
});

describe('hasChallenge', () => {
  it('detects a reCAPTCHA widget', () => {
    expect(hasChallenge(docFrom('<div class="g-recaptcha"></div>'))).toBe(true);
  });

  it('detects a reCAPTCHA iframe', () => {
    expect(hasChallenge(docFrom('<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>'))).toBe(true);
  });

  it('detects a Cloudflare interstitial', () => {
    expect(hasChallenge(docFrom('<div id="challenge-running"></div>'))).toBe(true);
  });

  it('detects a one-time-code field', () => {
    expect(hasChallenge(docFrom('<input autocomplete="one-time-code">'))).toBe(true);
  });

  it('returns false for an ordinary page', () => {
    expect(hasChallenge(docFrom('<main><h1>Search results</h1></main>'))).toBe(false);
  });
});

describe('matchesAny', () => {
  it('returns true when any selector matches', () => {
    const doc = docFrom('<a href="/user/sign_out">Sign out</a>');
    expect(matchesAny(doc, ['.nope', 'a[href*="sign_out"]'])).toBe(true);
  });

  it('returns false when none match', () => {
    const doc = docFrom('<a href="/login">Sign in</a>');
    expect(matchesAny(doc, ['a[href*="sign_out"]'])).toBe(false);
  });

  it('survives an invalid selector without throwing', () => {
    const doc = docFrom('<a href="/user/sign_out">Sign out</a>');
    expect(matchesAny(doc, ['<<<not a selector>>>', 'a[href*="sign_out"]'])).toBe(true);
  });
});
