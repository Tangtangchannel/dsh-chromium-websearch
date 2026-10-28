# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the usual `0.x`
allowance: minor releases may break compatibility.

## [0.2.0] - 2026-10-28

First public release, as `dsh-chromium-websearch`.

### Added

- `web_search` provider driving a real headful Chromium over CDP (Bing,
  DuckDuckGo, Baidu) with redirect unwrapping and bot-wall settling.
- `web_fetch` provider that strips scripts/styles/svg/iframes and returns clean
  HTML or text, with `bodyFormat` selection.
- Three modes: `anonymous` (disposable profile), `signed-in` (kept profile,
  login window), `personal` (an existing Chrome profile directory).
- Automatic browser provisioning: when no Chromium build is installed, the
  stable Chrome for Testing build is downloaded once into
  `~/.dsh/browser-web/chromium` and reused. No postinstall script, no user step.
- Dependency-free ZIP reader for the provisioning path.
- Optional JSONL trace of navigations (`journal`), disabled with `journal: false`.

### Changed

- Package published as `dsh-chromium-websearch` (formerly the local
  `@local/dsh-web-browser`); the composition patch and install docs follow the
  new name. On-disk state file names are unchanged.
- GPL-3.0-or-later license.

## [0.1.3] - 2026-10-27

- Internal iteration: CDP client, search extractors, mode handling.
