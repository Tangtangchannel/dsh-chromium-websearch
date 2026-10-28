#!/usr/bin/env node
/**
 * Wipe the browser profile of a mode, so the next launch starts signed out.
 *
 * Personal (C) profiles are never deleted: that directory is the user's own
 * browser data, not this bundle's. A running browser also blocks the reset,
 * because deleting a live profile would leave the browser writing into it.
 *
 * usage: node scripts/logout.mjs [--mode <mode>] [--profile <dir>] [--yes]
 */
import { rmSync } from 'node:fs'
import process from 'node:process'

import { recordedBrowser } from '../lib/chrome.js'
import { normalizeSettings } from '../lib/config.js'
import { MODES, displayPath, markerPath, normalizeMode } from '../lib/modes.js'

const USAGE = `usage: logout.mjs [--mode <mode>] [--profile <dir>] [--yes]
  --mode     anonymous (A) | signed-in (B); default anonymous
  --profile  an existing Chrome profile directory; implies --mode personal
  --yes      actually delete instead of printing the plan`

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

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.has('help') || options.has('h')) {
    console.log(USAGE)
    return 0
  }
  const profile = options.get('profile')
  const mode = profile !== undefined ? 'personal' : normalizeMode(options.get('mode') ?? 'anonymous')

  if (mode === 'personal') {
    const target = typeof profile === 'string' ? profile : '<personalProfileDir>'
    console.error(
      [
        `refusing to delete a personal Chrome profile: ${target}`,
        'That directory is the user\'s own browser data; this bundle only drives it and never removes it.',
        `If it really must go, delete it with the file manager after quitting Chrome, and start ${MODES.personal.label} mode on another profile.`,
      ].join(' '),
    )
    return 3
  }

  const settings = normalizeSettings({ mode, journal: false })
  const live = await recordedBrowser(settings)
  if (live !== undefined) {
    console.error(
      [
        `the ${settings.mode} browser is still running at ${live}: ${displayPath(settings.userDataDir)}`,
        'Close that browser window first, then run this command again.',
      ].join(' '),
    )
    return 4
  }

  const marker = markerPath(settings.userDataDir, settings.markerDir)
  if (!options.has('yes')) {
    console.log(
      [
        `would delete: ${displayPath(settings.userDataDir)}`,
        `would delete: ${displayPath(marker)}`,
        're-run with --yes to delete, which signs the next launch out of every site.',
      ].join('\n'),
    )
    return 1
  }

  rmSync(settings.userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  rmSync(marker, { force: true })
  console.log(`removed ${displayPath(settings.userDataDir)}; the next ${settings.mode} launch starts from a fresh profile.`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`logout failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
