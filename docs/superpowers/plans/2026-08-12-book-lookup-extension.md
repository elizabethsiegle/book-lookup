# Book Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manifest V3 Chrome extension that takes a book title or author from one textbox and opens SFPL, Goodreads, and The StoryGraph search results in one click, focusing login fields so Chrome's own password manager can autofill.

**Architecture:** Pure, testable site adapters (`buildSearchUrl` + `detect`) with all Chrome API access confined to a background service worker and a two-side-effect content script. The service worker owns all state and performs all navigation; the content script only classifies pages and focuses username fields.

**Tech Stack:** Plain ES modules, no bundler, no build step. Vitest + jsdom for tests. Node 26 / npm 11 are installed and verified.

## Global Constraints

Every task's requirements implicitly include this section.

- **The content script must never read a field value.** No `.value` reads, anywhere in `src/content/**` or `src/lib/detect-helpers.js`. Task 8 adds a test that fails the build if `.value` appears in content-script source. This is the project's central security boundary.
- **The content script must never navigate.** No `location.assign`, `location.href =`, `location.replace`, or `window.open`. All navigation is `chrome.tabs.update` from the service worker.
- **No credential storage of any kind.** No password fields, no credential inputs, no credential reads. `chrome.storage` holds only preferences and pending-search intents.
- **Permissions are exactly `["storage"]`** plus host permissions for three origins. Never add `tabs`, `scripting`, or `<all_urls>`.
- **Uncertainty resolves to inaction.** Any adapter that cannot confidently classify a page returns `'unknown'`, and `'unknown'` always means: clear state, touch nothing, let the real page sit there.
- **At most one automatic navigation per search intent**, guarded by a `resumed` flag, a 10-minute expiry, and clearing on tab close.
- **No Goodreads or StoryGraph API.** Goodreads retired developer API access in December 2020; StoryGraph never had one. This is a URL-opening tool.
- Node's `URLSearchParams` is the only query encoder used. It serializes space as `+`, `,` as `%2C`, `&` as `%26`, `[` as `%5B`, `]` as `%5D`.

## A refinement to the spec, adopted here

The spec describes `detect()` returning four states. This plan uses **five**: `'results' | 'login' | 'authed' | 'challenge' | 'unknown'`. The extra `'challenge'` state exists to satisfy the spec's own error-handling table, which distinguishes a CAPTCHA/2FA page (red `!` badge) from an unrecognized page (grey `?` badge). Without a separate state those two cases could not produce different badges.

The spec also lists `usernameSelector` on the adapter interface. This plan **drops it** in favor of a generic, site-agnostic resolver: find the password input, then take the last visible text/email input preceding it inside the same form. This survives site redesigns far better than three hand-maintained selectors, and it means the focus behavior works on any login page these sites have, not just the ones we anticipated.

## File Structure

```
manifest.json                     MV3 manifest; permissions, content script, worker
package.json                      vitest + jsdom devDeps, test scripts
vitest.config.js                  jsdom environment

src/lib/query.js                  normalizeQuery, normalizeMode        (pure)
src/lib/detect-helpers.js         shared DOM classification helpers    (pure)
src/lib/intents.js                pending-intent reducer               (pure)
src/lib/badges.js                 badge text + color constants         (pure)
src/lib/prefs.js                  chrome.storage.local wrapper

src/sites/sfpl.js                 adapter                              (pure)
src/sites/goodreads.js            adapter                              (pure)
src/sites/storygraph.js           adapter                              (pure)
src/sites/index.js                registry + adapterForUrl             (pure)

src/background.js                 service worker: tabs, intents, badges
src/content/loader.js             classic-script bootstrap (5 lines)
src/content/runner.js             classify → report → focus

src/popup/popup.html/.css/.js
src/options/options.html/.js

test/query.test.js
test/sites-urls.test.js
test/detect-helpers.test.js
test/sites-detect.test.js
test/intents.test.js
test/security-invariants.test.js
test/fixtures/*.html
README.md
```

Task order follows the dependency chain: pure leaves first, Chrome-facing shells last.

---

### Task 1: Scaffold, query normalization, SFPL URL builder

**Files:**
- Create: `package.json`, `vitest.config.js`, `.gitignore`
- Create: `src/lib/query.js`, `src/sites/sfpl.js`
- Test: `test/query.test.js`, `test/sites-urls.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeQuery(input: unknown) => string` — trims, collapses internal whitespace runs to one space, returns `''` for non-strings.
  - `normalizeMode(input: unknown) => 'title' | 'author'` — returns `'author'` only for exactly `'author'`, otherwise `'title'`.
  - `sfpl` adapter object with `{ id: 'sfpl', hostMatch: 'sfpl.bibliocommons.com', buildSearchUrl(query, mode) }`. `detect` is added in Task 4.

- [ ] **Step 1: Create the npm project and install test deps**

```bash
cd /Users/lizziesiegle/Desktop/demos-2-idk/library-goodreads-storygraph-chromeextension
npm init -y
npm install --save-dev vitest jsdom
```

- [ ] **Step 2: Replace `package.json` contents**

```json
{
  "name": "book-lookup",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Chrome extension: one textbox, three book sites.",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "jsdom": "^27.0.0",
    "vitest": "^4.0.0"
  }
}
```

Keep whatever exact version numbers `npm install` wrote into the file — do not downgrade them to match the sample above.

- [ ] **Step 3: Create `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
.DS_Store
```

- [ ] **Step 5: Write the failing test for query normalization**

Create `test/query.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { normalizeQuery, normalizeMode } from '../src/lib/query.js';

describe('normalizeQuery', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeQuery('  Gabrielle Zevin  ')).toBe('Gabrielle Zevin');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeQuery('Tomorrow,   and\tTomorrow')).toBe('Tomorrow, and Tomorrow');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeQuery('   \t\n ')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(normalizeQuery(undefined)).toBe('');
    expect(normalizeQuery(null)).toBe('');
    expect(normalizeQuery(42)).toBe('');
  });

  it('preserves punctuation, apostrophes and accents', () => {
    expect(normalizeQuery("Ender's Game")).toBe("Ender's Game");
    expect(normalizeQuery('Gabrielle Zevín')).toBe('Gabrielle Zevín');
  });
});

describe('normalizeMode', () => {
  it('returns author only for exactly "author"', () => {
    expect(normalizeMode('author')).toBe('author');
  });

  it('defaults to title for anything else', () => {
    expect(normalizeMode('title')).toBe('title');
    expect(normalizeMode('AUTHOR')).toBe('title');
    expect(normalizeMode(undefined)).toBe('title');
    expect(normalizeMode('keyword')).toBe('title');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- test/query.test.js`
Expected: FAIL — cannot resolve `../src/lib/query.js`.

- [ ] **Step 7: Implement `src/lib/query.js`**

```js
/**
 * Pure query/mode normalization. No Chrome APIs, no DOM.
 */

export function normalizeQuery(input) {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/\s+/g, ' ');
}

export function normalizeMode(input) {
  return input === 'author' ? 'author' : 'title';
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- test/query.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 9: Write the failing test for the SFPL URL builder**

Create `test/sites-urls.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { sfpl } from '../src/sites/sfpl.js';

describe('sfpl.buildSearchUrl', () => {
  it('builds a title search', () => {
    expect(sfpl.buildSearchUrl('Tomorrow, and Tomorrow, and Tomorrow', 'title')).toBe(
      'https://sfpl.bibliocommons.com/v2/search?query=Tomorrow%2C+and+Tomorrow%2C+and+Tomorrow&searchType=title'
    );
  });

  it('builds an author search', () => {
    expect(sfpl.buildSearchUrl('Gabrielle Zevin', 'author')).toBe(
      'https://sfpl.bibliocommons.com/v2/search?query=Gabrielle+Zevin&searchType=author'
    );
  });

  it('normalizes an unrecognized mode to title', () => {
    expect(sfpl.buildSearchUrl('Dune', 'keyword')).toBe(
      'https://sfpl.bibliocommons.com/v2/search?query=Dune&searchType=title'
    );
  });

  it('normalizes surrounding whitespace in the query', () => {
    expect(sfpl.buildSearchUrl('  Dune  ', 'title')).toBe(
      'https://sfpl.bibliocommons.com/v2/search?query=Dune&searchType=title'
    );
  });

  it('percent-encodes ampersands, apostrophes and accents', () => {
    expect(sfpl.buildSearchUrl('Sense & Sensibility', 'title')).toBe(
      'https://sfpl.bibliocommons.com/v2/search?query=Sense+%26+Sensibility&searchType=title'
    );
    expect(sfpl.buildSearchUrl("Ender's Game", 'title')).toBe(
      'https://sfpl.bibliocommons.com/v2/search?query=Ender%27s+Game&searchType=title'
    );
    expect(sfpl.buildSearchUrl('Gabrielle Zevín', 'author')).toBe(
      'https://sfpl.bibliocommons.com/v2/search?query=Gabrielle+Zev%C3%ADn&searchType=author'
    );
  });

  it('exposes its identity and host', () => {
    expect(sfpl.id).toBe('sfpl');
    expect(sfpl.hostMatch).toBe('sfpl.bibliocommons.com');
  });
});
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npm test -- test/sites-urls.test.js`
Expected: FAIL — cannot resolve `../src/sites/sfpl.js`.

- [ ] **Step 11: Implement `src/sites/sfpl.js`**

`detect` is deliberately absent until Task 4 — do not stub it.

```js
import { normalizeQuery, normalizeMode } from '../lib/query.js';

export const sfpl = {
  id: 'sfpl',
  label: 'SFPL',
  hostMatch: 'sfpl.bibliocommons.com',

  buildSearchUrl(query, mode) {
    const params = new URLSearchParams({
      query: normalizeQuery(query),
      searchType: normalizeMode(mode),
    });
    return `https://sfpl.bibliocommons.com/v2/search?${params}`;
  },
};
```

- [ ] **Step 12: Run the full suite**

Run: `npm test`
Expected: PASS, 13 tests across 2 files.

If any expected URL string in Step 9 disagrees with what `URLSearchParams` actually produces, **the test is wrong, not the implementation** — these are mechanical encoding facts. Correct the expected string to the observed output and note it in the commit message.

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json vitest.config.js .gitignore src/lib/query.js src/sites/sfpl.js test/query.test.js test/sites-urls.test.js
git commit -m "feat: scaffold Book Lookup with query normalization and SFPL url builder"
```

---

### Task 2: Goodreads and StoryGraph URL builders

**Files:**
- Create: `src/sites/goodreads.js`, `src/sites/storygraph.js`
- Modify: `test/sites-urls.test.js` (append)

**Interfaces:**
- Consumes: `normalizeQuery`, `normalizeMode` from `src/lib/query.js`.
- Produces:
  - `goodreads` adapter — `{ id: 'goodreads', label: 'Goodreads', hostMatch: 'www.goodreads.com', buildSearchUrl(query, mode) }`
  - `storygraph` adapter — `{ id: 'storygraph', label: 'StoryGraph', hostMatch: 'app.thestorygraph.com', buildSearchUrl(query, mode), ignoresMode: true }`

`ignoresMode: true` is read by the popup in Task 10 to display its "StoryGraph searches all fields" note. Only StoryGraph carries this flag.

- [ ] **Step 1: Append failing tests to `test/sites-urls.test.js`**

Add the import at the top of the file alongside the existing `sfpl` import:

```js
import { goodreads } from '../src/sites/goodreads.js';
import { storygraph } from '../src/sites/storygraph.js';
```

Append these blocks:

```js
describe('goodreads.buildSearchUrl', () => {
  it('builds a title search with the bracketed field parameter encoded', () => {
    expect(goodreads.buildSearchUrl('Tomorrow, and Tomorrow, and Tomorrow', 'title')).toBe(
      'https://www.goodreads.com/search?q=Tomorrow%2C+and+Tomorrow%2C+and+Tomorrow&search%5Bfield%5D=title'
    );
  });

  it('builds an author search', () => {
    expect(goodreads.buildSearchUrl('Gabrielle Zevin', 'author')).toBe(
      'https://www.goodreads.com/search?q=Gabrielle+Zevin&search%5Bfield%5D=author'
    );
  });

  it('normalizes an unrecognized mode to title', () => {
    expect(goodreads.buildSearchUrl('Dune', 'nonsense')).toBe(
      'https://www.goodreads.com/search?q=Dune&search%5Bfield%5D=title'
    );
  });

  it('exposes its identity and host', () => {
    expect(goodreads.id).toBe('goodreads');
    expect(goodreads.hostMatch).toBe('www.goodreads.com');
  });
});

describe('storygraph.buildSearchUrl', () => {
  it('builds a browse search', () => {
    expect(storygraph.buildSearchUrl('Gabrielle Zevin', 'author')).toBe(
      'https://app.thestorygraph.com/browse?search_term=Gabrielle+Zevin'
    );
  });

  it('produces an identical url regardless of mode, since the site has no field distinction', () => {
    const asTitle = storygraph.buildSearchUrl('Tomorrow, and Tomorrow, and Tomorrow', 'title');
    const asAuthor = storygraph.buildSearchUrl('Tomorrow, and Tomorrow, and Tomorrow', 'author');
    expect(asTitle).toBe(asAuthor);
    expect(asTitle).toBe(
      'https://app.thestorygraph.com/browse?search_term=Tomorrow%2C+and+Tomorrow%2C+and+Tomorrow'
    );
  });

  it('declares that it ignores the mode toggle', () => {
    expect(storygraph.ignoresMode).toBe(true);
    expect(sfpl.ignoresMode).toBeUndefined();
    expect(goodreads.ignoresMode).toBeUndefined();
  });

  it('exposes its identity and host', () => {
    expect(storygraph.id).toBe('storygraph');
    expect(storygraph.hostMatch).toBe('app.thestorygraph.com');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/sites-urls.test.js`
Expected: FAIL — cannot resolve `../src/sites/goodreads.js`.

- [ ] **Step 3: Implement `src/sites/goodreads.js`**

```js
import { normalizeQuery, normalizeMode } from '../lib/query.js';

export const goodreads = {
  id: 'goodreads',
  label: 'Goodreads',
  hostMatch: 'www.goodreads.com',

  buildSearchUrl(query, mode) {
    const params = new URLSearchParams({
      q: normalizeQuery(query),
      'search[field]': normalizeMode(mode),
    });
    return `https://www.goodreads.com/search?${params}`;
  },
};
```

- [ ] **Step 4: Implement `src/sites/storygraph.js`**

```js
import { normalizeQuery } from '../lib/query.js';

export const storygraph = {
  id: 'storygraph',
  label: 'StoryGraph',
  hostMatch: 'app.thestorygraph.com',

  /**
   * StoryGraph has no title/author field distinction — `search_term` is free
   * text matched across titles, authors and series. The mode argument is
   * accepted for interface symmetry and deliberately ignored.
   */
  ignoresMode: true,

  buildSearchUrl(query, _mode) {
    const params = new URLSearchParams({ search_term: normalizeQuery(query) });
    return `https://app.thestorygraph.com/browse?${params}`;
  },
};
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 21 tests.

- [ ] **Step 6: Commit**

```bash
git add src/sites/goodreads.js src/sites/storygraph.js test/sites-urls.test.js
git commit -m "feat: add Goodreads and StoryGraph url builders"
```

---

### Task 3: Shared DOM classification helpers

**Files:**
- Create: `src/lib/detect-helpers.js`
- Test: `test/detect-helpers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `findPasswordInput(doc: Document) => HTMLInputElement | null`
  - `findUsernameField(doc: Document) => HTMLElement | null` — the last visible text/email input preceding the password input within the same form.
  - `hasChallenge(doc: Document) => boolean` — CAPTCHA / Cloudflare interstitial / one-time-code prompt.
  - `matchesAny(doc: Document, selectors: string[]) => boolean`
  - `AUTHED_SELECTORS: string[]` — sign-out markers common to all three sites.

**Critical:** this module must never read `.value` from any element. Task 8 enforces it with a test.

- [ ] **Step 1: Write the failing test**

Create `test/detect-helpers.test.js`:

```js
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

  it('handles a formless login widget, as single-page apps render', () => {
    const doc = docFrom(`
      <header><input type="text" id="sitesearch"></header>
      <div id="login">
        <input type="email" id="email">
        <input type="password" id="pw">
      </div>`);
    expect(findUsernameField(doc).id).toBe('email');
  });

  it('walks past an intermediate wrapper to find the candidate', () => {
    const doc = docFrom(`
      <div id="login">
        <div class="row"><input type="email" id="email"></div>
        <div class="row"><input type="password" id="pw"></div>
      </div>`);
    expect(findUsernameField(doc).id).toBe('email');
  });

  it('returns null rather than focusing a header search box on a formless password-only page', () => {
    const doc = docFrom(`
      <header><input type="text" id="sitesearch"></header>
      <div id="reauth"><input type="password" id="pw"></div>`);
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

  it('detects a named two-factor field', () => {
    expect(hasChallenge(docFrom('<input name="otp">'))).toBe(true);
    expect(hasChallenge(docFrom('<input name="otp_attempt">'))).toBe(true);
    expect(hasChallenge(docFrom('<input name="user_otp">'))).toBe(true);
    expect(hasChallenge(docFrom('<input name="two_factor_code">'))).toBe(true);
  });

  it('does not trip on an innocent name that merely contains "otp"', () => {
    // An unanchored *="otp" match fires on this, and a false challenge makes
    // the extension refuse to act on a perfectly good page.
    expect(hasChallenge(docFrom('<input name="hotpad">'))).toBe(false);
    expect(hasChallenge(docFrom('<input name="depotplan">'))).toBe(false);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/detect-helpers.test.js`
Expected: FAIL — cannot resolve `../src/lib/detect-helpers.js`.

- [ ] **Step 3: Implement `src/lib/detect-helpers.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/detect-helpers.test.js`
Expected: PASS, 25 tests.

If `DOMParser` is undefined, confirm `vitest.config.js` sets `environment: 'jsdom'` — that is the cause.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 46 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/detect-helpers.js test/detect-helpers.test.js
git commit -m "feat: add site-agnostic login and challenge detection helpers"
```

---

### Task 4: Per-site `detect()` and the adapter registry

**Files:**
- Modify: `src/sites/sfpl.js`, `src/sites/goodreads.js`, `src/sites/storygraph.js`
- Create: `src/sites/index.js`, `test/fixtures/*.html`
- Test: `test/sites-detect.test.js`

**Interfaces:**
- Consumes: `findPasswordInput`, `hasChallenge`, `matchesAny`, `AUTHED_SELECTORS` from `src/lib/detect-helpers.js`.
- Produces:
  - `adapter.detect(doc: Document, url: string) => 'results' | 'login' | 'authed' | 'challenge' | 'unknown'` on all three adapters.
  - `ADAPTERS: Adapter[]` and `ADAPTER_IDS: string[]` (order: `['sfpl', 'goodreads', 'storygraph']`) from `src/sites/index.js`.
  - `getAdapter(id: string) => Adapter | null`
  - `adapterForUrl(url: string) => Adapter | null`

**Classification order is identical across all three adapters and must not vary:**

1. `challenge` — a CAPTCHA or 2FA gate short-circuits everything.
2. `login` — a usable password input is present.
3. `results` — the URL path is one of this site's results paths.
4. `authed` — a sign-out marker is present.
5. `unknown` — anything else.

`results` outranks `authed` deliberately: once the user is looking at results, the job is done and the intent should be cleared regardless of session state. SFPL and Goodreads both serve results to logged-out visitors, and that is a success, not a login prompt.

**Honesty note for the implementer:** the `authed` branch is the one classification that could not be verified against a real captured page (StoryGraph blocks automated fetches; no logged-in page was reachable). The fixtures below are handwritten approximations. Task 11 replaces them with real captures. Do not describe `authed` detection as verified until that task is done.

- [ ] **Step 1: Create the fixture files**

Create `test/fixtures/sfpl-results-logged-out.html`:

```html
<!doctype html>
<html><body>
  <header><a href="/user/login">Log In / Register</a></header>
  <main><h1>1 - 20 of 34 results</h1><ul class="results"><li>Tomorrow, and Tomorrow, and Tomorrow</li></ul></main>
</body></html>
```

Create `test/fixtures/sfpl-login.html`:

```html
<!doctype html>
<html><body>
  <header><input type="search" id="sitesearch" placeholder="Search the catalogue"></header>
  <form action="/user/login" method="post">
    <input type="hidden" name="authenticity_token">
    <label for="name">Library card number or username</label>
    <input type="text" id="name" name="name">
    <label for="user_pin">PIN</label>
    <input type="password" id="user_pin" name="user_pin">
    <button type="submit">Log In</button>
  </form>
</body></html>
```

Create `test/fixtures/sfpl-authed-dashboard.html`:

```html
<!doctype html>
<html><body>
  <header>
    <a href="/dashboard/user_dashboard">My Library Dashboard</a>
    <a href="/user/logout">Log Out</a>
  </header>
  <main><h1>Welcome back</h1></main>
</body></html>
```

Create `test/fixtures/goodreads-results-logged-out.html`:

```html
<!doctype html>
<html><body>
  <header><a href="/user/sign_in">Sign In</a></header>
  <main><h1>Search results</h1><table class="tableList"><tr><td>Tomorrow, and Tomorrow, and Tomorrow</td></tr></table></main>
</body></html>
```

Create `test/fixtures/goodreads-login.html`:

```html
<!doctype html>
<html><body>
  <form action="/user/sign_in" method="post">
    <label for="user_email">Email address</label>
    <input type="email" id="user_email" name="user[email]">
    <label for="user_password">Password</label>
    <input type="password" id="user_password" name="user[password]">
    <button type="submit">Sign in</button>
  </form>
</body></html>
```

Create `test/fixtures/goodreads-authed-search.html`:

```html
<!doctype html>
<html><body>
  <header><a href="/user/sign_out">Sign out</a></header>
  <main><h1>Search results</h1></main>
</body></html>
```

Create `test/fixtures/storygraph-login.html`:

```html
<!doctype html>
<html><body>
  <form action="/users/sign_in" method="post">
    <label for="user_email">Email</label>
    <input type="email" id="user_email" name="user[email]">
    <label for="user_password">Password</label>
    <input type="password" id="user_password" name="user[password]">
    <button type="submit">Sign in</button>
  </form>
</body></html>
```

Create `test/fixtures/storygraph-authed-browse.html`:

```html
<!doctype html>
<html><body>
  <nav><a href="/users/sign_out" data-turbo-method="delete">Sign out</a></nav>
  <main><h1>Browse</h1><div class="book-pane">Tomorrow, and Tomorrow, and Tomorrow</div></main>
</body></html>
```

Create `test/fixtures/challenge-cloudflare.html`:

```html
<!doctype html>
<html><body>
  <div id="challenge-running">Checking your browser before accessing app.thestorygraph.com</div>
</body></html>
```

Create `test/fixtures/challenge-two-factor.html`:

```html
<!doctype html>
<html><body>
  <form action="/users/two_factor" method="post">
    <label for="otp">Enter the 6-digit code</label>
    <input type="text" id="otp" name="otp_attempt" autocomplete="one-time-code">
  </form>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `test/sites-detect.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sfpl } from '../src/sites/sfpl.js';
import { goodreads } from '../src/sites/goodreads.js';
import { storygraph } from '../src/sites/storygraph.js';
import { ADAPTERS, ADAPTER_IDS, getAdapter, adapterForUrl } from '../src/sites/index.js';

function fixture(name) {
  const path = fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url));
  return new DOMParser().parseFromString(readFileSync(path, 'utf8'), 'text/html');
}

const SFPL_SEARCH = 'https://sfpl.bibliocommons.com/v2/search?query=Dune&searchType=title';
const GR_SEARCH = 'https://www.goodreads.com/search?q=Dune&search%5Bfield%5D=title';
const SG_BROWSE = 'https://app.thestorygraph.com/browse?search_term=Dune';

describe('sfpl.detect', () => {
  it('classifies a results page as results even when logged out', () => {
    expect(sfpl.detect(fixture('sfpl-results-logged-out'), SFPL_SEARCH)).toBe('results');
  });

  it('classifies a login page as login', () => {
    expect(sfpl.detect(fixture('sfpl-login'), 'https://sfpl.bibliocommons.com/user/login')).toBe('login');
  });

  it('classifies a signed-in dashboard as authed', () => {
    expect(sfpl.detect(fixture('sfpl-authed-dashboard'), 'https://sfpl.bibliocommons.com/dashboard/user_dashboard')).toBe('authed');
  });

  it('classifies an unrecognized page as unknown', () => {
    const doc = new DOMParser().parseFromString('<h1>Hours & Locations</h1>', 'text/html');
    expect(sfpl.detect(doc, 'https://sfpl.bibliocommons.com/locations')).toBe('unknown');
  });
});

describe('goodreads.detect', () => {
  it('classifies a results page as results even when logged out', () => {
    expect(goodreads.detect(fixture('goodreads-results-logged-out'), GR_SEARCH)).toBe('results');
  });

  it('classifies a single-match book page redirect as results', () => {
    const doc = fixture('goodreads-authed-search');
    expect(goodreads.detect(doc, 'https://www.goodreads.com/book/show/58784475-tomorrow-and-tomorrow-and-tomorrow')).toBe('results');
  });

  it('classifies a sign-in page as login', () => {
    expect(goodreads.detect(fixture('goodreads-login'), 'https://www.goodreads.com/user/sign_in')).toBe('login');
  });

  it('classifies a signed-in non-results page as authed', () => {
    expect(goodreads.detect(fixture('goodreads-authed-search'), 'https://www.goodreads.com/')).toBe('authed');
  });
});

describe('storygraph.detect', () => {
  it('classifies a browse page as results', () => {
    expect(storygraph.detect(fixture('storygraph-authed-browse'), SG_BROWSE)).toBe('results');
  });

  it('classifies a sign-in page as login', () => {
    expect(storygraph.detect(fixture('storygraph-login'), 'https://app.thestorygraph.com/users/sign_in')).toBe('login');
  });

  it('classifies a signed-in home page as authed', () => {
    expect(storygraph.detect(fixture('storygraph-authed-browse'), 'https://app.thestorygraph.com/')).toBe('authed');
  });
});

describe('challenge detection outranks everything, on every adapter', () => {
  it('classifies a Cloudflare interstitial as challenge even on a results url', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.detect(fixture('challenge-cloudflare'), SG_BROWSE)).toBe('challenge');
    }
  });

  it('classifies a two-factor prompt as challenge', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.detect(fixture('challenge-two-factor'), 'https://example.com/two_factor')).toBe('challenge');
    }
  });
});

describe('registry', () => {
  it('exposes all three adapters in a stable order', () => {
    expect(ADAPTER_IDS).toEqual(['sfpl', 'goodreads', 'storygraph']);
    expect(ADAPTERS.map((a) => a.id)).toEqual(ADAPTER_IDS);
  });

  it('looks adapters up by id', () => {
    expect(getAdapter('goodreads')).toBe(goodreads);
    expect(getAdapter('nope')).toBeNull();
  });

  it('resolves adapters from a url host', () => {
    expect(adapterForUrl(SFPL_SEARCH)).toBe(sfpl);
    expect(adapterForUrl(GR_SEARCH)).toBe(goodreads);
    expect(adapterForUrl(SG_BROWSE)).toBe(storygraph);
  });

  it('returns null for an unrelated host', () => {
    expect(adapterForUrl('https://example.com/')).toBeNull();
  });

  it('returns null for an unparseable url', () => {
    expect(adapterForUrl('not a url')).toBeNull();
  });

  it('does not match a lookalike host', () => {
    expect(adapterForUrl('https://www.goodreads.com.evil.test/search')).toBeNull();
  });

  it('gives every adapter the full interface', () => {
    for (const adapter of ADAPTERS) {
      expect(typeof adapter.id).toBe('string');
      expect(typeof adapter.label).toBe('string');
      expect(typeof adapter.hostMatch).toBe('string');
      expect(typeof adapter.buildSearchUrl).toBe('function');
      expect(typeof adapter.detect).toBe('function');
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/sites-detect.test.js`
Expected: FAIL — `sfpl.detect is not a function`.

- [ ] **Step 4: Add a shared classifier to `src/lib/detect-helpers.js`**

Append to that file:

```js
/**
 * The shared classification ladder every adapter walks, in a fixed order.
 * `isResultsUrl` is the only per-site variation.
 */
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
```

- [ ] **Step 5: Add `detect` to `src/sites/sfpl.js`**

Add the import at the top:

```js
import { classify } from '../lib/detect-helpers.js';
```

and this property to the `sfpl` object:

```js
  detect(doc, url) {
    return classify(doc, url, (pathname) => pathname.startsWith('/v2/search'));
  },
```

- [ ] **Step 6: Add `detect` to `src/sites/goodreads.js`**

Add the import at the top:

```js
import { classify } from '../lib/detect-helpers.js';
```

and this property to the `goodreads` object:

```js
  detect(doc, url) {
    // Goodreads redirects an exact single match straight to the book page.
    // That is a successful landing, not an unrecognized page.
    return classify(
      doc,
      url,
      (pathname) => pathname.startsWith('/search') || pathname.startsWith('/book/show/')
    );
  },
```

- [ ] **Step 7: Add `detect` to `src/sites/storygraph.js`**

Add the import at the top:

```js
import { classify } from '../lib/detect-helpers.js';
```

and this property to the `storygraph` object:

```js
  detect(doc, url) {
    return classify(
      doc,
      url,
      (pathname) => pathname.startsWith('/browse') || pathname.startsWith('/books/')
    );
  },
```

- [ ] **Step 8: Create `src/sites/index.js`**

```js
import { sfpl } from './sfpl.js';
import { goodreads } from './goodreads.js';
import { storygraph } from './storygraph.js';

/**
 * Order matters: it is the popup's button order and the tab-focus preference
 * order. SFPL comes first because it is the site with a real time cost —
 * holds and waitlists are queue-based.
 */
export const ADAPTERS = [sfpl, goodreads, storygraph];
export const ADAPTER_IDS = ADAPTERS.map((adapter) => adapter.id);

export function getAdapter(id) {
  return ADAPTERS.find((adapter) => adapter.id === id) || null;
}

export function adapterForUrl(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  // Exact host equality — never a substring test, or `goodreads.com.evil.test`
  // would match.
  return ADAPTERS.find((adapter) => adapter.hostMatch === host) || null;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- test/sites-detect.test.js`
Expected: PASS, 20 tests.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS, 66 tests.

- [ ] **Step 11: Commit**

```bash
git add src/sites/ src/lib/detect-helpers.js test/sites-detect.test.js test/fixtures/
git commit -m "feat: add per-site page classification and adapter registry"
```

---

### Task 5: Pending-intent state machine

**Files:**
- Create: `src/lib/intents.js`, `src/lib/badges.js`
- Test: `test/intents.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `INTENT_TTL_MS: number` (600000)
  - `BADGE: { KEY: {text, color}, ALERT: {...}, QUESTION: {...} }` from `src/lib/badges.js`
  - `createIntent({ tabId, site, targetUrl, now }) => Intent` where `Intent = { tabId, site, targetUrl, resumed: boolean, expiresAt: number }`
  - `decide(intent: Intent | null, { state: string, now: number }) => Decision` where
    `Decision = { action: 'resume' | 'focus' | 'none', targetUrl: string | null, badge: 'KEY' | 'ALERT' | 'QUESTION' | null, intent: Intent | null }`

`decision.intent` is the intent to store afterwards — `null` means "delete the stored intent for this tab". The caller writes whatever comes back; it never decides for itself.

- [ ] **Step 1: Create `src/lib/badges.js`**

```js
/**
 * Chrome badge text is limited to roughly four characters, so these are
 * single glyphs. Keys are the strings `decide()` returns.
 */
export const BADGE = {
  KEY: { text: '🔑', color: '#B45309', title: 'Book Lookup — manual login needed' },
  ALERT: { text: '!', color: '#B91C1C', title: 'Book Lookup — the site is showing a challenge; handle it manually' },
  QUESTION: { text: '?', color: '#6B7280', title: "Book Lookup — couldn't recognize this page" },
};
```

- [ ] **Step 2: Write the failing test**

Create `test/intents.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/intents.test.js`
Expected: FAIL — cannot resolve `../src/lib/intents.js`.

- [ ] **Step 4: Implement `src/lib/intents.js`**

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/intents.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 82 tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/intents.js src/lib/badges.js test/intents.test.js
git commit -m "feat: add pending-intent state machine with a one-resume guarantee"
```

---

### Task 6: Manifest and preferences

**Files:**
- Create: `manifest.json`, `src/lib/prefs.js`

**Interfaces:**
- Consumes: `ADAPTER_IDS` from `src/sites/index.js`.
- Produces:
  - `DEFAULT_PREFS: { mode: 'title', sites: string[], lastQuery: '' }`
  - `loadPrefs() => Promise<Prefs>` — merges stored values over defaults.
  - `savePrefs(partial: Partial<Prefs>) => Promise<void>`

This task has no automated test — it is Chrome API surface and JSON config. It is verified by loading the extension, which happens in Step 5.

- [ ] **Step 1: Create `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Book Lookup",
  "version": "1.0.0",
  "description": "One textbox: search a book title or author across SFPL, Goodreads and The StoryGraph.",
  "permissions": ["storage"],
  "host_permissions": [
    "https://sfpl.bibliocommons.com/*",
    "https://www.goodreads.com/*",
    "https://app.thestorygraph.com/*"
  ],
  "background": {
    "service_worker": "src/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_title": "Book Lookup"
  },
  "options_page": "src/options/options.html",
  "content_scripts": [
    {
      "matches": [
        "https://sfpl.bibliocommons.com/*",
        "https://www.goodreads.com/*",
        "https://app.thestorygraph.com/*"
      ],
      "js": ["src/content/loader.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["src/content/runner.js", "src/sites/*.js", "src/lib/*.js"],
      "matches": [
        "https://sfpl.bibliocommons.com/*",
        "https://www.goodreads.com/*",
        "https://app.thestorygraph.com/*"
      ]
    }
  ]
}
```

Do not add `tabs` or `scripting`. `chrome.tabs.create` and `chrome.tabs.update` both work without the `tabs` permission; that permission only governs reading tab URLs, which this extension never does.

- [ ] **Step 2: Create `src/lib/prefs.js`**

```js
import { ADAPTER_IDS } from '../sites/index.js';

export const DEFAULT_PREFS = {
  mode: 'title',
  sites: [...ADAPTER_IDS],
  lastQuery: '',
};

export async function loadPrefs() {
  const stored = await chrome.storage.local.get(DEFAULT_PREFS);
  const sites = Array.isArray(stored.sites)
    ? stored.sites.filter((id) => ADAPTER_IDS.includes(id))
    : [];

  return {
    mode: stored.mode === 'author' ? 'author' : 'title',
    // Never let a corrupted or empty stored list leave the popup with no
    // sites to search.
    sites: sites.length ? sites : [...ADAPTER_IDS],
    lastQuery: typeof stored.lastQuery === 'string' ? stored.lastQuery : '',
  };
}

export async function savePrefs(partial) {
  await chrome.storage.local.set(partial);
}
```

- [ ] **Step 3: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS, 82 tests.

- [ ] **Step 4: Commit**

```bash
git add manifest.json src/lib/prefs.js
git commit -m "feat: add MV3 manifest and preference storage"
```

- [ ] **Step 5: Note for the reviewer**

The extension cannot be loaded into Chrome yet — `src/background.js`, `src/content/loader.js`, `src/popup/popup.html` and `src/options/options.html` do not exist, and Chrome refuses a manifest referencing missing files. First load happens at the end of Task 9. Do not attempt to load it before then.

---

### Task 7: Background service worker

**Files:**
- Create: `src/background.js`

**Interfaces:**
- Consumes: `ADAPTERS`, `getAdapter`, `adapterForUrl` from `src/sites/index.js`; `createIntent`, `decide` from `src/lib/intents.js`; `BADGE` from `src/lib/badges.js`; `normalizeQuery`, `normalizeMode` from `src/lib/query.js`.
- Produces the two message contracts every other component speaks:
  - Popup → worker: `{ type: 'search', query: string, mode: 'title'|'author', sites: string[] }` → responds `{ opened: number }`
  - Content → worker: `{ type: 'page', site: string, state: string }` → responds `{ focus: boolean }`

This task has no automated test — it is almost entirely Chrome API calls, and its two pieces of real logic (`decide` and the adapters) are already tested. It is verified by the manual smoke test in Task 11.

- [ ] **Step 1: Create `src/background.js`**

```js
import { ADAPTERS, getAdapter, adapterForUrl } from './sites/index.js';
import { createIntent, decide } from './lib/intents.js';
import { BADGE } from './lib/badges.js';
import { normalizeQuery, normalizeMode } from './lib/query.js';

const intentKey = (tabId) => `intent:${tabId}`;

async function readIntent(tabId) {
  const key = intentKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function writeIntent(tabId, intent) {
  const key = intentKey(tabId);
  if (intent) {
    await chrome.storage.session.set({ [key]: intent });
  } else {
    await chrome.storage.session.remove(key);
  }
}

async function setBadge(tabId, badgeName) {
  if (!badgeName) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'Book Lookup' });
    return;
  }
  const badge = BADGE[badgeName];
  await chrome.action.setBadgeText({ tabId, text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
  await chrome.action.setTitle({ tabId, title: badge.title });
}

/**
 * Open one tab per requested site. The first site in adapter order becomes the
 * active tab — SFPL, normally, because holds and waitlists are queue-based and
 * it is the one worth looking at first. The rest load in the background.
 */
async function runSearch({ query, mode, sites }) {
  const cleanQuery = normalizeQuery(query);
  const cleanMode = normalizeMode(mode);
  if (!cleanQuery) return { opened: 0 };

  const requested = ADAPTERS.filter((adapter) => sites.includes(adapter.id));
  if (!requested.length) return { opened: 0 };

  let opened = 0;
  for (const [index, adapter] of requested.entries()) {
    const targetUrl = adapter.buildSearchUrl(cleanQuery, cleanMode);
    const tab = await chrome.tabs.create({ url: targetUrl, active: index === 0 });
    await writeIntent(
      tab.id,
      createIntent({ tabId: tab.id, site: adapter.id, targetUrl, now: Date.now() })
    );
    opened += 1;
  }
  return { opened };
}

/**
 * A content script has classified the page it is running on.
 * The worker owns every decision and every navigation; the content script only
 * ever reports and, if told to, focuses a field.
 */
async function handlePageReport({ site, state }, tabId) {
  if (!getAdapter(site)) return { focus: false };

  const intent = await readIntent(tabId);
  const decision = decide(intent, { state, now: Date.now() });

  await writeIntent(tabId, decision.intent);
  await setBadge(tabId, decision.badge);

  if (decision.action === 'resume' && decision.targetUrl) {
    await chrome.tabs.update(tabId, { url: decision.targetUrl });
    return { focus: false };
  }

  return { focus: decision.action === 'focus' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'search') {
    runSearch(message).then(sendResponse);
    return true;
  }

  if (message.type === 'page') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ focus: false });
      return false;
    }
    handlePageReport(message, tabId).then(sendResponse);
    return true;
  }

  return false;
});

// Abandon an intent when its tab closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  writeIntent(tabId, null);
});

// Abandon an intent when the tab leaves the site it was created for, and clear
// any stale badge with it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!adapterForUrl(changeInfo.url)) {
    writeIntent(tabId, null);
    setBadge(tabId, null);
  }
});
```

- [ ] **Step 2: Verify the module parses**

Run: `node --input-type=module -e "import('./src/background.js').catch(e => { console.log(e.constructor.name + ': ' + e.message); })"`

Expected: a `ReferenceError` mentioning `chrome`. That proves the file parses and its imports resolve — Node has no `chrome` global, so reaching that error is success. A `SyntaxError` or a module-resolution error is a real failure to fix.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, 82 tests.

- [ ] **Step 4: Commit**

```bash
git add src/background.js
git commit -m "feat: add background worker owning tabs, intents and badges"
```

---

### Task 8: Content script and the security invariant test

**Files:**
- Create: `src/content/loader.js`, `src/content/runner.js`
- Test: `test/security-invariants.test.js`

**Interfaces:**
- Consumes: `adapterForUrl` from `src/sites/index.js`; `findUsernameField` from `src/lib/detect-helpers.js`.
- Produces: `run() => Promise<void>` exported from `src/content/runner.js`, called by the loader.

Content scripts declared in a manifest are classic scripts and cannot use static `import`. The loader is a classic script whose only job is to dynamically import the real module from `web_accessible_resources`.

- [ ] **Step 1: Write the failing security invariant test**

Create `test/security-invariants.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

/**
 * Executable code with comments removed.
 *
 * These files document their own invariants, and that documentation naturally
 * quotes the very patterns being banned — `detect-helpers.js` says outright
 * that it may never read `.value`. Grepping raw source would fail on the
 * comment explaining the rule. Strip comments and the invariant tests what
 * actually runs.
 */
function code(relativePath) {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The files that execute inside a page's context. Everything here runs where a
 * password field lives, so these are the files the invariants must hold for.
 */
const IN_PAGE_FILES = [
  'src/content/loader.js',
  'src/content/runner.js',
  'src/lib/detect-helpers.js',
  'src/sites/sfpl.js',
  'src/sites/goodreads.js',
  'src/sites/storygraph.js',
  'src/sites/index.js',
  'src/lib/query.js',
];

describe('the comment stripper does not make these invariants vacuous', () => {
  it.each(IN_PAGE_FILES)('%s still has substantial code after stripping', (file) => {
    expect(code(file).trim().length).toBeGreaterThan(50);
  });

  it('leaves real code untouched while removing prose', () => {
    const stripped = code('src/lib/detect-helpers.js');
    expect(stripped).toContain('querySelector');
    expect(stripped).toContain('export function findUsernameField');
    expect(stripped).not.toContain('SECURITY INVARIANT');
  });

  it('would catch a genuine violation', () => {
    // Positive control: the banned patterns must actually be detectable in code.
    const sample = 'const v = input.value;\nfetch("/x");\nlocation.assign("/y");';
    expect(sample).toMatch(/\.value\b/);
    expect(sample).toMatch(/\bfetch\(/);
    expect(sample).toMatch(/location\.assign/);
  });
});

describe('the content script never reads a field value', () => {
  it.each(IN_PAGE_FILES)('%s contains no .value access', (file) => {
    expect(code(file)).not.toMatch(/\.value\b/);
  });

  it.each(IN_PAGE_FILES)('%s reads no form data in bulk', (file) => {
    expect(code(file)).not.toMatch(/\bFormData\b/);
    expect(code(file)).not.toMatch(/\.elements\b/);
  });
});

describe('the content script never navigates', () => {
  it.each(IN_PAGE_FILES)('%s performs no navigation', (file) => {
    const text = code(file);
    expect(text).not.toMatch(/location\.assign/);
    expect(text).not.toMatch(/location\.replace/);
    expect(text).not.toMatch(/location\.href\s*=/);
    expect(text).not.toMatch(/window\.open/);
    expect(text).not.toMatch(/\bsubmit\(\)/);
  });
});

describe('the content script never exfiltrates', () => {
  it.each(IN_PAGE_FILES)('%s makes no network calls and logs nothing', (file) => {
    const text = code(file);
    expect(text).not.toMatch(/\bfetch\(/);
    expect(text).not.toMatch(/XMLHttpRequest/);
    expect(text).not.toMatch(/\bconsole\.(log|info|warn|debug)\(/);
  });
});

describe('the manifest requests no more than it needs', () => {
  const manifest = JSON.parse(source('manifest.json'));

  it('requests only the storage permission', () => {
    expect(manifest.permissions).toEqual(['storage']);
  });

  it('scopes host permissions to exactly the three sites', () => {
    expect(manifest.host_permissions).toEqual([
      'https://sfpl.bibliocommons.com/*',
      'https://www.goodreads.com/*',
      'https://app.thestorygraph.com/*',
    ]);
  });

  it('never requests all-urls access', () => {
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
    expect(JSON.stringify(manifest)).not.toContain('*://*/*');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/security-invariants.test.js`
Expected: FAIL — `ENOENT` on `src/content/loader.js`.

- [ ] **Step 3: Create `src/content/loader.js`**

```js
// Manifest-declared content scripts are classic scripts and cannot use static
// import. Bootstrap the real ES module from web_accessible_resources.
(async () => {
  const module = await import(chrome.runtime.getURL('src/content/runner.js'));
  await module.run();
})().catch(() => {
  // A failed bootstrap must leave the page exactly as it found it.
});
```

- [ ] **Step 4: Create `src/content/runner.js`**

```js
import { adapterForUrl } from '../sites/index.js';
import { findUsernameField } from '../lib/detect-helpers.js';

/**
 * This module has exactly two side effects available to it:
 *   1. focus() a username field
 *   2. send a message to the background worker
 *
 * It never reads a field's contents, never navigates, and never makes a
 * network request. See test/security-invariants.test.js, which fails the
 * build if that stops being true.
 */

const RECHECK_DELAY_MS = 1500;

async function report(adapter) {
  const state = adapter.detect(document, location.href);
  const reply = await chrome.runtime.sendMessage({
    type: 'page',
    site: adapter.id,
    state,
  });

  if (reply?.focus) {
    const field = findUsernameField(document);
    // Focus surfaces Chrome's own autofill suggestion. Chrome deliberately
    // blocks scripted password entry; we neither want nor attempt it.
    if (field) field.focus();
  }

  return state;
}

export async function run() {
  const adapter = adapterForUrl(location.href);
  if (!adapter) return;

  const state = await report(adapter);

  // Two of these sites render client-side, so a page can still be assembling
  // itself at document_idle. Exactly one delayed re-check — never a loop.
  if (state === 'unknown') {
    setTimeout(() => {
      report(adapter).catch(() => {});
    }, RECHECK_DELAY_MS);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/security-invariants.test.js`
Expected: PASS, 45 tests.

If the `.value` assertion fails on a file you did not expect, do not weaken the test — find the read and remove it. That test is the security boundary this whole design rests on.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 127 tests.

- [ ] **Step 7: Commit**

```bash
git add src/content/ test/security-invariants.test.js
git commit -m "feat: add content script with enforced no-value-read invariant"
```

---

### Task 9: Popup

**Files:**
- Create: `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.js`

**Interfaces:**
- Consumes: `ADAPTERS` from `src/sites/index.js`; `loadPrefs`, `savePrefs` from `src/lib/prefs.js`; `normalizeQuery` from `src/lib/query.js`.
- Produces: no exports. Sends `{ type: 'search', query, mode, sites }` to the worker.

This is the surface that gets demoed, so it should look deliberate rather than default-styled. No framework, no external fonts — a CSP-safe self-contained page.

- [ ] **Step 1: Create `src/popup/popup.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="popup.css" />
    <title>Book Lookup</title>
  </head>
  <body>
    <form id="search-form" autocomplete="off">
      <h1>Book Lookup</h1>

      <input
        type="search"
        id="query"
        name="query"
        placeholder="Title or author…"
        aria-label="Book title or author"
        autofocus
      />

      <div class="modes" role="radiogroup" aria-label="Search by">
        <label><input type="radio" name="mode" value="title" checked /><span>Title</span></label>
        <label><input type="radio" name="mode" value="author" /><span>Author</span></label>
      </div>

      <button type="submit" id="search-all" class="primary">Search all</button>

      <div class="sites" id="sites"></div>

      <p class="note" id="mode-note" hidden>
        StoryGraph searches titles, authors and series together — it has no separate mode.
      </p>
    </form>

    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/popup/popup.css`**

```css
:root {
  --paper: #fbf7f0;
  --ink: #23201c;
  --muted: #6f6659;
  --rule: #e2d9cb;
  --accent: #7a3d2e;
  --accent-ink: #fdfaf5;
  color-scheme: light;
}

* { box-sizing: border-box; }

body {
  width: 320px;
  margin: 0;
  padding: 16px;
  background: var(--paper);
  color: var(--ink);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

h1 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

#query {
  width: 100%;
  padding: 10px 12px;
  font-size: 15px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--rule);
  border-radius: 8px;
}

#query:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-color: transparent;
}

.modes {
  display: flex;
  gap: 6px;
  margin: 10px 0 12px;
}

.modes label { flex: 1; }
.modes input { position: absolute; opacity: 0; pointer-events: none; }

.modes span {
  display: block;
  padding: 7px 0;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
  background: #fff;
  border: 1px solid var(--rule);
  border-radius: 7px;
  cursor: pointer;
}

.modes input:checked + span {
  color: var(--accent-ink);
  background: var(--accent);
  border-color: var(--accent);
}

.modes input:focus-visible + span {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

button {
  font: inherit;
  cursor: pointer;
  border-radius: 8px;
}

.primary {
  width: 100%;
  padding: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--accent);
  border: 1px solid var(--accent);
}

.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sites {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 8px;
}

.sites button {
  padding: 8px 4px;
  font-size: 12px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--rule);
}

.sites button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.note {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--rule);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--muted);
}
```

- [ ] **Step 3: Create `src/popup/popup.js`**

```js
import { ADAPTERS } from '../sites/index.js';
import { loadPrefs, savePrefs } from '../lib/prefs.js';
import { normalizeQuery } from '../lib/query.js';

const form = document.getElementById('search-form');
const queryInput = document.getElementById('query');
const searchAll = document.getElementById('search-all');
const sitesRow = document.getElementById('sites');
const modeNote = document.getElementById('mode-note');

let enabledSites = ADAPTERS.map((adapter) => adapter.id);

function currentMode() {
  return form.elements.mode.value === 'author' ? 'author' : 'title';
}

function hasQuery() {
  return normalizeQuery(queryInput.value).length > 0;
}

function refreshEnabledState() {
  const ready = hasQuery();
  searchAll.disabled = !ready;
  for (const button of sitesRow.querySelectorAll('button')) {
    button.disabled = !ready;
  }

  const storygraphInvolved = enabledSites.includes('storygraph');
  modeNote.hidden = !storygraphInvolved;
}

async function dispatch(sites) {
  const query = normalizeQuery(queryInput.value);
  if (!query) return;

  const mode = currentMode();
  await savePrefs({ mode, lastQuery: query });
  await chrome.runtime.sendMessage({ type: 'search', query, mode, sites });
  window.close();
}

function buildSiteButtons() {
  for (const adapter of ADAPTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = adapter.label;
    button.title = `Search ${adapter.label} only`;
    button.addEventListener('click', () => dispatch([adapter.id]));
    sitesRow.append(button);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  dispatch(enabledSites);
});

queryInput.addEventListener('input', refreshEnabledState);

async function init() {
  buildSiteButtons();

  const prefs = await loadPrefs();
  enabledSites = prefs.sites;
  form.elements.mode.value = prefs.mode;
  queryInput.value = prefs.lastQuery;
  queryInput.select();

  refreshEnabledState();
}

init();
```

- [ ] **Step 4: Load the extension into Chrome for the first time**

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Choose `/Users/lizziesiegle/Desktop/demos-2-idk/library-goodreads-storygraph-chromeextension`

Expected: "Book Lookup 1.0.0" appears with no errors. If Chrome shows a red **Errors** button, open it — a missing file or malformed manifest is the usual cause.

Note: the extension has no icon files, so Chrome shows a default lettered tile in the toolbar. That is cosmetic. To fix it, drop 16/48/128px PNGs into `icons/` and add an `"icons"` block to the manifest.

- [ ] **Step 5: Verify the popup renders and dispatches**

1. Pin the extension, click its icon.
2. The popup should render with the search box focused and **Search all** disabled.
3. Type `Tomorrow, and Tomorrow, and Tomorrow` — **Search all** becomes enabled.
4. Press Enter.

Expected: three tabs open. SFPL is focused and shows results for that title. Goodreads and StoryGraph are loaded in the background at their own results pages (or their login pages, if signed out).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 127 tests.

- [ ] **Step 7: Commit**

```bash
git add src/popup/
git commit -m "feat: add popup with search box, mode toggle and per-site buttons"
```

---

### Task 10: Options page

**Files:**
- Create: `src/options/options.html`, `src/options/options.js`

**Interfaces:**
- Consumes: `ADAPTERS` from `src/sites/index.js`; `loadPrefs`, `savePrefs` from `src/lib/prefs.js`. Reuses `src/popup/popup.css`.
- Produces: no exports.

No credential fields. The page explains the password-manager approach and offers a shortcut to Chrome's password settings.

`chrome://` URLs cannot be opened with an `<a href>` from an extension page — Chrome blocks the navigation. Use `chrome.tabs.create`, which is permitted.

- [ ] **Step 1: Create `src/options/options.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="../popup/popup.css" />
    <link rel="stylesheet" href="options.css" />
    <title>Book Lookup — Settings</title>
  </head>
  <body>
    <h1>Book Lookup settings</h1>

    <section>
      <h2>Passwords</h2>
      <p class="note">
        Book Lookup never sees or stores your passwords. Save your SFPL, Goodreads and
        StoryGraph logins in Chrome's own password manager, and this extension will open the
        login page and focus the username field so Chrome's autofill suggestion is one click
        away.
      </p>
      <p class="note">
        Chrome deliberately blocks extensions from filling password fields without a real
        click. That is anti-phishing protection working as intended, so a fully automatic
        login is not possible — by design, not by omission.
      </p>
      <button type="button" id="open-passwords" class="primary">
        Open Chrome's password manager
      </button>
    </section>

    <section>
      <h2>Default search mode</h2>
      <div class="modes" role="radiogroup" aria-label="Default search mode">
        <label><input type="radio" name="mode" value="title" checked /><span>Title</span></label>
        <label><input type="radio" name="mode" value="author" /><span>Author</span></label>
      </div>
    </section>

    <section>
      <h2>Sites included in “Search all”</h2>
      <div id="sites"></div>
      <p class="note">
        Individual site buttons in the popup always work, whether or not a site is included
        here.
      </p>
    </section>

    <p class="status" id="status" role="status" aria-live="polite"></p>

    <script type="module" src="options.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/options/options.css`**

```css
body {
  width: auto;
  max-width: 560px;
  padding: 28px;
}

h1 {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
  color: var(--ink);
  margin-bottom: 4px;
}

h2 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

section {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--rule);
}

section .note {
  margin: 0 0 10px;
  padding-top: 0;
  border-top: none;
  font-size: 13px;
}

.primary { width: auto; padding: 9px 16px; }

.site-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 14px;
}

.status {
  min-height: 18px;
  margin-top: 18px;
  font-size: 13px;
  color: var(--accent);
}
```

- [ ] **Step 3: Create `src/options/options.js`**

```js
import { ADAPTERS } from '../sites/index.js';
import { loadPrefs, savePrefs } from '../lib/prefs.js';

const sitesBox = document.getElementById('sites');
const status = document.getElementById('status');
const modeRadios = document.querySelectorAll('input[name="mode"]');

let statusTimer = null;

function flash(message) {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 1600);
}

function selectedSites() {
  return [...sitesBox.querySelectorAll('input:checked')].map((input) => input.value);
}

async function persistSites() {
  const sites = selectedSites();
  if (!sites.length) {
    flash('Search all needs at least one site.');
    // Re-check the box the user just cleared rather than storing an empty list.
    const prefs = await loadPrefs();
    renderSites(prefs.sites);
    return;
  }
  await savePrefs({ sites });
  flash('Saved.');
}

function renderSites(enabled) {
  sitesBox.replaceChildren();
  for (const adapter of ADAPTERS) {
    const row = document.createElement('label');
    row.className = 'site-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = adapter.id;
    checkbox.checked = enabled.includes(adapter.id);
    checkbox.addEventListener('change', persistSites);

    const name = document.createElement('span');
    name.textContent = adapter.label;

    row.append(checkbox, name);
    sitesBox.append(row);
  }
}

document.getElementById('open-passwords').addEventListener('click', () => {
  // An <a href="chrome://…"> is blocked from extension pages; tabs.create is not.
  chrome.tabs.create({ url: 'chrome://settings/passwords' });
});

for (const radio of modeRadios) {
  radio.addEventListener('change', async (event) => {
    await savePrefs({ mode: event.target.value === 'author' ? 'author' : 'title' });
    flash('Saved.');
  });
}

async function init() {
  const prefs = await loadPrefs();
  renderSites(prefs.sites);
  for (const radio of modeRadios) {
    radio.checked = radio.value === prefs.mode;
  }
}

init();
```

- [ ] **Step 4: Verify the options page in Chrome**

1. Reload the extension at `chrome://extensions`.
2. Click **Details** → **Extension options**.
3. Toggle the default mode to Author — "Saved." appears.
4. Uncheck StoryGraph — "Saved." appears. Open the popup: the StoryGraph note is gone, and Search all now opens two tabs.
5. Uncheck all three — the message "Search all needs at least one site." appears and the boxes reset.
6. Click **Open Chrome's password manager** — `chrome://settings/passwords` opens in a new tab.
7. Re-check all three sites before moving on.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 127 tests.

- [ ] **Step 6: Commit**

```bash
git add src/options/
git commit -m "feat: add options page for search defaults and site selection"
```

---

### Task 11: Real fixtures, manual smoke test, and README

**Files:**
- Create: `README.md`
- Modify: `test/fixtures/*.html` (replace handwritten fixtures with real captures)
- Modify: `test/sites-detect.test.js` if a real capture disproves a selector

This task closes the one gap the spec named: `authed` detection was never verified against a real page. Until Step 3 passes against real captures, `authed` detection — and therefore post-login resume — is unverified, and must be described that way.

- [ ] **Step 1: Capture the six real pages**

This step needs the human, since it requires logged-in sessions.

While signed in to each site, for each URL below: open DevTools → **Elements**, right-click the `<html>` element → **Copy** → **Copy outerHTML**, then save into `test/fixtures/` under the given filename.

| URL to visit | Save as |
|---|---|
| `https://sfpl.bibliocommons.com/v2/search?query=Dune&searchType=title` (signed in) | `real-sfpl-authed-results.html` |
| `https://sfpl.bibliocommons.com/user/login` (signed out) | `real-sfpl-login.html` |
| `https://www.goodreads.com/search?q=Dune&search%5Bfield%5D=title` (signed in) | `real-goodreads-authed-results.html` |
| `https://www.goodreads.com/user/sign_in` (signed out) | `real-goodreads-login.html` |
| `https://app.thestorygraph.com/browse?search_term=Dune` (signed in) | `real-storygraph-authed-results.html` |
| `https://app.thestorygraph.com/users/sign_in` (signed out) | `real-storygraph-login.html` |

A private window is the simplest way to capture the signed-out pages.

- [ ] **Step 2: Add tests over the real captures**

Append to `test/sites-detect.test.js`:

```js
import { existsSync } from 'node:fs';

function fixturePath(name) {
  return fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url));
}

const REAL_CASES = [
  ['real-sfpl-authed-results', sfpl, SFPL_SEARCH, 'results'],
  ['real-sfpl-login', sfpl, 'https://sfpl.bibliocommons.com/user/login', 'login'],
  ['real-goodreads-authed-results', goodreads, GR_SEARCH, 'results'],
  ['real-goodreads-login', goodreads, 'https://www.goodreads.com/user/sign_in', 'login'],
  ['real-storygraph-authed-results', storygraph, SG_BROWSE, 'results'],
  ['real-storygraph-login', storygraph, 'https://app.thestorygraph.com/users/sign_in', 'login'],
];

describe('real captured pages', () => {
  for (const [name, adapter, url, expected] of REAL_CASES) {
    const run = existsSync(fixturePath(name)) ? it : it.skip;
    run(`${name} classifies as ${expected}`, () => {
      expect(adapter.detect(fixture(name), url)).toBe(expected);
    });
  }

  it('recognizes the signed-in state on every real results capture', () => {
    for (const [name, adapter] of REAL_CASES.filter(([n]) => n.includes('authed'))) {
      if (!existsSync(fixturePath(name))) continue;
      // Same document, a non-results url: the sign-out marker alone must carry it.
      expect(adapter.detect(fixture(name), `https://${adapter.hostMatch}/`)).toBe('authed');
    }
  });
});
```

These tests skip themselves when a capture is missing, so the suite stays green before Step 1 is done and tightens automatically once the files land.

- [ ] **Step 3: Run the suite and fix any adapter the real pages disprove**

Run: `npm test`

Expected: PASS. If a real capture classifies wrongly:

- A signed-in page classified `unknown` instead of `authed` means the sign-out marker is missing. Inspect the capture for the real signed-in marker and add its selector to `AUTHED_SELECTORS` in `src/lib/detect-helpers.js`.
- A login page classified `unknown` means no usable password input was found — check for a hidden or dynamically-inserted field.
- A results page classified `login` means the site renders a login form on the results page itself. If so, the classification order needs `results` to outrank `login` for that adapter; make that change in the adapter's own `detect`, not in the shared `classify`.

**The real capture is ground truth. Fix the implementation, never the capture.**

- [ ] **Step 4: Run the end-to-end smoke test**

With the extension loaded and reloaded at `chrome://extensions`:

1. **Happy path, signed in.** Signed in to all three sites, search `Tomorrow, and Tomorrow, and Tomorrow` in title mode via Search all. Expected: three tabs, SFPL focused, all three showing results. No badges.
2. **Author mode.** Search `Gabrielle Zevin` in author mode. Expected: SFPL and Goodreads scoped to author; StoryGraph shows mixed results, matching its note.
3. **Single site.** Click just the Goodreads button. Expected: one tab, focused.
4. **Logged-out login focus.** Sign out of StoryGraph, then Search all. Expected: the StoryGraph tab lands on its sign-in page with the email field focused and Chrome's autofill dropdown available; the badge shows 🔑 on that tab.
5. **Resume after login.** Complete that login. Expected: the tab navigates itself, once, to the StoryGraph browse results for the query. The badge clears.
6. **No second resume.** Navigate that tab to StoryGraph's home page manually. Expected: nothing happens. No navigation.
7. **Expiry.** Open a search, leave the login page sitting for over ten minutes, then log in. Expected: no resume. The intent expired.
8. **Off-domain clearing.** Start a search, then navigate that tab to `example.com`. Expected: the badge clears.
9. **Empty query.** Open the popup with the box empty. Expected: every button disabled.
10. **Service worker console.** At `chrome://extensions` → **service worker**, confirm no errors were logged during any of the above.

Record the result of each numbered check. Any failure is a bug to fix before this task is complete — not a note to file.

- [ ] **Step 5: Write `README.md`**

```markdown
# Book Lookup

A personal Chrome extension. Type a book title or author once, and open SFPL,
Goodreads and The StoryGraph search results in one click.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder

## Passwords

This extension never sees, stores, fills or transmits a password.

Save your logins in Chrome's own password manager (Settings → Passwords). When
a login page appears, the extension focuses the username field so Chrome's
autofill suggestion is one click away — that is the entire extent of its
involvement in logging in.

Chrome deliberately blocks extensions from filling password fields without a
genuine user click. That is anti-phishing protection working correctly, so
zero-click login is not achievable and is not attempted here.

The content script has exactly two side effects available to it: `focus()` on a
username field, and sending a message to the background worker. It never reads
a field's contents and never navigates. `test/security-invariants.test.js`
fails the build if that stops being true.

## Permissions

`storage`, plus host access to exactly three origins: `sfpl.bibliocommons.com`,
`www.goodreads.com`, `app.thestorygraph.com`.

## Badges

| Badge | Meaning |
|---|---|
| 🔑 | A login form is showing; the username field has been focused for you. |
| `!` | The site is showing a CAPTCHA or 2FA challenge. Handle it manually. |
| `?` | The page wasn't recognized — probably a site redesign. Nothing was touched. |

## Tests

```bash
npm install
npm test
```

Tested: URL construction for all three sites, page classification against saved
HTML, the pending-intent state machine, and the security invariants above. The
Chrome API shells (`background.js`, the popup, the options page) are verified by
the manual smoke test in `docs/superpowers/plans/`.

## Known fragility

This drives three real websites' HTML. Any of them can redesign and break the
login-focus and resume features without warning; the classification then falls
back to `unknown`, the extension does nothing, and it degrades to a bookmark
rather than breaking the page.

Not built for distribution. Site Terms of Service are a real consideration for
any use beyond personal.

## Not included

Auto-shelving ("Add to shelf" / a named StoryGraph list) was deliberately
deferred — it is the most breakage-prone possible feature and needs real page
inspection first. Also out of scope: other library systems, any Goodreads or
StoryGraph API, and CAPTCHA/2FA handling.
```

- [ ] **Step 6: Commit**

```bash
git add README.md test/fixtures/ test/sites-detect.test.js
git commit -m "test: verify page classification against real captures, add README"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: password boundary → Task 8 (enforced by test) and the Global Constraints; verified URL patterns → Tasks 1–2; adapters → Tasks 1–4; control flow and one-navigation guarantee → Tasks 5 and 7; permissions and module loading → Tasks 6 and 8; user flow → Tasks 9–10; error handling and badges → Tasks 5, 7, 8; testing and the fixture gap → Tasks 1–5, 8, 11; interface → Tasks 9–10; out-of-scope items → documented in the README in Task 11.

**Type consistency checked.** `detect(doc, url)` has the same signature in all three adapters and in `classify`. `decide()` returns the same four-key object in every branch, and every test asserts against that shape. `Intent` keys (`tabId`, `site`, `targetUrl`, `resumed`, `expiresAt`) are identical in `createIntent`, `decide`, and `background.js`. `BADGE` keys (`KEY`, `ALERT`, `QUESTION`) match the strings `decide()` returns. Adapter properties (`id`, `label`, `hostMatch`, `buildSearchUrl`, `detect`, `ignoresMode`) are consistent across Tasks 1, 2, 4, 9, and 10.

**Two deliberate departures from the spec**, both documented above with reasoning: `detect` returns five states rather than four, and `usernameSelector` is replaced by a generic resolver.

**Running test counts** (cumulative, to catch a silently skipped file): T1 → 13, T2 → 21, T3 → 46, T4 → 66, T5 → 82, T8 → 127. Tasks 6, 7, 9 and 10 add no automated tests and must leave the count at its previous value. These counts are bookkeeping, not requirements: if an actual count differs, recount the `it` blocks and correct this line — a mismatch is only a defect if a whole test file failed to run.
