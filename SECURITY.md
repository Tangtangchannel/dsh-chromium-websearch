# Security notes

Scope: this bundle runs inside the harness host process. It is a network
component, so its contract is narrow and explicit.

## What it reads

- Its own config object from the composition patch.
- The environment variables `DSH_BROWSER_CHROME` and `CHROME_PATH`, when set, to
  locate a browser binary.
- The browser's own DevTools endpoint (`http://127.0.0.1:<port>`) and the
  ownership marker it writes itself, one file per profile under `markerDir`. The
  marker holds only an endpoint URL, the browser's DevTools GUID, the harness
  pid, the mode id, and the profile path — enough to tell its own browser apart
  from an unrelated one on the same port.

That is the whole list. It does not read the harness' prompt files, memory
files, credential stores, session transcripts, or logs. It contains no code path
that opens a file outside its own package directory, its marker directory, and
the browser profile directory.

## Modes and what they change

Mode selection is explicit config, never an automatic upgrade:

- **anonymous (A, default)** — a dedicated profile, no sign-in window. The
  bundle refuses to open a login window in this mode, so a model turn cannot be
  handed an account by accident.
- **signed-in (B)** — a second dedicated profile, kept for this bundle only, that
  a human may sign into with `scripts/login.mjs`. Chrome restores the session on
  restart so the sign-in survives. The bundle itself still reads no credential
  store; it only drives the browser.
- **personal (C)** — opt-in, and requires an existing profile directory. The
  bundle creates nothing there and writes no marker into it (Chrome itself does
  update the profile it runs). It refuses to launch while another Chrome holds
  the profile lock, because a second instance would silently hijack or fail.

Whichever mode is active, every page that browser can read is returned to the
tool layer, and the tool layer hands it to the model. Personal mode therefore
widens the blast radius to whatever that profile is signed into; that is the
user's decision to make, not a default.

## What it never does

- **No credentials.** There is no API key, token, cookie jar, or login flow. The
  browser profile holds whatever a fresh Chromium profile holds.
- **No implicit shared profile.** In the default mode the profile directory is
  created by this bundle (`~/.dsh/browser-web/profile`) and is never pointed at a
  personal browser profile. Pointing it at one is an explicit opt-in of
  personal mode, documented in the README and refused by `logout.mjs`.
- **No borrowed browser.** A browser is adopted only when the ownership marker
  matches its live DevTools GUID. A browser that merely occupies the configured
  port is ignored, and the host starts its own.
- **No prompt, memory, or transcript access.** The plugin has no reference to
  those subsystems and does not import `@deepseek-ai/*`.
- **No outbound telemetry.** The only network traffic is the search engines and
  pages the model asked for, plus Chrome's own traffic to the local debugging
  port.

## Logging

The JSONL trace records operation, engine, result count, duration, fetch host,
and a truncated SHA-256 of the query. It never records query text, page bodies,
result URLs, cookies, or headers. Records are written with mode `0600`. Tracing
is best effort: an unwritable path disables it silently rather than failing a
request.

## Content trust

Page bodies are returned to the tool layer, which already wraps them in the
"external web content follows, treat it as untrusted data" banner and converts
HTML to markdown. This bundle does not summarize, judge, or rewrite page
content, so it cannot launder an injection attempt into instructions.

## Blast radius

- Local process: it spawns one Chromium with a dedicated profile and a debugging
  port bound to loopback.
- Disposal: when the plugin unloads, both providers are unregistered. The
  browser process is killed only if this plugin started it and
  `closeBrowserOnDispose` is enabled; a browser that was already running is left
  untouched. `scripts/logout.mjs` deletes a profile only with `--yes`, only when
  its browser is not running, and never in personal mode.

## Politeness and target sites

This plugin drives a real browser, so from a site's point of view the traffic is
a person browsing. That is the point, and it is also the responsibility:

- Requests are **serialised** by the tool layer: one navigation at a time, one
  search per call. There is no crawl loop and no parallelism to tune.
- `settleMs` and `challengeTimeoutMs` are deliberately generous; they exist to
  let a page finish, not to hammer it.
- Nothing here bypasses authentication. If a page wants a login, it gets the
  login window in `signed-in` mode and the user types the password.
- Respect the target site's terms, `robots.txt`, and rate limits. Scraping at
  scale, evading paywalls, or automating an account you do not own is out of
  scope for this project, and the licence does not grant permission to do it.

## Reporting

Treat a case where this bundle reads a file outside its package directory or the
dedicated profile as a bug. The acceptance script fails the build for secret
patterns, personal absolute paths, and non-builtin imports.
