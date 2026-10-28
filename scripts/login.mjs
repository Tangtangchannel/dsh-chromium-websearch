#!/usr/bin/env node
/**
 * Open the browser profile for a mode so a human can sign in by hand.
 *
 * The window is deliberately headful and deliberately detached: this command
 * exits while the browser keeps running, the cookies land in the mode's own
 * profile, and the next `web_search` / `web_fetch` call reuses the same browser
 * through its ownership marker.
 *
 * Sign-in is never offered in anonymous (A) mode. Use signed-in (B) or an
 * explicit personal profile (C).
 *
 * usage: node scripts/login.mjs [--mode <mode>] [--url <url>] [--profile <dir>] [--chrome <path>]
 *        node scripts/login.mjs --list
 */
import process from 'node:process'

import { BrowserHost } from '../lib/chrome.js'
import { normalizeSettings } from '../lib/config.js'
import { MODES, displayPath, normalizeMode } from '../lib/modes.js'
import { PageSession } from '../lib/page.js'

const USAGE = `usage: login.mjs [--mode <mode>] [--url <url>] [--profile <dir>] [--chrome <path>]
  --mode     anonymous (A) | signed-in (B) | personal (C); default signed-in
  --url      page to open for the sign-in; default https://www.bing.com/
  --profile  an existing Chrome profile directory; implies --mode personal
  --chrome   browser binary to launch, when autodetection picks the wrong one
  --list     print the modes and exit`

/**
 * Parse `--name value` and `--name=value` pairs.
 *
 * @param {string[]} argv - arguments without the node and script entries.
 * @returns {Map<string, string | true>} parsed options.
 */
function parse(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const [name, inline] = argument.slice(2).split('=', 2)
    if (inline !== undefined) {
      options.set(name, inline)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      options.set(name, next)
      index += 1
    } else {
      options.set(name, true)
    }
  }
  return options
}

/**
 * Render the mode table.
 *
 * @returns {string} one line per mode.
 */
function modeTable() {
  return Object.values(MODES)
    .map((mode) => `  ${mode.alias}  ${mode.id.padEnd(10)} ${mode.summary}`)
    .join('\n')
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.has('help') || options.has('h')) {
    console.log(USAGE)
    return 0
  }
  if (options.has('list')) {
    console.log(modeTable())
    return 0
  }

  const profile = options.get('profile')
  const mode = profile !== undefined ? 'personal' : normalizeMode(options.get('mode') ?? 'signed-in')
  const url = typeof options.get('url') === 'string' ? options.get('url') : 'https://www.bing.com/'

  const settings = normalizeSettings({
    mode,
    personalProfileDir: typeof profile === 'string' ? profile : undefined,
    chromePath: typeof options.get('chrome') === 'string' ? options.get('chrome') : undefined,
    journal: false,
    headless: false,
    closeBrowserOnDispose: false,
  })

  if (!settings.loginWindow) {
    console.error(
      [
        `mode "${settings.mode}" has no sign-in window: anonymous browsing stays signed out by design.`,
        'Run with --mode signed-in (dedicated profile) or --mode personal --profile <dir>, sign in there,',
        'and keep the anonymous mode for searches that must stay reproducible.',
      ].join(' '),
    )
    return 2
  }

  const host = new BrowserHost(settings)
  const session = await PageSession.open(host)
  try {
    const navigation = await session.navigate(url, { timeoutMs: settings.navigateTimeoutMs })
    console.log(
      [
        `mode: ${settings.mode}`,
        `profile: ${displayPath(settings.userDataDir)}`,
        `endpoint: ${await host.endpoint()}`,
        `opened: ${navigation.url} (HTTP ${navigation.status})`,
        '',
        'Sign in in the window that just opened. It stays open after this command exits.',
        'The next web_search / web_fetch call reuses the same browser, so pages it can read are pages the model can read.',
        'Keep email, banking, payment, cloud-console and write-scoped accounts out of this window.',
        'To start over, run scripts/logout.mjs --yes (it deletes this profile).',
      ].join('\n'),
    )
  } finally {
    await session.close()
    // The browser is detached and `closeBrowserOnDispose` is off, so the window
    // and its cookies survive this process.
    await host.dispose()
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`login failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
