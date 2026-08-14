# Book Lookup

A personal Chrome extension. Type a book title or author once, and open SFPL,
Goodreads and The StoryGraph search results in one click.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder

## Passwords

This extension never sees, stores, fills or transmits a password.

Save your logins in Chrome's own password manager (Settings → Passwords). When
a login page appears, the extension focuses the username field so Chrome's
autofill suggestion is one click away — that is the entire extent of its
involvement in logging in.

Chrome deliberately blocks extensions from filling password fields without a
genuine user click. That is anti-phishing protection working correctly, so
zero-click login is not achievable and is not attempted here.

The content script has exactly two side effects available to it: `focus()` on a
username field, and sending a message to the background worker. It never reads
a field's contents and never navigates. `test/security-invariants.test.js`
fails the build if that stops being true.

## Permissions

`storage`, plus host access to exactly three origins: `sfpl.bibliocommons.com`,
`www.goodreads.com`, `app.thestorygraph.com`.

## Badges

| Badge | Meaning |
|---|---|
| 🔑 | A login form is showing; the username field has been focused for you. |
| `!` | The site is showing a CAPTCHA or 2FA challenge. Handle it manually. |
| `?` | The page wasn't recognized — probably a site redesign. Nothing was touched. |

## Tests

```bash
npm install
npm test
```

Tested: URL construction for all three sites, page classification against saved
HTML, the pending-intent state machine, and the security invariants above.

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
