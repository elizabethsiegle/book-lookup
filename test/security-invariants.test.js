import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * LIMITATION: this file is a grep over source text, not a sandboxed capability
 * check or a proof of safety. It catches the obvious, accidental forms of the
 * banned patterns and fails the build on a careless regression — that is all
 * it promises. Deliberate circumvention passes it untouched: bracket-notation
 * access (`el['value']`), destructuring (`const {value} = el`), reading
 * through `Object.getOwnPropertyDescriptor(...).get.call(el)`, and other
 * disguised equivalents of every pattern below. This was verified directly:
 * 23 such constructs were injected into runner.js and all 23 passed. Treat
 * green here as "no known-shape regression," never as "this file is safe."
 */

// Paths are built with node:path rather than `new URL(..., import.meta.url)`:
// Vite's import-analysis plugin statically rewrites that call shape, even with
// a template-literal argument, mangling the dynamic segment. Task 4 hit this
// and established this pattern; keep it consistent.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function source(relativePath) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

/**
 * Comments removed.
 *
 * These files document their own invariants, and that documentation naturally
 * quotes the very patterns being banned — `detect-helpers.js` says outright
 * that it may never read `.value`. Grepping raw source would fail on the
 * comment explaining the rule. Strip comments and the invariant tests what
 * actually runs.
 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Spacing normalized around member access and calls.
 *
 * Without this, every pattern below is defeated by reformatting alone:
 * `/\.value\b/` does not match `el . value`, and `/\bfetch\(/` does not match
 * `fetch (url)`. A guard that a stray space disarms is not a guard. Doing it
 * once here covers every pattern uniformly, including ones added later.
 */
export function normalizeSpacing(text) {
  return text.replace(/\s*\.\s*/g, '.').replace(/\s*\(/g, '(');
}

function code(relativePath) {
  return normalizeSpacing(stripComments(source(relativePath)));
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

/**
 * `src/content/autofill.js` is the one file permitted to WRITE `.value` — it
 * injects a credential the worker already holds into a login form. Reading
 * `.value` back stays banned there too: the extension may never learn what
 * the user typed. See docs/superpowers/specs/2026-08-12-book-lookup-extension-
 * design.md, "Credential handling".
 */
const WRITE_ALLOWED = ['src/content/autofill.js'];

/**
 * A `.value` READ is any `.value` occurrence not immediately followed by a
 * single `=` (an assignment target). `==` and `===` are comparisons — reads,
 * not writes — so they must NOT be mistaken for the assignment case; the
 * negative lookahead excludes both by rejecting when a `=` follows the first
 * `=` too.
 */
const VALUE_READ = /\.value\b(?!\s*=(?!=))/;

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
    const sample = normalizeSpacing('const v = input.value;\nfetch("/x");\nlocation.assign("/y");');
    expect(sample).toMatch(/\.value\b/);
    expect(sample).toMatch(/\bfetch\(/);
    expect(sample).toMatch(/location\.assign/);
  });

  it('cannot be defeated by whitespace around a dot or a paren', () => {
    // `el . value` and `fetch (x)` are valid JS and must not slip past.
    const sample = normalizeSpacing(
      'const v = el . value;\nfetch (url);\nlocation . href = "/y";\nwindow . open("/z");\nconsole . log(v);'
    );
    expect(sample).toMatch(/\.value\b/);
    expect(sample).toMatch(/\bfetch\(/);
    expect(sample).toMatch(/location\.href\s*=/);
    expect(sample).toMatch(/window\.open/);
    expect(sample).toMatch(/\bconsole\.(log|info|warn|debug)\(/);
  });

  it('normalizes spacing without destroying ordinary code', () => {
    expect(normalizeSpacing('foo(a, b)')).toBe('foo(a, b)');
    expect(normalizeSpacing('a.b.c')).toBe('a.b.c');
    expect(normalizeSpacing('doc\n  .querySelectorAll(sel)')).toBe('doc.querySelectorAll(sel)');
  });
});

describe('the content script never reads a field value', () => {
  it.each(IN_PAGE_FILES)('%s contains no .value access', (file) => {
    expect(code(file)).not.toMatch(/\.value\b/);
  });
});

/**
 * The bulk-read and exfiltration bans below run over IN_PAGE_FILES *and*
 * WRITE_ALLOWED (i.e. src/content/autofill.js). Until the 2026-08-18 review
 * (Finding 2), autofill.js was checked only by the `.value`-read rule and
 * the manifest-tracking rule below — it was exempt from every other ban,
 * even though it is the one file holding the credential in memory and the
 * least audited as a result. Injecting `fetch('/x')`, `console.log(secret)`,
 * or `new FormData(form)` into autofill.js used to leave this suite fully
 * green. `FILES_INCLUDING_AUTOFILL` closes that gap.
 */
const FILES_INCLUDING_AUTOFILL = [...IN_PAGE_FILES, ...WRITE_ALLOWED];

describe('no content-script file reads form data in bulk', () => {
  it.each(FILES_INCLUDING_AUTOFILL)('%s reads no form data in bulk', (file) => {
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

  it.each(WRITE_ALLOWED)(
    '%s performs no navigation other than the form submission it exists to make',
    (file) => {
      // autofill.js legitimately calls form.requestSubmit()/form.submit() —
      // that IS the feature, and it does navigate the page as a result. The
      // `submit()` pattern is therefore excluded here (and only here); every
      // other navigation primitive stays banned even in this file — there is
      // no legitimate reason for the one file allowed to submit a form to
      // also redirect the page some other way.
      const text = code(file);
      expect(text).not.toMatch(/location\.assign/);
      expect(text).not.toMatch(/location\.replace/);
      expect(text).not.toMatch(/location\.href\s*=/);
      expect(text).not.toMatch(/window\.open/);
    }
  );
});

describe('the content script never exfiltrates', () => {
  it.each(FILES_INCLUDING_AUTOFILL)('%s makes no network calls and logs nothing', (file) => {
    const text = code(file);
    expect(text).not.toMatch(/\bfetch\(/);
    expect(text).not.toMatch(/XMLHttpRequest/);
    expect(text).not.toMatch(/\bconsole\.(log|info|warn|debug)\(/);
  });
});

describe('the audited file list tracks the manifest', () => {
  const manifest = JSON.parse(source('manifest.json'));

  it('scans every file the manifest exposes to the page — add a WAR entry, add it here too', () => {
    const warResources = manifest.web_accessible_resources[0].resources;
    const audited = [...IN_PAGE_FILES, ...WRITE_ALLOWED];
    for (const file of warResources) {
      expect(
        audited,
        `${file} is in manifest.json's web_accessible_resources but missing from both ` +
          `IN_PAGE_FILES and WRITE_ALLOWED in test/security-invariants.test.js — it is ` +
          `reachable from page context and must be scanned by one of these invariant lists.`
      ).toContain(file);
    }
  });
});

describe('src/content/autofill.js may write .value but never read it', () => {
  it.each(WRITE_ALLOWED)('%s contains no .value read', (file) => {
    expect(code(file)).not.toMatch(VALUE_READ);
  });

  it.each(WRITE_ALLOWED)('%s still has substantial code after stripping', (file) => {
    expect(code(file).trim().length).toBeGreaterThan(50);
  });

  describe('positive controls: the read/write split is real, not inverted', () => {
    it('a plain assignment passes the write-allowed rule (it is a write, not a read)', () => {
      const sample = normalizeSpacing('x.value = 1;');
      expect(sample).not.toMatch(VALUE_READ);
    });

    it('a declaration reading .value fails the write-allowed rule', () => {
      const sample = normalizeSpacing("const v = x.value;");
      expect(sample).toMatch(VALUE_READ);
    });

    it('a strict-equality comparison reading .value fails the write-allowed rule', () => {
      // `===` must not be mistaken for the `=` assignment case.
      const sample = normalizeSpacing("if (x.value === 'a') {}");
      expect(sample).toMatch(VALUE_READ);
    });

    it('a loose-equality comparison reading .value fails the write-allowed rule', () => {
      // `==` must not be mistaken for the `=` assignment case either.
      const sample = normalizeSpacing('if (x.value == 1) {}');
      expect(sample).toMatch(VALUE_READ);
    });

    it('passing .value to a function call fails the write-allowed rule', () => {
      const sample = normalizeSpacing('foo(x.value);');
      expect(sample).toMatch(VALUE_READ);
    });
  });
});

describe('the newly-extended bans actually fire on autofill.js, not just on samples', () => {
  // Positive controls tied to the REAL file content, not a generic string —
  // proving the bulk-read, exfiltration, and navigation checks above would
  // genuinely catch a regression in src/content/autofill.js itself, the file
  // Finding 2 found exempt from all three.
  function withInjection(snippet) {
    return code('src/content/autofill.js') + snippet;
  }

  it('an injected fetch call would fail the exfiltration ban', () => {
    expect(withInjection('fetch("/x");')).toMatch(/\bfetch\(/);
  });

  it('an injected console.log would fail the exfiltration ban', () => {
    expect(withInjection('console.log(secret);')).toMatch(/\bconsole\.(log|info|warn|debug)\(/);
  });

  it('an injected XMLHttpRequest would fail the exfiltration ban', () => {
    expect(withInjection('new XMLHttpRequest();')).toMatch(/XMLHttpRequest/);
  });

  it('an injected FormData read would fail the bulk-read ban', () => {
    expect(withInjection('new FormData(form);')).toMatch(/\bFormData\b/);
  });

  it('an injected .elements read would fail the bulk-read ban', () => {
    expect(withInjection('form.elements;')).toMatch(/\.elements\b/);
  });

  it('an injected location.assign would fail the navigation ban', () => {
    expect(withInjection('location.assign("/y");')).toMatch(/location\.assign/);
  });

  it('an injected window.open would fail the navigation ban', () => {
    expect(withInjection('window.open("/y");')).toMatch(/window\.open/);
  });

  it('the real form.requestSubmit()/form.submit() calls do not themselves trip the navigation ban', () => {
    // Sanity check that excluding the `submit()` pattern for WRITE_ALLOWED is
    // actually load-bearing: the unmodified file really does contain calls
    // that shape, and the ban above passes it only because that one pattern
    // is deliberately excluded for this file and no other.
    const realCode = code('src/content/autofill.js');
    expect(realCode).toMatch(/\brequestSubmit\(\)/);
    expect(realCode).toMatch(/\bsubmit\(\)/);
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

  it('exposes to the page exactly the modules the content script imports, and no more', () => {
    // A wildcard here would also hand these sites prefs.js, intents.js and
    // badges.js, which nothing in the page-context import graph ever loads.
    expect(manifest.web_accessible_resources[0].resources).toEqual([
      'src/content/runner.js',
      'src/content/autofill.js',
      'src/sites/index.js',
      'src/sites/sfpl.js',
      'src/sites/goodreads.js',
      'src/sites/storygraph.js',
      'src/lib/query.js',
      'src/lib/detect-helpers.js',
    ]);
  });

  it('scopes web-accessible resources to the same three origins', () => {
    expect(manifest.web_accessible_resources[0].matches).toEqual(manifest.host_permissions);
  });
});
