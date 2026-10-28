import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { extractZip } from './zip.js'

/**
 * Automatic browser provisioning.
 *
 * The bundle is installed by people who never asked to manage a browser: a
 * plugin that only works after an undocumented install step gets reported as
 * broken. So when no Chromium build is present, the stable Chrome for Testing
 * build is downloaded once into the bundle's own cache and reused afterwards.
 *
 * Everything here is dependency-free on purpose: `fetch` ships with Node, the
 * ZIP reader is local, and no postinstall script is involved (package managers
 * block those by default nowadays).
 */

/** Cache root used when the patch does not override it. */
export const DEFAULT_PROVISION_DIR = join(homedir(), '.dsh', 'browser-web', 'chromium')

/** Published index of the current stable Chrome for Testing build. */
export const VERSION_ENDPOINT = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'

/** Overridable index, for a mirror or an offline copy of the same document. */

/** Executable layout inside the official archives, per platform key. */
const LAYOUT = {
  'mac-arm64': ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'mac-x64': ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  linux64: ['chrome'],
  win64: ['chrome.exe'],
  win32: ['chrome.exe'],
}

/** In-flight downloads, so two concurrent tool calls share one archive. */
const pending = new Map()

/**
 * Map this process onto the platform keys used by the Chrome for Testing index.
 *
 * @param {NodeJS.Platform} [platform] - `process.platform` by default.
 * @param {string} [arch] - `process.arch` by default.
 * @returns {string | undefined} platform key, or undefined when unsupported.
 */
export function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (platform === 'linux') return arch === 'x64' || arch === 'arm64' ? 'linux64' : undefined
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : 'win64'
  return undefined
}

/**
 * Pick the archive URL for one platform out of the published index.
 *
 * @param {unknown} index - parsed `last-known-good-versions-with-downloads.json`.
 * @param {string} key - platform key such as `mac-arm64`.
 * @returns {{ version: string, url: string } | undefined} the build to fetch.
 */
export function pickArchive(index, key) {
  const stable = index?.channels?.Stable
  const version = typeof stable?.version === 'string' ? stable.version : undefined
  const downloads = stable?.downloads?.chrome
  if (version === undefined || !Array.isArray(downloads)) return undefined
  const match = downloads.find((item) => item?.platform === key && typeof item?.url === 'string')
  return match === undefined ? undefined : { version, url: match.url }
}

/**
 * Binary path inside an extracted build.
 *
 * @param {string} root - directory holding the extracted archive.
 * @param {string} key - platform key.
 * @returns {string} absolute path.
 */
export function binaryIn(root, key) {
  const parts = LAYOUT[key]
  if (parts === undefined) throw new Error(`unsupported platform key: ${key}`)
  // The archives unpack into `chrome-<key>` for every platform, including macOS
  // (`chrome-mac-x64`), which is not the same string as the index's platform key.
  return join(root, `chrome-${key}`, ...parts)
}

/**
 * Read the marker left by a previous provisioning run.
 *
 * @param {string} provisionDir - cache root.
 * @returns {string | undefined} an existing executable path.
 */
export function provisionedBinary(provisionDir = DEFAULT_PROVISION_DIR) {
  try {
    const record = JSON.parse(readFileSync(join(provisionDir, 'current.json'), 'utf8'))
    return typeof record?.path === 'string' && existsSync(record.path) ? record.path : undefined
  } catch {
    return undefined
  }
}

/**
 * Download and unpack Chrome for Testing when the machine has no browser.
 *
 * Returns `undefined` instead of throwing when the platform is unsupported, so
 * the caller can fall back to its "no browser" guidance.
 *
 * @param {{ provisionDir?: string, autoProvision?: boolean }} settings - normalized settings.
 * @param {{ log?: (message: string) => void, timeoutMs?: number }} [options] - hooks.
 * @returns {Promise<string | undefined>} executable path, when provisioning worked.
 */
export async function provisionChrome(settings, options = {}) {
  if (settings.autoProvision === false) return undefined
  const provisionDir = settings.provisionDir ?? DEFAULT_PROVISION_DIR
  const cached = provisionedBinary(provisionDir)
  if (cached !== undefined) return cached
  const key = platformKey()
  if (key === undefined) return undefined
  const inFlight = pending.get(provisionDir)
  if (inFlight !== undefined) return inFlight
  const task = run(provisionDir, key, { ...options, indexUrl: settings.indexUrl ?? VERSION_ENDPOINT })
    .finally(() => pending.delete(provisionDir))
  pending.set(provisionDir, task)
  return task
}

/**
 * One provisioning attempt: index → archive → extract → marker.
 *
 * @param {string} provisionDir - cache root.
 * @param {string} key - platform key.
 * @param {{ log?: (message: string) => void, timeoutMs?: number, indexUrl?: string }} options - hooks.
 * @returns {Promise<string>} executable path.
 */
async function run(provisionDir, key, options) {
  const log = options.log ?? progressTo(process.stderr)
  const timeoutMs = options.timeoutMs ?? 900_000
  log(`no browser found; fetching Chrome for Testing (${key})`)

  const archive = pickArchive(await fetchJson(options.indexUrl ?? VERSION_ENDPOINT, timeoutMs), key)
  if (archive === undefined) throw new Error(`the Chrome for Testing index lists no build for ${key}`)

  mkdirSync(provisionDir, { recursive: true })
  const stage = join(provisionDir, `.incoming-${process.pid}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  const zipPath = join(stage, 'archive.zip')

  log(`downloading ${archive.version}`)
  await downloadTo(archive.url, zipPath, timeoutMs, log)
  const bytes = readFileSync(zipPath)
  log(`extracting ${(bytes.length / 1_048_576).toFixed(0)} MB`)

  const buildDir = join(stage, 'build')
  extractZip(bytes, buildDir, { executableSuffixes: ['/chrome', '/chrome.exe', '/Google Chrome for Testing'] })
  const binary = binaryIn(buildDir, key)
  if (!existsSync(binary)) throw new Error(`the archive did not contain ${key} at ${binary}`)

  const versionDir = join(provisionDir, archive.version)
  rmSync(versionDir, { recursive: true, force: true })
  renameSync(buildDir, versionDir)
  const finalPath = binaryIn(versionDir, key)
  writeFileSync(join(provisionDir, 'current.json'), `${JSON.stringify({ version: archive.version, platform: key, path: finalPath }, null, 2)}\n`)
  rmSync(stage, { recursive: true, force: true })
  log(`ready: ${finalPath}`)
  return finalPath
}

/**
 * `fetch` a small JSON document under a deadline.
 *
 * @param {string} url - request target.
 * @param {number} timeoutMs - deadline covering both headers and body.
 * @returns {Promise<unknown>} parsed body.
 */
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`the Chrome for Testing index returned HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Stream a URL to disk under one deadline.
 *
 * The `AbortController` must stay armed while the body streams. Clearing the
 * timer as soon as the response headers arrive is the classic bug here: a CDN
 * that stalls mid-body then hangs the tool call forever, which is exactly what
 * happened on the first real download.
 *
 * @param {string} url - request target.
 * @param {string} dest - file to write.
 * @param {number} timeoutMs - deadline covering the whole transfer.
 * @param {(message: string) => void} log - progress sink.
 * @returns {Promise<void>} resolves once the file is complete.
 */
async function downloadTo(url, dest, timeoutMs, log) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`the browser archive returned HTTP ${response.status}`)
    if (response.body === null) throw new Error('the browser archive returned an empty body')
    const total = Number(response.headers.get('content-length') ?? 0)
    let received = 0
    let nextReport = 0.25
    const source = Readable.fromWeb(response.body)
    source.on('data', (chunk) => {
      received += chunk.length
      if (total <= 0) return
      const share = received / total
      if (share >= nextReport) {
        log(`downloaded ${Math.round(share * 100)}%`)
        nextReport = Math.min(1, nextReport + 0.25)
      }
    })
    await pipeline(source, createWriteStream(dest))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Progress sink that writes to stderr, throttled by the caller's steps.
 *
 * A first-run download can take minutes; silence is indistinguishable from a
 * hang, and this runs inside a tool call, so it has to be visible in the app
 * log rather than returned to the model.
 *
 * @param {NodeJS.WriteStream} stream - destination stream.
 * @returns {(message: string) => void} sink.
 */
function progressTo(stream) {
  return (message) => {
    try {
      stream.write(`[web-browser] ${message}\n`)
    } catch {
      // A closed stream must never fail provisioning.
    }
  }
}

/**
 * Directory a provisioning run would write to, for messages and tests.
 *
 * @param {{ provisionDir?: string }} settings - normalized settings.
 * @returns {string} absolute directory.
 */
export function provisionDirectory(settings) {
  return settings.provisionDir ?? DEFAULT_PROVISION_DIR
}

/** Archive layout, exported for tests that check the lookup table. */
export { LAYOUT as ARCHIVE_LAYOUT }
