import { createHash } from 'node:crypto'
import { existsSync, readlinkSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

import { WebBrowserConfigError } from './errors.js'

const HOME = homedir()

/** State owned by this bundle: profiles, ownership markers, the journal. */
export const STATE_ROOT = join(HOME, '.dsh', 'browser-web')

/**
 * Browse modes.
 *
 * Each mode fixes three things: the profile directory the browser is driven
 * against, whether a sign-in window may be opened for that profile, and whether
 * the previous session is restored on launch (which is what keeps session-only
 * cookies alive).
 *
 * - `anonymous` (A, default) never offers a sign-in window. Its profile is
 *   dedicated to this bundle and lives under the state root.
 * - `signed-in` (B) has its own dedicated profile, separate from A, so a session
 *   started on purpose never leaks into anonymous browsing.
 * - `personal` (C) drives a profile directory the user already has. It never
 *   creates one, never deletes one, and refuses to run while another Chrome
 *   instance holds it.
 */
export const MODES = Object.freeze({
  anonymous: Object.freeze({
    id: 'anonymous',
    alias: 'A',
    label: 'Anonymous',
    summary: 'Dedicated profile, no sign-in window. Search results stay unpersonalised.',
    profileDir: join(STATE_ROOT, 'profile'),
    loginWindow: false,
    restoreSession: false,
    external: false,
  }),
  'signed-in': Object.freeze({
    id: 'signed-in',
    alias: 'B',
    label: 'Signed in',
    summary: 'Dedicated profile you may sign into by hand; the session is restored on restart.',
    profileDir: join(STATE_ROOT, 'signed-in'),
    loginWindow: true,
    restoreSession: true,
    external: false,
  }),
  personal: Object.freeze({
    id: 'personal',
    alias: 'C',
    label: 'Personal profile',
    summary: 'Drives an existing Chrome profile directory; requires Chrome to be closed on it.',
    profileDir: undefined,
    loginWindow: true,
    restoreSession: true,
    external: true,
  }),
})

/** Spelling accepted in the `mode` field, including the A/B/C shorthand. */
const MODE_ALIASES = new Map([
  ['a', 'anonymous'],
  ['anonymous', 'anonymous'],
  ['b', 'signed-in'],
  ['signed-in', 'signed-in'],
  ['signedin', 'signed-in'],
  ['c', 'personal'],
  ['personal', 'personal'],
])

/**
 * Canonical mode id for a raw config value.
 *
 * @param {unknown} value - raw `mode` from the patch.
 * @returns {'anonymous' | 'signed-in' | 'personal'} canonical mode id.
 * @throws {WebBrowserConfigError} when the value names no known mode.
 */
export function normalizeMode(value) {
  if (value === undefined || value === null || value === '') return 'anonymous'
  const key = String(value).trim().toLowerCase()
  const mode = MODE_ALIASES.get(key)
  if (mode === undefined) {
    throw new WebBrowserConfigError(
      `"mode" must be one of anonymous (A), signed-in (B), or personal (C); got ${JSON.stringify(String(value))}`,
    )
  }
  return mode
}

/**
 * Rewrite a home-relative path and reject relative paths.
 *
 * @param {unknown} value - raw path from the patch.
 * @param {string} label - field name used in the error message.
 * @returns {string | undefined} absolute path, or undefined when unset.
 * @throws {WebBrowserConfigError} for a relative path.
 */
export function directory(value, label) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const expanded = trimmed === '~' ? HOME : trimmed.startsWith('~/') ? join(HOME, trimmed.slice(2)) : trimmed
  if (!isAbsolute(expanded)) {
    throw new WebBrowserConfigError(`"${label}" must be an absolute path or start with "~/"; got ${JSON.stringify(trimmed)}`)
  }
  return resolve(expanded)
}

/**
 * Profile and marker directories for one settings record.
 *
 * Markers live outside the profile so that driving a personal profile writes
 * nothing into it, and so that a read-only profile is still reusable.
 *
 * @param {{ mode: 'anonymous' | 'signed-in' | 'personal', userDataDir?: unknown, personalProfileDir?: unknown }} input
 * @returns {{ profileDir: string, markerDir: string, external: boolean }} resolved locations.
 * @throws {WebBrowserConfigError} when personal mode has no usable profile.
 */
export function resolveProfile(input) {
  const info = MODES[input.mode]
  const explicit = directory(input.userDataDir, 'userDataDir')
  const personal = directory(input.personalProfileDir, 'personalProfileDir')

  if (info.external && personal !== undefined && explicit !== undefined && personal !== explicit) {
    throw new WebBrowserConfigError(
      '"personalProfileDir" and "userDataDir" name different directories; in personal mode set only "personalProfileDir"',
    )
  }

  // Personal mode names its target with `personalProfileDir`; `userDataDir` is
  // only a fallback for setups that predate modes.
  let profileDir = info.external ? (personal ?? explicit) : explicit
  if (profileDir === undefined && info.external) {
    throw new WebBrowserConfigError(
      '"mode" is "personal", so "personalProfileDir" must name an existing Chrome profile directory (or set "userDataDir")',
    )
  }
  if (profileDir === undefined) profileDir = info.profileDir

  if (info.external) {
    if (!existsSync(profileDir)) {
      throw new WebBrowserConfigError(
        `the personal profile directory does not exist: ${displayPath(profileDir)}. Point "personalProfileDir" at a Chrome profile that already exists; this mode never creates one.`,
      )
    }
    if (!looksLikeChromeProfile(profileDir)) {
      throw new WebBrowserConfigError(
        `the personal profile directory does not look like a Chrome profile (no "Local State" and no "Default" entry): ${displayPath(profileDir)}`,
      )
    }
  }

  const markerBase = info.external ? STATE_ROOT : dirname(profileDir)
  return { profileDir, markerDir: join(markerBase, 'markers'), external: info.external }
}

/**
 * Ownership marker for one profile.
 *
 * The file name is a hash of the profile path so markers for different profiles
 * never collide, and the marker itself stays out of the profile directory.
 *
 * @param {string} profileDir - normalized profile directory.
 * @param {string} markerDir - directory that holds markers.
 * @returns {string} marker file path.
 */
export function markerPath(profileDir, markerDir) {
  const digest = createHash('sha1').update(profileDir).digest('hex').slice(0, 32)
  return join(markerDir, `${digest}.json`)
}

/**
 * Older marker location, inside the profile. Read only, so an upgraded bundle
 * adopts the browser a previous version launched instead of starting a second
 * one on a fresh port.
 *
 * @param {string} profileDir - normalized profile directory.
 * @returns {string} legacy marker path.
 */
export function legacyMarkerPath(profileDir) {
  return join(profileDir, 'dsh-web-browser.json')
}

/**
 * Whether a directory carries the two entries every Chrome profile has.
 *
 * @param {string} profileDir - candidate profile directory.
 * @returns {boolean} true when the directory looks like a profile.
 */
export function looksLikeChromeProfile(profileDir) {
  return existsSync(join(profileDir, 'Local State')) || existsSync(join(profileDir, 'Default'))
}

/**
 * Live owner of a Chrome profile lock, when this machine holds one.
 *
 * Chrome writes `SingletonLock` as a symlink to `<host>-<pid>`. A lock left by a
 * crashed browser points at a dead pid, which is not an owner.
 *
 * @param {string} profileDir - normalized profile directory.
 * @returns {{ pid: number, host: string } | undefined} the live owner, if any.
 */
export function profileLockOwner(profileDir) {
  let target
  try {
    target = readlinkSync(join(profileDir, 'SingletonLock'))
  } catch {
    return undefined
  }
  const match = /^(.*)-(\d+)$/u.exec(target)
  if (match === null) return undefined
  const [, host, pidText] = match
  const ownHost = hostname()
  if (host !== ownHost && !ownHost.startsWith(host)) return undefined
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
  } catch {
    return undefined
  }
  return { pid, host }
}

/**
 * Refuse to launch into a profile a live Chrome already owns.
 *
 * Without this the new process exits 0 (Chrome hands the profile to the running
 * instance), which reads as a launch timeout instead of the actual conflict.
 *
 * @param {string} profileDir - normalized profile directory.
 * @param {'anonymous' | 'signed-in' | 'personal'} mode - active mode.
 * @returns {void}
 * @throws {WebBrowserConfigError} when another Chrome holds the profile.
 */
export function assertProfileIdle(profileDir, mode) {
  const owner = profileLockOwner(profileDir)
  if (owner === undefined) return
  const advice = mode === 'personal'
    ? 'quit that Chrome, or copy the profile elsewhere and point "personalProfileDir" at the copy'
    : 'close it, or point "userDataDir" at another directory'
  throw new WebBrowserConfigError(`that profile is in use by a running Chrome (pid ${owner.pid}): ${displayPath(profileDir)}; ${advice}.`)
}

/**
 * Render a path for a message, with the home directory shortened to `~`.
 *
 * @param {string} path - absolute path.
 * @returns {string} display form.
 */
export function displayPath(path) {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}
