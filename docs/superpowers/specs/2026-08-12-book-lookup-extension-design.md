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

## Credential handling: opt-in, owner-stored, plaintext

**Revised 2026-08-18.** The original design forbade the extension from ever holding a
credential. The owner has since chosen to reverse that for their own SFPL library card,
having been shown what it costs. This section records the new position and the reasoning,
because a security decision that is not written down gets quietly re-litigated later.

### One correction to the original rationale

The first draft justified the ban partly on a technical claim: that Chrome blocks content
scripts from filling or submitting password fields without a user gesture. That is not
accurate for extension content scripts, and the error mattered — it made a policy choice
look like a platform limit. The accurate position is two separate facts:

- **The extension can never use a Chrome-saved password.** No API exposes Chrome's password
  manager to extensions. This remains genuinely impossible.
- **An extension holding its own copy of a credential can fill and submit a login form.**
  This works. It was forbidden by choice, not by the platform.

### What is now permitted, and what still is not

Credentials are **opt-in per site, off by default**, entered by the owner in the options
page, and stored in `chrome.storage.local`.

**They are stored in plaintext.** Extensions have no access to the OS keychain, so there is
no honest way to encrypt them at rest — a key that ships alongside the ciphertext protects
nothing. Obfuscating them would create the impression of safety without the substance, which
is worse than storing them plainly and saying so. Anyone with the owner's user account, and
any backup or sync of that Chrome profile, can read them. The options page and the README
both state this in those terms.

Still prohibited, without exception:

- **Reading a value from any field.** The extension may inject a credential it already
  holds; it may never learn what the user typed. This is the property that actually
  protects the owner, and it is the one the invariant test now enforces.
- Transmitting anything off the machine. There is still no network code anywhere.
- Storing anything a page gave us — page content, URLs with credentials, form state.

### The narrowed structural boundary

The content script's side effects are now:

1. `element.focus()` on a username/email field
2. `chrome.runtime.sendMessage` to the background worker
3. **writing** a stored credential into a login form — permitted in exactly one file,
   `src/content/autofill.js`. It fills both fields and stops; it never submits the form.

The invariant test splits accordingly: a `.value` **write** is legal in `autofill.js` alone;
a `.value` **read** is illegal everywhere, that file included. Every other content-script
file keeps the original total ban.

### Automated submission was built, audited three times, defeated six ways, and removed

An earlier version of this feature filled the login form **and submitted it**, gated by a
consecutive-failure cap: library systems lock a card after a small number of wrong PIN
attempts, and an extension that resubmits on every page load could exhaust that in seconds,
locking the owner out of their own account.

That cap went through three independent adversarial audits. Each one found real ways to
defeat it, and each fix round introduced a new hole. Across the three rounds, six distinct
defeats were found: scoring a CAPTCHA/2FA challenge page as a successful login and resetting
the counter on it; resetting on a logged-out results page that merely shared a URL path with
an authenticated one; a non-atomic read-modify-write on the failure counter that let several
concurrent tabs each receive a credential before any of them incremented it; a manual,
by-hand sign-in resetting the counter while a stale, still-wrong PIN remained the one stored;
and a reset triggerable from a cross-origin page. Counting at hand-out time instead of
confirmation time, gating the reset behind an explicit signed-in signal instead of URL/state
alone, and locking the counter update closed each hole that had just been found — and opened
the next one.

The owner decided to stop hardening this and remove automated submission entirely instead.
**No auto-submit means no runaway attempts, which means the cap — and every hole in it —
becomes unnecessary rather than merely harder to exploit.** `src/content/autofill.js` now
fills both fields and stops; the owner presses Enter. This eliminates the risk the cap
existed to mitigate, rather than mitigating it more thoroughly: there is no consecutive-
failure count left to defeat, no reset logic left to spoof, and no confirmation channel left
to race.

### Anti-spoofing guard

Autofill fires only when all of these hold, and skips silently otherwise:

- the page is `https:`
- the host matches the adapter exactly (the existing exact-host equality, never a substring)
- the path matches that site's known login path
- a password field and a resolvable username field are both present

This keeps an open redirect or an injected form on those origins from being handed a
credential.

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

Two independent guards make looping structurally impossible, plus one cleanup:

- the `resumed` flag — an intent can trigger at most one navigation
- a 10-minute expiry
- intents cleared when the tab closes (`tabs.onRemoved`)

There is no code path that navigates twice for one intent.

**Corrected during the final review:** an earlier draft listed a fourth guard,
clearing the intent when the tab navigates off the site's domain. That guard is
not implementable under this extension's permissions and was removed rather than
left as dead code. Without the `tabs` permission Chrome withholds
`changeInfo.url` for exactly the off-host navigations such a handler would need
to see, so it can never fire. Acquiring `tabs` to make it work would cost more —
that permission grants URL visibility across every tab — than the guard is worth,
given the two real guards already make double-navigation impossible.

**Also corrected:** a challenge page must NOT clear the pending search.
StoryGraph sits behind Cloudflare, whose interstitial renders *before* the real
page. Clearing on challenge meant the interstitial destroyed the pending search,
so the subsequent login had nothing to resume and the feature silently no-opped
on the one site most likely to need it. A challenge now badges `!` and leaves the
intent alone.

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
| CAPTCHA or 2FA prompt | `!` red | Touch nothing, but KEEP the pending search. |
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
All includes. As of 2026-08-18 it also carries the opt-in credential section described above:
per-site card-number and PIN fields, off by default, each sitting beneath a plain statement
that the values are stored unencrypted on disk.

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
- ~~Credential storage or handling, in any form.~~ **Reversed 2026-08-18** at the owner's
  request — see "Credential handling" above. What remains out of scope is reading any value
  the user typed, and moving anything off the machine.

## Caveats

This is a personal tool that drives three sites' HTML. Any of them can redesign and break the
login-focus and resume features without warning. The URL-opening core keeps working
regardless — the design deliberately confines the fragile behavior to the layer that fails
safe.

It is not built for distribution, and site Terms of Service are a genuine consideration for
any use beyond personal.
