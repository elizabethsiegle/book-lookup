import { normalizeQuery, normalizeMode } from '../lib/query.js';
import { classify } from '../lib/detect-helpers.js';

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

  detect(doc, url) {
    // Goodreads redirects an exact single match straight to the book page.
    // That is a successful landing, not an unrecognized page.
    return classify(
      doc,
      url,
      (pathname) => pathname.startsWith('/search') || pathname.startsWith('/book/show/')
    );
  },
};
