import { ADAPTERS } from '../sites/index.js';
import { loadPrefs, savePrefs } from '../lib/prefs.js';
import { normalizeQuery } from '../lib/query.js';

const form = document.getElementById('search-form');
const queryInput = document.getElementById('query');
const searchAll = document.getElementById('search-all');
const sitesRow = document.getElementById('sites');
const modeNote = document.getElementById('mode-note');
const dispatchError = document.getElementById('dispatch-error');

let enabledSites = ADAPTERS.map((adapter) => adapter.id);

function currentMode() {
  return form.elements.mode.value === 'author' ? 'author' : 'title';
}

function hasQuery() {
  return normalizeQuery(queryInput.value).length > 0;
}

function refreshEnabledState() {
  const ready = hasQuery();
  searchAll.disabled = !ready;
  for (const button of sitesRow.querySelectorAll('button')) {
    button.disabled = !ready;
  }

  const modeIgnoringSiteInvolved = ADAPTERS.some(
    (adapter) => adapter.ignoresMode && enabledSites.includes(adapter.id)
  );
  modeNote.hidden = !modeIgnoringSiteInvolved;
}

async function dispatch(sites) {
  const query = normalizeQuery(queryInput.value);
  if (!query) return;

  const mode = currentMode();
  // Saved before the send, deliberately: if the dispatch fails, the query the
  // user typed is still worth remembering for the retry.
  await savePrefs({ mode, lastQuery: query });

  try {
    await chrome.runtime.sendMessage({ type: 'search', query, mode, sites });
  } catch {
    // The service worker can be asleep, or the extension freshly reloaded
    // during development. Say so and leave the popup open — closing on a
    // silent failure looks identical to success and loses the query.
    dispatchError.textContent = "Couldn't reach the extension. Try again.";
    dispatchError.hidden = false;
    return;
  }

  window.close();
}

function buildSiteButtons() {
  for (const adapter of ADAPTERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = adapter.label;
    button.title = `Search ${adapter.label} only`;
    button.addEventListener('click', () => dispatch([adapter.id]));
    sitesRow.append(button);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  dispatch(enabledSites);
});

queryInput.addEventListener('input', () => {
  dispatchError.hidden = true;
  refreshEnabledState();
});

async function init() {
  buildSiteButtons();

  const prefs = await loadPrefs();
  enabledSites = prefs.sites;
  form.elements.mode.value = prefs.mode;
  queryInput.value = prefs.lastQuery;
  queryInput.select();

  refreshEnabledState();
}

init();
