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
