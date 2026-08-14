import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sfpl } from '../src/sites/sfpl.js';
import { goodreads } from '../src/sites/goodreads.js';
import { storygraph } from '../src/sites/storygraph.js';
import { ADAPTERS, ADAPTER_IDS, getAdapter, adapterForUrl } from '../src/sites/index.js';

// NOTE: the brief's original helper built the path with
// `new URL(`./fixtures/${name}.html`, import.meta.url)`. Under this project's
// actual vitest 4 / jsdom setup, Vite's import-analysis plugin statically
// rewrites that exact `new URL(..., import.meta.url)` call shape — even with
// a template-literal argument — into a dev-server asset URL, which mangles
// the dynamic `${name}` segment and breaks file resolution. Building the path
// with `node:path` instead sidesteps that transform while resolving to the
// identical file. See the task report for verification details.
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name) {
  const filePath = path.join(FIXTURES_DIR, `${name}.html`);
  return new DOMParser().parseFromString(readFileSync(filePath, 'utf8'), 'text/html');
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

describe('a results path must be the path, not merely its prefix', () => {
  const NEAR_MISSES = [
    [sfpl, 'https://sfpl.bibliocommons.com/v2/searchers/foo'],
    [goodreads, 'https://www.goodreads.com/searchers/foo'],
    [goodreads, 'https://www.goodreads.com/book/showcase/foo'],
    [storygraph, 'https://app.thestorygraph.com/browsers/foo'],
    [storygraph, 'https://app.thestorygraph.com/bookshelves/foo'],
  ];

  it.each(NEAR_MISSES)('does not classify %o at %s as results', (adapter, url) => {
    const doc = new DOMParser().parseFromString('<main><h1>Something else</h1></main>', 'text/html');
    expect(adapter.detect(doc, url)).toBe('unknown');
  });

  it('still classifies the real results paths and their descendants', () => {
    const doc = new DOMParser().parseFromString('<main><h1>Results</h1></main>', 'text/html');
    expect(sfpl.detect(doc, SFPL_SEARCH)).toBe('results');
    expect(goodreads.detect(doc, GR_SEARCH)).toBe('results');
    expect(goodreads.detect(doc, 'https://www.goodreads.com/book/show/12345-dune')).toBe('results');
    expect(storygraph.detect(doc, SG_BROWSE)).toBe('results');
    expect(storygraph.detect(doc, 'https://app.thestorygraph.com/books/abc-123')).toBe('results');
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
