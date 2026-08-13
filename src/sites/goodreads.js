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
