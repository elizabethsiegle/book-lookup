import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Paths are built with node:path rather than `new URL(..., import.meta.url)`:
// Vite's import-analysis plugin statically rewrites that call shape, even with
// a template-literal argument, mangling the dynamic segment. Task 4 hit this
// and established this pattern; keep it consistent.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function source(relativePath) {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
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
