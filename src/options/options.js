import { ADAPTERS } from '../sites/index.js';
import { loadPrefs, savePrefs } from '../lib/prefs.js';

const sitesBox = document.getElementById('sites');
const status = document.getElementById('status');
const modeRadios = document.querySelectorAll('input[name="mode"]');

let statusTimer = null;

/**
 * Every write that reports a result takes a ticket. Storage calls are async,
 * so without this an earlier click's "Saved." can resolve after a later
 * click's refusal and overwrite it — telling the user the opposite of what
 * happened. A stale ticket means a newer click has superseded this one, so
 * it reports nothing and re-renders nothing.
 */
let statusSeq = 0;

function takeTicket() {
  statusSeq += 1;
  return statusSeq;
}

function isCurrent(ticket) {
  return ticket === statusSeq;
}

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
  const ticket = takeTicket();
  const sites = selectedSites();

  if (!sites.length) {
    // Re-check the box the user just cleared rather than storing an empty list.
    const prefs = await loadPrefs();
    if (!isCurrent(ticket)) return;
    renderSites(prefs.sites);
    flash('Search all needs at least one site.');
    return;
  }

  await savePrefs({ sites });
  if (!isCurrent(ticket)) return;
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
    // Shares the ticket counter with persistSites: a mode save resolving late
    // must not overwrite a site refusal message either.
    const ticket = takeTicket();
    await savePrefs({ mode: event.target.value === 'author' ? 'author' : 'title' });
    if (!isCurrent(ticket)) return;
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
