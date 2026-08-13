import { describe, it, expect } from 'vitest';
import { sfpl } from '../src/sites/sfpl.js';
import { goodreads } from '../src/sites/goodreads.js';
import { storygraph } from '../src/sites/storygraph.js';

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
