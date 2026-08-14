import { ADAPTERS } from '../sites/index.js';
import { loadPrefs, savePrefs } from '../lib/prefs.js';

const sitesBox = document.getElementById('sites');
const status = document.getElementById('status');
const modeRadios = document.querySelectorAll('input[name="mode"]');

let statusTimer = null;

function flash(message) {
  status.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 1600);
}

function selectedSites() {
  return [...sitesBox.querySelectorAll('input:checked')].map((input) => input.value);
}

async function persistSites() {
  const sites = selectedSites();
  if (!sites.length) {
    flash('Search all needs at least one site.');
    // Re-check the box the user just cleared rather than storing an empty list.
    const prefs = await loadPrefs();
    renderSites(prefs.sites);
    return;
  }
  await savePrefs({ sites });
  flash('Saved.');
}

function renderSites(enabled) {
  sitesBox.replaceChildren();
  for (const adapter of ADAPTERS) {
    const row = document.createElement('label');
    row.className = 'site-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = adapter.id;
    checkbox.checked = enabled.includes(adapter.id);
    checkbox.addEventListener('change', persistSites);

    const name = document.createElement('span');
    name.textContent = adapter.label;

    row.append(checkbox, name);
    sitesBox.append(row);
  }
}

document.getElementById('open-passwords').addEventListener('click', () => {
  // An <a href="chrome://…"> is blocked from extension pages; tabs.create is not.
  chrome.tabs.create({ url: 'chrome://settings/passwords' });
});

for (const radio of modeRadios) {
  radio.addEventListener('change', async (event) => {
    await savePrefs({ mode: event.target.value === 'author' ? 'author' : 'title' });
    flash('Saved.');
  });
}

async function init() {
  const prefs = await loadPrefs();
  renderSites(prefs.sites);
  for (const radio of modeRadios) {
    radio.checked = radio.value === prefs.mode;
  }
}

init();
