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

describe('the audited file list tracks the manifest', () => {
  const manifest = JSON.parse(source('manifest.json'));

  it('scans every file the manifest exposes to the page — add a WAR entry, add it here too', () => {
    const warResources = manifest.web_accessible_resources[0].resources;
    for (const file of warResources) {
      expect(
        IN_PAGE_FILES,
        `${file} is in manifest.json's web_accessible_resources but missing from ` +
          `IN_PAGE_FILES in test/security-invariants.test.js — it is reachable from page ` +
          `context and must be scanned by these invariants.`
      ).toContain(file);
    }
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
