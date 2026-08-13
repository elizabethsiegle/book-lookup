/**
 * Pure query/mode normalization. No Chrome APIs, no DOM.
 */

export function normalizeQuery(input) {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/\s+/g, ' ');
}

export function normalizeMode(input) {
  return input === 'author' ? 'author' : 'title';
}
