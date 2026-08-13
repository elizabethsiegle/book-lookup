import { describe, it, expect } from 'vitest';
import { normalizeQuery, normalizeMode } from '../src/lib/query.js';

describe('normalizeQuery', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeQuery('  Gabrielle Zevin  ')).toBe('Gabrielle Zevin');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeQuery('Tomorrow,   and\tTomorrow')).toBe('Tomorrow, and Tomorrow');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeQuery('   \t\n ')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(normalizeQuery(undefined)).toBe('');
    expect(normalizeQuery(null)).toBe('');
    expect(normalizeQuery(42)).toBe('');
  });

  it('preserves punctuation, apostrophes and accents', () => {
    expect(normalizeQuery("Ender's Game")).toBe("Ender's Game");
    expect(normalizeQuery('Gabrielle Zevín')).toBe('Gabrielle Zevín');
  });
});

describe('normalizeMode', () => {
  it('returns author only for exactly "author"', () => {
    expect(normalizeMode('author')).toBe('author');
  });

  it('defaults to title for anything else', () => {
    expect(normalizeMode('title')).toBe('title');
    expect(normalizeMode('AUTHOR')).toBe('title');
    expect(normalizeMode(undefined)).toBe('title');
    expect(normalizeMode('keyword')).toBe('title');
  });
});
