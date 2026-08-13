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
