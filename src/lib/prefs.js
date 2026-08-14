import { ADAPTER_IDS } from '../sites/index.js';

export const DEFAULT_PREFS = {
  mode: 'title',
  sites: [...ADAPTER_IDS],
  lastQuery: '',
};

export async function loadPrefs() {
  const stored = await chrome.storage.local.get(DEFAULT_PREFS);
  const sites = Array.isArray(stored.sites)
    ? stored.sites.filter((id) => ADAPTER_IDS.includes(id))
    : [];

  return {
    mode: stored.mode === 'author' ? 'author' : 'title',
    // Never let a corrupted or empty stored list leave the popup with no
    // sites to search.
    sites: sites.length ? sites : [...ADAPTER_IDS],
    lastQuery: typeof stored.lastQuery === 'string' ? stored.lastQuery : '',
  };
}

export async function savePrefs(partial) {
  await chrome.storage.local.set(partial);
}
