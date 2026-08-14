import { sfpl } from './sfpl.js';
import { goodreads } from './goodreads.js';
import { storygraph } from './storygraph.js';

/**
 * Order matters: it is the popup's button order and the tab-focus preference
 * order. SFPL comes first because it is the site with a real time cost —
 * holds and waitlists are queue-based.
 */
export const ADAPTERS = [sfpl, goodreads, storygraph];
export const ADAPTER_IDS = ADAPTERS.map((adapter) => adapter.id);

export function getAdapter(id) {
  return ADAPTERS.find((adapter) => adapter.id === id) || null;
}

export function adapterForUrl(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  // Exact host equality — never a substring test, or `goodreads.com.evil.test`
  // would match.
  return ADAPTERS.find((adapter) => adapter.hostMatch === host) || null;
}
