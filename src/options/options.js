import { ADAPTERS } from '../sites/index.js';
import { loadPrefs, savePrefs } from '../lib/prefs.js';
import {
  loadCredential,
  saveCredential,
  clearCredential,
  loadFailures,
  isBlank,
} from '../lib/credentials.js';
import { isDisabled } from '../lib/autofill-policy.js';

const sitesBox = document.getElementById('sites');
const credentialsBox = document.getElementById('credentials');
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

/**
 * Builds one site's credential block: a username field, a password field,
 * Save/Clear buttons, and text reporting whether a credential is currently
 * stored and whether autofill is disabled for this site.
 *
 * The password field is populated ONLY by what the owner types here, never
 * from storage — loadCredential's result feeds the status text, never
 * `secretInput.value`. Reading a stored secret back into the DOM would put
 * it somewhere a page-level bug could reach it, for no benefit: the owner
 * already knows what they typed.
 */
function buildCredentialRow(adapter, initialStored, initialDisabled) {
  const wrap = document.createElement('div');
  wrap.className = 'cred-row';
  wrap.dataset.site = adapter.id;

  const heading = document.createElement('h3');
  heading.textContent = adapter.label;

  const statusEl = document.createElement('p');
  statusEl.className = 'cred-status';
  statusEl.id = `cred-status-${adapter.id}`;

  const disabledEl = document.createElement('p');
  disabledEl.className = 'cred-disabled-note';
  disabledEl.id = `cred-disabled-${adapter.id}`;
  disabledEl.textContent =
    'Autofill is currently disabled for this site after repeated failed attempts. ' +
    'Saving a credential again re-enables it.';

  function setState(stored, disabled) {
    statusEl.textContent = stored ? 'Stored' : 'Not stored';
    disabledEl.hidden = !disabled;
  }
  setState(initialStored, initialDisabled);

  const usernameLabel = document.createElement('label');
  usernameLabel.className = 'cred-field';
  usernameLabel.textContent = 'Username / card number';
  const usernameInput = document.createElement('input');
  usernameInput.type = 'text';
  usernameInput.autocomplete = 'off';
  usernameInput.id = `cred-username-${adapter.id}`;
  usernameLabel.append(usernameInput);

  const secretLabel = document.createElement('label');
  secretLabel.className = 'cred-field';
  secretLabel.textContent = 'PIN / password';
  const secretInput = document.createElement('input');
  secretInput.type = 'password';
  secretInput.autocomplete = 'off';
  secretInput.id = `cred-secret-${adapter.id}`;
  secretLabel.append(secretInput);

  const actions = document.createElement('div');
  actions.className = 'cred-actions';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.id = `cred-save-${adapter.id}`;
  saveButton.textContent = 'Save';

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.id = `cred-clear-${adapter.id}`;
  clearButton.textContent = 'Clear';

  actions.append(saveButton, clearButton);

  saveButton.addEventListener('click', async () => {
    const ticket = takeTicket();
    const username = usernameInput.value;
    const secret = secretInput.value;

    if (isBlank(username) || isBlank(secret)) {
      // saveCredential always resets the failure count. Writing a blank or
      // half-blank credential would silently re-enable a site that tripped
      // the attempt cap without the owner ever entering a real credential —
      // refuse before anything reaches storage, and leave both the stored
      // credential and the failure count untouched.
      flash('Both the username/card number and PIN/password are required.');
      return;
    }

    await saveCredential(adapter.id, { username, secret });
    // Wipe what was just typed rather than leaving the plaintext PIN sitting
    // in the DOM once storage has its own copy.
    usernameInput.value = '';
    secretInput.value = '';
    if (!isCurrent(ticket)) return;

    const stored = await loadCredential(adapter.id);
    if (!isCurrent(ticket)) return;
    // saveCredential always resets the failure count, so this site can never
    // read as disabled immediately after a save.
    setState(stored !== null, false);
    flash(`Saved the ${adapter.label} credential.`);
  });

  clearButton.addEventListener('click', async () => {
    const ticket = takeTicket();

    await clearCredential(adapter.id);
    usernameInput.value = '';
    secretInput.value = '';
    if (!isCurrent(ticket)) return;

    const failures = await loadFailures(adapter.id);
    if (!isCurrent(ticket)) return;
    // clearCredential does not touch the failure count, so a site that was
    // disabled stays disabled until the credential is re-saved.
    setState(false, isDisabled(failures));
    flash(`Cleared the ${adapter.label} credential.`);
  });

  wrap.append(heading, statusEl, disabledEl, usernameLabel, secretLabel, actions);
  return wrap;
}

async function renderCredentials() {
  credentialsBox.replaceChildren();
  for (const adapter of ADAPTERS) {
    const [credential, failures] = await Promise.all([
      loadCredential(adapter.id),
      loadFailures(adapter.id),
    ]);
    credentialsBox.append(buildCredentialRow(adapter, credential !== null, isDisabled(failures)));
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
  await renderCredentials();
}

init();
