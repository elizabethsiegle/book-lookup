# Book Lookup

A personal Chrome extension. Type a book title or author once, and open SFPL,
Goodreads and The StoryGraph search results in one click.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder

## Passwords

By default, this extension never sees, stores, fills or transmits a password.
Save your logins in Chrome's own password manager (Settings → Passwords). When
a login page appears, the extension focuses the username field so Chrome's
autofill suggestion is one click away — that is the entire extent of its
involvement in logging in, unless you opt in to autofill below.

**Autofill is opt-in, per site, and off by default.** In Options, you may save
a username/card-number and PIN/password for SFPL, Goodreads and/or
StoryGraph. Doing so lets the extension fill and submit that site's login
form for you. A site with no saved credential is never autofilled.

**Saved credentials are stored in `chrome.storage.local`, in plaintext.**
Chrome extensions have no access to the operating system's keychain, so there
is no honest way to encrypt them at rest — a key shipped alongside its own
ciphertext protects nothing, and pretending otherwise would be worse than
saying so plainly. Anyone with access to this computer's user account, or to
a backup or sync of this Chrome profile, can read them. If you don't opt in,
none of this applies to you.

**Reading a value out of any field is banned everywhere, without exception —
including in the one file that performs autofill.** The extension may inject
a credential it already holds into a login form; it may never learn what the
user actually typed. That asymmetry (write allowed in exactly one file, read
banned in all of them) is the property that makes opting in defensible, and
`test/security-invariants.test.js` enforces both halves of it.

**Attempt limiting is a safety feature, not a nicety.** Library systems lock
a card after a small number of wrong PIN attempts. Autofill submits at most
once per page load, and after two consecutive failures for a site it disables
itself for that site — the badge reports it — until you re-save the
credential, which is treated as your assertion that it's correct now. Without
this, a stale or mistyped PIN would let the extension lock you out of your
own library card.

The content script's side effects, as written today, are: `focus()` on a
username field, sending a message to the background worker, and — in
`src/content/autofill.js` only — writing a stored credential into a login
form's fields and submitting it. No content-script file, including
`autofill.js`, ever reads a field's contents back. `autofill.js` is the one
exception to "none of them navigate": submitting the login form it just
filled does navigate the page, which is the entire point of the feature —
every other navigation primitive (`location.assign`, `location.href =`,
`window.open`, and so on) stays banned there too, same as everywhere else.
`test/security-invariants.test.js` greps the source for the obvious forms of
those violations (`.value` reads, `fetch(`, `location.href =`, and similar)
— including in `autofill.js` itself, for every check except the one
`submit()` pattern it exists to trigger — and fails the build if one of them
regresses in. It is a regression guard,
not a proof of safety: it is a grep over source text, not a sandboxed
capability check, so it catches accidental slips but not deliberate
circumvention. Bracket-notation access (`el['value']`), destructuring
(`const {value} = el`), reading through
`Object.getOwnPropertyDescriptor(...).get.call(el)`, and other disguised
forms of the same patterns all pass it untouched — this was verified
directly by injecting 23 such constructs into the content script and
watching all 23 pass. Treat the test as catching carelessness, not as a
security boundary.

## Permissions

`storage`, plus host access to exactly three origins: `sfpl.bibliocommons.com`,
`www.goodreads.com`, `app.thestorygraph.com`.

## Badges

| Badge | Meaning |
|---|---|
| 🔑 | A login form is showing; the username field has been focused for you. |
| `!` | The site is showing a CAPTCHA or 2FA challenge. Handle it manually. |
| `?` | The page wasn't recognized — probably a site redesign. Nothing was touched. |
| 🔒 | Autofill stopped for this site after two consecutive failed attempts. Re-save the credential in Options to re-enable it. |

## Tests

```bash
npm install
npm test
```

Tested: URL construction for all three sites, page classification against saved
HTML, the pending-intent state machine, and the security invariants above.

**`src/background.js`'s autofill hand-out and attempt-cap counting is
covered** (`test/background.test.js`, driving the real module against a
stubbed `chrome` global), but nothing else in it is. Search dispatch, intent
persistence, badge calls outside the autofill path, and tab creation/update
are exercised only by the manual smoke test described below — there is no
unit or integration coverage of them.

**Known gap: `authed` detection is unverified against a real page.** The
signed-in fixtures in `test/fixtures/` (`sfpl-authed-dashboard.html`,
`goodreads-authed-search.html`, `storygraph-authed-browse.html`) are
handwritten approximations of what a signed-in page looks like, not real
captures — StoryGraph blocks automated fetching, and no logged-in page from
any of the three sites was ever reachable in this environment. `test/sites-detect.test.js`
has a `real captured pages` block that runs against `test/fixtures/real-*.html`
captures when present and skips itself when they're absent (see the file for
the exact fixture names and the capture instructions). Every one of those
tests is currently skipped, because none of those files exist yet. Until a
human signs in to each site, captures the six real pages, and drops them in,
`authed` classification — and therefore the post-login resume feature it
drives — has never been checked against a real page and should be treated as
unverified.

The Chrome API shells (`background.js`, the popup, the options page) have not
been exercised in a real browser either. No manual smoke test has been run;
none of the end-to-end flows (multi-tab search, login-focus, post-login
resume, badge behavior) have been confirmed working outside of unit tests
against static fixtures.

## Known fragility

This drives three real websites' HTML. Any of them can redesign and break the
login-focus and resume features without warning; the classification then falls
back to `unknown`, the extension does nothing, and it degrades to a bookmark
rather than breaking the page.

Not built for distribution. Site Terms of Service are a real consideration for
any use beyond personal.

## Not included

Auto-shelving ("Add to shelf" / a named StoryGraph list) was deliberately
deferred — it is the most breakage-prone possible feature and needs real page
inspection first. Also out of scope: other library systems, any Goodreads or
StoryGraph API, and CAPTCHA/2FA handling.
