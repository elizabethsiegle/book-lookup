# Book Lookup — Chrome Extension Design

**Date:** 2026-08-12
**Status:** Approved, ready for implementation planning

## Purpose

A Manifest V3 Chrome extension. Type a book title or author into one textbox, click once,
and land on that book's search results at SF Public Library, Goodreads, and The StoryGraph —
logged in and ready to place a hold, shelve, or read reviews.

Replaces: open three tabs, remember three URLs, log into three sites.

**Primary use:** the author's personal reading workflow, and live demos of the extension.
That ranking matters. The happy path — already logged in, one click, three results pages —
is the demo, and it must be flawless. The login and resume machinery is a correctness
requirement but a rare path in practice; it is built to fail safe rather than to impress.

## Hard constraint: the extension never handles passwords

This is the central design decision, not a limitation to work around.

Chrome deliberately blocks content scripts from programmatically filling or submitting
password fields without a genuine user gesture. This is anti-phishing protection. Fully
automatic, zero-click login is therefore not achievable, and we do not attempt it.

Passwords live in Chrome's own password manager, saved by the user through
Settings → Passwords, encrypted and tied to their OS/Google account. The extension's
entire contribution to login is: navigate to the right page, and focus the username field
so Chrome's autofill dropdown appears under the cursor.

The security boundary is enforced structurally, not by convention. The content script has
exactly two side effects available to it:

1. `element.focus()` on a username/email field
2. `chrome.runtime.sendMessage` to the background worker

It never reads `.value` on any element, never touches a `input[type=password]`, never
navigates, and never logs DOM contents. A unit test asserts `.value` does not appear in the
content-script source. Navigation is performed by the background service worker, which page
context cannot reach.

`chrome.storage` holds no secret because the extension is never in a position to obtain one.

## Verified site behavior

Confirmed against the live sites on 2026-08-12:

| Site | Search URL | Mode parameter |
|---|---|---|
| SFPL (BiblioCommons) | `https://sfpl.bibliocommons.com/v2/search?query=<q>&searchType=<t>` | `title`, `author` (also accepts keyword, series, subject, tag, list, user) |
| Goodreads | `https://www.goodreads.com/search?q=<q>&search[field]=<t>` | `title`, `author` |
| The StoryGraph | `https://app.thestorygraph.com/browse?search_term=<q>` | **none** |

SFPL login lives at `https://sfpl.bibliocommons.com/user/login`.

**StoryGraph has no title-vs-author distinction.** `search_term` is free text matched across
titles, authors, and series. The mode toggle therefore drives two of the three sites, and the
popup says so rather than silently ignoring the setting.

Goodreads sometimes redirects an exact single match straight to the book's page rather than a
results list. That is Goodreads' own behavior on the URL we open, not something the extension
implements or suppresses — `detect()` must classify such a page as `results`, not `unknown`.

**StoryGraph sits behind Cloudflare bot protection** — it returned HTTP 403 to an automated
fetch. This is not an auth wall; it is a signal that a real, logged-in browser tab is the only
viable way in, which is precisely the architecture here. It also means StoryGraph fixtures
cannot be machine-collected (see Testing).

## Architecture

### Site adapters are pure functions

One module per site, each exporting the same shape:

```js
{
  id,                            // 'sfpl' | 'goodreads' | 'storygraph'
  label,                         // display name for the popup
  hostMatch,                     // exact host string
  buildSearchUrl(query, mode),   // → string
  detect(document, url),         // → 'results'|'login'|'authed'|'challenge'|'unknown'
}
```

`detect(document, url)` takes a `Document` plus the page URL and returns a string. No I/O, no
Chrome APIs, no side effects. This is what makes the fragile part of the system
machine-testable against saved HTML.

Two refinements settled during planning:

- **Five states, not four.** `'challenge'` is separate from `'unknown'` because the error
  table below gives a CAPTCHA/2FA page a red `!` badge and an unrecognized page a grey `?`.
  One state could not produce two badges.
- **No per-site `usernameSelector`.** The username field is resolved generically: find the
  password input, then take the nearest visible text/email input preceding it inside the same
  form. This survives redesigns better than three hand-maintained selectors, and it makes the
  focus behavior work on any login page these sites render, not only the anticipated ones.

Every adapter returns `'unknown'` when it cannot confidently classify. Uncertainty must never
be resolved into action.

### Control flow

```
popup → background:  { query, mode, sites[] }

background:  build URLs
             tabs.create × N  (SFPL active; Goodreads + StoryGraph in background)
             record intent per tab:
               { tabId, site, targetUrl, resumed: false, expiresAt: now + 10min }

content script (runs at document_idle on all three hosts, every page load):
             classify page via adapter
             report { site, state } to background

background decides:
  state = results                            → clear intent. Done.
  state = login                              → reply { focus: usernameSelector }
                                               badge 🔑. DO NOT navigate.
  state = authed AND intent exists AND !resumed
                                             → tabs.update(targetUrl)
                                               mark resumed: true
  state = unknown                            → badge ?. Clear intent. Do nothing.
```

### One automatic navigation, ever

Three independent guards make looping structurally impossible:

- the `resumed` flag — an intent can trigger at most one navigation
- a 10-minute expiry
- intents cleared on tab close, and on navigation off the site's domain

There is no code path that navigates twice for one intent.

### Where state lives

All pending state lives in `chrome.storage.session`, owned by the service worker. Content
scripts never read or write it; they report and receive instructions. `chrome.storage.session`
defaults to trusted-contexts-only access, so this is enforced by the platform, not by
discipline.

Non-sensitive preferences live in `chrome.storage.local`: default search mode, last query,
which sites Search All includes.

### Permissions

`storage`, plus host permissions for exactly three origins:

```
https://sfpl.bibliocommons.com/*
https://www.goodreads.com/*
https://app.thestorygraph.com/*
```

No `tabs` (creating tabs does not require it). No `scripting` (content scripts are
declaratively registered). No `<all_urls>`. Nothing for passwords, because none are touched.

### Module loading

No bundler and no build step — load the folder directly via `chrome://extensions`. But the
adapters must be real ES modules so Vitest can import the shipped file rather than a copy:

- service worker: `"type": "module"` in the manifest, natively supported
- popup and options: `<script type="module">`
- content script: a five-line classic-script loader that dynamic-`import()`s the adapter
  modules from `web_accessible_resources`, scoped to the three hosts

The tested file and the shipped file are the same file.

### Rejected approach

Doing this with no content scripts at all. The happy path genuinely does not need them —
opening the URL is sufficient when already logged in. Content scripts exist *solely* for
login-field focus and post-login resume. This was considered and rejected because both
behaviors were explicitly requested; the tradeoff is noted here because dropping the content
scripts entirely remains a clean fallback if the site-driving layer becomes more trouble than
it is worth.

## User flow

1. Click the extension icon. Popup opens with the last query and mode restored.
2. Type a query. Pick Title or Author (default: title, configurable).
3. Press Enter, or click **Search All**, or click one of the three site buttons.
4. Search All opens three tabs at once. SFPL becomes the active tab — it is the one with a
   real time cost, since holds and waitlists are queue-based. Goodreads and StoryGraph load
   quietly behind it. The popup closes immediately.
5. If a site is logged out, its login page loads and the username field is focused; Chrome's
   autofill suggestion is one click away. After logging in, the extension resumes to the
   search results automatically — once.
6. Everything after that is manual: place the hold, click Want to Read, add to a list.

## Error handling

The badge is the only notification channel, set per-tab via
`chrome.action.setBadgeText({ tabId })`, so three tabs report independently.

| Situation | Badge | Behavior |
|---|---|---|
| Login form found | 🔑 amber | Focus username field. Stop. |
| CAPTCHA or 2FA prompt | `!` red | Clear intent. Touch nothing. |
| Page unrecognized (redesign) | `?` grey | Clear intent. Touch nothing. |
| Results reached | cleared | — |

The badge clears on navigation away, so stale state never lingers.

Notes:

- **No saved Chrome password yet** is not an error. The focused field simply has no autofill
  suggestion, and a normal login page waits for manual entry — a good moment to save the
  password in Chrome.
- **No retries, no loops, ever.** Every failure mode terminates by leaving the real page alone.
- A site redesign degrades the extension to a bookmark. It does not break the page.

## Testing

Vitest with jsdom. Everything pure is tested; everything impure is a thin shell.

**URL builders** — 3 sites × {title, author}, plus:
- `Tomorrow, and Tomorrow, and Tomorrow` (comma-heavy, the canonical demo query)
- apostrophes, accented author names, `&`, `+`, `#`
- whitespace-only and empty queries rejected in the popup before dispatch
- correct encoding of the literal brackets in Goodreads' `search[field]` parameter

**`detect()` per site**, against saved HTML fixtures, for each of the five return states.

**Intent state machine** — a pure reducer, no Chrome APIs: expiry, resume-once, tab-close
cleanup, off-domain abandonment, unknown-state clearing.

**Security invariant** — a source assertion that `.value` does not appear in the
content-script source.

### Known gap in fixture coverage

Logged-out SFPL and Goodreads pages can be fetched automatically, so those fixtures are real
captures. Two categories cannot be:

- **any StoryGraph page** — Cloudflare returns 403 to automated fetches
- **any logged-in page, on any of the three sites**

The `authed` classification — the trigger for post-login resume — therefore ships as an
educated guess against handwritten fixtures, and will be labeled as such rather than reported
as verified.

Closing the gap takes roughly five minutes of manual work: while logged into each site, open
DevTools → Elements → right-click `<html>` → Copy → Copy outerHTML, and save into
`test/fixtures/`. Six files — logged-out and logged-in for each site. The implementation plan
includes this as an explicit task with the exact filenames.

The extension is designed to work before those fixtures exist and to be *hardened* by them.
Until they land, `authed` detection is unverified.

## Interface

**Popup:** one text field, a Title/Author segmented toggle, **Search All** as the primary
action, three site buttons beneath it. Enter submits Search All. A quiet inline note explains
that StoryGraph ignores the mode toggle. Last query and mode persist. Presentable enough to
put on a projector.

**Options:** an explanation of the password-manager approach, a button opening
`chrome://settings/passwords`, the default search mode, and checkboxes for which sites Search
All includes. No credential fields of any kind.

## File layout

```
manifest.json
src/popup/popup.{html,css,js}
src/options/options.{html,js}
src/background.js              service worker: tabs, intents, badges
src/content/loader.js          5-line classic-script bootstrap
src/content/runner.js          classify → report → focus. No .value, ever.
src/sites/sfpl.js              pure adapter
src/sites/goodreads.js         pure adapter
src/sites/storygraph.js        pure adapter
src/sites/index.js
src/lib/intents.js             pure state machine
src/lib/prefs.js               chrome.storage.local wrapper
test/*.test.js
test/fixtures/*.html
```

## Out of scope for v1

- **Auto-shelving** (auto-clicking "Add to shelf" / a named StoryGraph list). Deferred
  deliberately: it is the most breakage-prone feature, and its selectors would be guesswork
  against pages not yet inspected. Revisit as a second spec after the core flow has earned
  its keep. The adapter interface leaves room for it.
- Library systems other than SFPL/BiblioCommons.
- Any Goodreads or StoryGraph API. Goodreads retired developer API access in December 2020
  and disabled existing keys; StoryGraph has never had a public API. Reverse-engineering
  private endpoints is explicitly not the approach.
- Handling 2FA or CAPTCHA challenges. These fall back to manual.
- Credential storage or handling, in any form. This is a security boundary, not a gap.

## Caveats

This is a personal tool that drives three sites' HTML. Any of them can redesign and break the
login-focus and resume features without warning. The URL-opening core keeps working
regardless — the design deliberately confines the fragile behavior to the layer that fails
safe.

It is not built for distribution, and site Terms of Service are a genuine consideration for
any use beyond personal.
