import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fillAndSubmit } from '../src/content/autofill.js';

// Paths built with node:path rather than `new URL(..., import.meta.url)` —
// see test/security-invariants.test.js for why (Vite's import-analysis
// plugin mangles the latter's dynamic segment even with a template literal).
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function setForm(html) {
  document.body.innerHTML = html;
}

const LOGIN_FORM = `
  <form id="login-form" action="/user/login" method="post">
    <input type="text" name="username" id="username" />
    <input type="password" name="password" id="password" />
    <button type="submit">Log in</button>
  </form>
`;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('fillAndSubmit', () => {
  it('fills both fields and submits, returning true', () => {
    setForm(LOGIN_FORM);
    const form = document.getElementById('login-form');
    let submitted = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitted = true;
    });

    const result = fillAndSubmit(document, { username: 'card123', secret: '4321' });

    expect(result).toBe(true);
    expect(submitted).toBe(true);
    expect(document.getElementById('username').value).toBe('card123');
    expect(document.getElementById('password').value).toBe('4321');
  });

  it('returns false and writes nothing when there is no password field', () => {
    setForm(`
      <form id="f">
        <input type="text" id="username" />
        <button type="submit">Go</button>
      </form>
    `);

    const result = fillAndSubmit(document, { username: 'card123', secret: '4321' });

    expect(result).toBe(false);
    expect(document.getElementById('username').value).toBe('');
  });

  it('returns false and writes nothing when there is no username field', () => {
    setForm(`
      <form id="f">
        <input type="password" id="password" />
        <button type="submit">Go</button>
      </form>
    `);

    const result = fillAndSubmit(document, { username: 'card123', secret: '4321' });

    expect(result).toBe(false);
    expect(document.getElementById('password').value).toBe('');
  });

  it('dispatches input and change events on both fields', () => {
    setForm(LOGIN_FORM);
    const form = document.getElementById('login-form');
    form.addEventListener('submit', (e) => e.preventDefault());

    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const usernameEvents = [];
    const passwordEvents = [];
    username.addEventListener('input', () => usernameEvents.push('input'));
    username.addEventListener('change', () => usernameEvents.push('change'));
    password.addEventListener('input', () => passwordEvents.push('input'));
    password.addEventListener('change', () => passwordEvents.push('change'));

    fillAndSubmit(document, { username: 'card123', secret: '4321' });

    expect(usernameEvents).toEqual(['input', 'change']);
    expect(passwordEvents).toEqual(['input', 'change']);
  });

  it('prefers clicking the submit control over form.requestSubmit()', () => {
    setForm(LOGIN_FORM);
    const form = document.getElementById('login-form');
    form.addEventListener('submit', (e) => e.preventDefault());
    const button = form.querySelector('[type="submit"]');
    const clickSpy = vi.fn();
    button.addEventListener('click', clickSpy);
    const requestSubmitSpy = vi.spyOn(form, 'requestSubmit');

    const result = fillAndSubmit(document, { username: 'card123', secret: '4321' });

    expect(result).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(requestSubmitSpy).not.toHaveBeenCalled();
  });

  it('falls back to form.requestSubmit() when there is no submit control', () => {
    setForm(`
      <form id="f">
        <input type="text" id="username" />
        <input type="password" id="password" />
      </form>
    `);
    const form = document.getElementById('f');
    form.addEventListener('submit', (e) => e.preventDefault());
    const requestSubmitSpy = vi.spyOn(form, 'requestSubmit');

    const result = fillAndSubmit(document, { username: 'card123', secret: '4321' });

    expect(result).toBe(true);
    expect(requestSubmitSpy).toHaveBeenCalledTimes(1);
  });

  it('returns false when the fields are not inside a form at all', () => {
    setForm(`
      <input type="text" id="username" />
      <input type="password" id="password" />
    `);

    const result = fillAndSubmit(document, { username: 'card123', secret: '4321' });

    expect(result).toBe(false);
  });
});

describe('source: src/content/autofill.js writes .value but never reads it', () => {
  function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  function normalizeSpacing(text) {
    return text.replace(/\s*\.\s*/g, '.').replace(/\s*\(/g, '(');
  }

  // A `.value` occurrence is a write only when immediately followed by a
  // single `=` that is not part of `==` or `===` — anything else (bare
  // `.value`, `.value ==`, `.value ===`) is a read.
  function classifyValueOccurrences(code) {
    const occurrences = [];
    const regex = /\.value\b/g;
    let match;
    while ((match = regex.exec(code))) {
      const after = code.slice(match.index + match[0].length);
      const isAssignment = /^\s*=(?!=)/.test(after);
      occurrences.push({ index: match.index, isAssignment });
    }
    return occurrences;
  }

  function loadedCode() {
    const raw = readFileSync(path.join(PROJECT_ROOT, 'src/content/autofill.js'), 'utf8');
    return normalizeSpacing(stripComments(raw));
  }

  it('the detector itself would catch a genuine read', () => {
    const sample = normalizeSpacing('const v = el.value;\nif (el.value === "x") {}');
    const occurrences = classifyValueOccurrences(sample);
    expect(occurrences.length).toBeGreaterThan(0);
    expect(occurrences.every((o) => o.isAssignment)).toBe(false);
  });

  it('the detector accepts a genuine write, including `==`/`===` nearby', () => {
    const sample = normalizeSpacing('el.value = x;\nif (a === b) {}\nif (c == d) {}');
    const occurrences = classifyValueOccurrences(sample);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].isAssignment).toBe(true);
  });

  it('has at least one `.value` write (the feature actually does something)', () => {
    const occurrences = classifyValueOccurrences(loadedCode());
    expect(occurrences.length).toBeGreaterThan(0);
  });

  it('contains no `.value` read — every occurrence is an assignment', () => {
    const occurrences = classifyValueOccurrences(loadedCode());
    const reads = occurrences.filter((o) => !o.isAssignment);
    expect(reads).toEqual([]);
  });
});
