// @vitest-environment-options {"url": "https://sfpl.bibliocommons.com/"}
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Coverage for the N1 fix in src/content/runner.js: when the worker refuses
 * a report because the tab is busy (`busy: true` — see the `busyTabs` guard
 * in src/background.js), the report used to be dropped for good. runner.js
 * now retries exactly once, after a short delay, and that retry must not be
 * chainable into a loop, nor combine with the existing one-shot `unknown`
 * recheck into more than two extra reports total.
 *
 * Each test loads a fresh copy of runner.js (`vi.resetModules()` + dynamic
 * import) because the module keeps load-scoped state (`filledThisLoad`,
 * `busyRetryScheduled`) that must not leak between tests, exactly like a
 * real navigation resets it.
 */

async function loadRunner() {
  vi.resetModules();
  return import('../src/content/runner.js');
}

function setPage(html) {
  document.body.innerHTML = html;
}

function goTo(path) {
  history.pushState({}, '', path);
}

const LOGIN_FORM = `
  <form id="login-form" action="/user/login" method="post">
    <input type="text" name="username" id="username" />
    <input type="password" name="password" id="password" />
    <button type="submit">Log in</button>
  </form>
`;

beforeEach(() => {
  setPage('');
  goTo('/');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flush() {
  // Lets pending microtasks (the awaited sendMessage promise chain inside
  // report()) settle before/after advancing fake timers.
  await Promise.resolve();
  await Promise.resolve();
}

describe('N1: busy-refusal retry', () => {
  it('re-reports exactly once on busy: true, and a reply that is busy again does not trigger a third report', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ focus: false, busy: true });
    globalThis.chrome = { runtime: { sendMessage } };

    // A plain results page: not 'unknown', so the separate unknown-recheck
    // path (RECHECK_DELAY_MS) never fires here — this isolates the busy
    // retry mechanism on its own.
    goTo('/v2/search?query=Dune&searchType=keyword');
    const { run } = await loadRunner();

    await run();
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // The retry's own reply is busy again. Bounded means this must NOT
    // schedule a third attempt.
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('the retry recovers a dropped autofill hand-out', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ focus: false, busy: true })
      .mockResolvedValueOnce({ focus: false, autofill: { username: 'card-1', secret: '1234' } });
    globalThis.chrome = { runtime: { sendMessage } };

    setPage(LOGIN_FORM);
    goTo('/user/login');
    const { run } = await loadRunner();

    await run();
    await flush();
    expect(document.getElementById('username').value).toBe('');

    await vi.advanceTimersByTimeAsync(300);
    await flush();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(document.getElementById('username').value).toBe('card-1');
    expect(document.getElementById('password').value).toBe('1234');
  });
});

describe('N1: the busy retry and the unknown recheck together', () => {
  it('cannot produce more than two extra reports even when every reply is busy', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ focus: false, busy: true });
    globalThis.chrome = { runtime: { sendMessage } };

    // No password field, no results-path match, no authed marker: classifies
    // as 'unknown', which is what arms the separate recheck path.
    setPage('<div>still loading</div>');
    goTo('/');
    const { run } = await loadRunner();

    await run();
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // 300ms: the busy retry from the initial report fires (extra #1).
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // 1500ms total: the unknown-state recheck fires (extra #2). Its reply is
    // ALSO busy, but a retry is already used up for this page load, so it
    // must not schedule a third extra report.
    await vi.advanceTimersByTimeAsync(1200);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(3);

    // Nothing further, ever, for the rest of this page load.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });
});
