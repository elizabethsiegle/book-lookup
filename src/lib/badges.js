/**
 * Chrome badge text is limited to roughly four characters, so these are
 * single glyphs. Keys are the strings `decide()` returns.
 */
export const BADGE = {
  KEY: { text: '🔑', color: '#B45309', title: 'Book Lookup — manual login needed' },
  ALERT: { text: '!', color: '#B91C1C', title: 'Book Lookup — the site is showing a challenge; handle it manually' },
  QUESTION: { text: '?', color: '#6B7280', title: "Book Lookup — couldn't recognize this page" },
};
