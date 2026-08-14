import { normalizeQuery, normalizeMode } from '../lib/query.js';
import { classify, isPathUnder } from '../lib/detect-helpers.js';

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

  detect(doc, url) {
    return classify(doc, url, (pathname) => isPathUnder(pathname, '/v2/search'));
  },
};
