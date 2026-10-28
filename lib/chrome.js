import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { WebBrowserError, CODE } from './errors.js'
import { missingBrowserHint, resolveChrome } from './config.js'
import { provisionChrome } from './provision.js'
import { assertProfileIdle, displayPath, legacyMarkerPath, markerPath } from './modes.js'
import { sleep, throwIfAborted } from './util.js'

const ENDPOINT_PROBE_MS = 1500
const POLL_INTERVAL_MS = 150

/**
 * Owns the headful Chromium process and its DevTools HTTP endpoint.
 *
 * The browser is reused across requests so consecutive tool calls do not pay a
 * cold start. It always runs against a dedicated profile directory, never the
 * user's everyday browser profile, so their cookies and logins are not drawn
 * into a model turn.
 */
export class BrowserHost {
  /** @type {string | undefined} */
  #endpoint
  #ownedProcess = false
  /** @type {import('node:child_process').ChildProcess | undefined} */
  #child
  /** @type {Promise<string> | undefined} */
  #starting
  #disposed = false

  /** @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config. */
  constructor(settings) {
    this.settings = settings
  }

  /**
   * Base URL of the DevTools HTTP endpoint, starting the browser when needed.
   *
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} e.g. `http://127.0.0.1:9334`.
   */
  async endpoint(signal) {
    if (this.#disposed) throw new WebBrowserError('the browser host is disposed', CODE.BROWSER_START_FAILED)
    throwIfAborted(signal)
    if (this.#endpoint !== undefined) return this.#endpoint
    // A failed launch must not be memoised: the next request retries instead of
    // replaying the same rejection until the host restarts.
    this.#starting ??= this.#start().catch((error) => {
      this.#starting = undefined
      throw error
    })
    const endpoint = await this.#starting
    throwIfAborted(signal)
    return endpoint
  }

  /**
   * Download a browser when none is installed.
   *
   * Failure is not fatal here: the caller still has the "no browser" guidance,
   * and a provisioning error must not mask it with a stack trace.
   *
   * @returns {Promise<{ path: string, source: 'provisioned' } | undefined>} the binary.
   */
  async #provisionBrowser() {
    if (this.settings.autoProvision === false) return undefined
    try {
      const path = await provisionChrome(this.settings)
      return path === undefined ? undefined : { path, source: 'provisioned' }
    } catch {
      return undefined
    }
  }

  /**
   * Resolve a usable endpoint by reusing a live browser or launching one.
   *
   * @returns {Promise<string>} the endpoint base URL.
   */
  async #start() {
    // Reuse only a browser that our own profile published: a foreign DevTools
    // endpoint on the configured port must never become the browsing identity
    // (it could carry someone else's logins), so the ownership marker is the
    // authority, not the port number.
    const known = await probeOwnedBrowser(this.settings)
    if (known !== undefined) {
      this.#endpoint = known
      // Rewrite the marker at its current location: an upgrade from the legacy
      // in-profile marker is thus migrated the first time the browser is reused.
      await rememberOwnedBrowser(this.settings, known)
      return known
    }
    let binary = resolveChrome(this.settings)
    if (binary === undefined) {
      // Installing a plugin must not turn into "now go install a browser".
      // One automatic download keeps the first run working on a clean machine;
      // when even that fails the original guidance is what the caller sees.
      binary = await this.#provisionBrowser()
    }
    if (binary === undefined) {
      throw new WebBrowserError(missingBrowserHint(this.settings), CODE.BROWSER_NOT_FOUND)
    }
    // A live Chrome already holding the profile makes our process exit 0 (it
    // hands the profile over) and the launch would look like a timeout.
    assertProfileIdle(this.settings.userDataDir, this.settings.mode)
    mkdirSync(this.settings.userDataDir, { recursive: true })
    const port = await pickPort(this.settings.port)
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.settings.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-crashpad',
      '--disable-breakpad',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1280,900',
      'about:blank',
    ]
    // Chrome only keeps session-only cookies (the kind most sites hand out at
    // login) when the session is restored, so modes that allow a sign-in ask
    // for it explicitly.
    if (this.settings.restoreSession) args.unshift('--restore-last-session')
    if (this.settings.headless) args.unshift('--headless=new')
    let child
    try {
      child = spawn(binary.path, args, { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (error) {
      throw new WebBrowserError('the browser process could not be started', CODE.BROWSER_START_FAILED, { cause: error })
    }
    this.#ownedProcess = true
    this.#child = child
    child.on('error', () => { /* surfaced by the endpoint poll below */ })

    const deadline = Date.now() + this.settings.launchTimeoutMs
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      const fromPort = await probeEndpoint(port)
      if (fromPort !== undefined) {
        this.#endpoint = fromPort
        await rememberOwnedBrowser(this.settings, fromPort)
        return fromPort
      }
      const owned = await probeOwnedBrowser(this.settings)
      if (owned !== undefined) {
        this.#endpoint = owned
        return owned
      }
      // A quick exit with code 0 is how Chrome hands a profile over to an
      // instance that already owns it; that owner is still publishing its
      // DevTools port, so keep polling instead of failing the launch.
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new WebBrowserError(
          [
            `the browser exited with code ${child.exitCode} before publishing a DevTools endpoint.`,
            `Launching: ${binary.path}`,
            `Profile: ${displayPath(this.settings.userDataDir)}`,
            'If another instance already holds that profile, close it or set a different userDataDir.',
          ].join(' '),
          CODE.BROWSER_START_FAILED,
        )
      }
    }
    throw new WebBrowserError(
      [
        `the browser did not publish a DevTools endpoint within ${this.settings.launchTimeoutMs} ms.`,
        `Launching: ${binary.path}`,
        `Profile: ${displayPath(this.settings.userDataDir)}`,
        'If another instance already holds that profile, close it or set a different userDataDir/port.',
      ].join(' '),
      CODE.BROWSER_START_FAILED,
    )
  }

  /**
   * Open a fresh tab and return its DevTools socket.
   *
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ id: string, socketUrl: string }>} the new target.
   */
  async openTab(signal) {
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        // A browser can die right after it answers /json/version (crash, the OS
        // reclaiming it, a previous instance still shutting down). Forget the
        // cached endpoint so this pass re-reads the marker and, when nothing
        // live is left, launches a replacement.
        this.#endpoint = undefined
        this.#starting = undefined
        await sleep(250, signal)
      }
      const endpoint = await this.endpoint(signal)
      throwIfAborted(signal)
      try {
        const target = await createTarget(endpoint, { timeoutMs: attempt === 0 ? 4000 : 6000 })
        throwIfAborted(signal)
        return target
      } catch (error) {
        if (this.#disposed) throw error
        lastError = error
      }
    }
    throw lastError ?? new WebBrowserError('the browser did not open a tab', CODE.BROWSER_TAB_FAILED)
  }

  /** Close the tab opened for one request (best effort). */
  async closeTab(id) {
    if (this.#endpoint === undefined) return
    try {
      await fetch(`${this.#endpoint}/json/close/${encodeURIComponent(id)}`, { method: 'GET', signal: AbortSignal.timeout(3000) })
    } catch {
      // The tab may already be gone; that is the desired end state.
    }
  }

  /**
   * Release resources. Only a browser this host launched is ever killed; a
   * browser that was already running is left alone.
   */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    if (!this.#ownedProcess || !this.settings.closeBrowserOnDispose || this.#child === undefined) return
    try {
      // The browser was spawned detached, so its pid is a process-group leader;
      // signalling the group also stops its renderer and GPU helpers.
      process.kill(-this.#child.pid, 'SIGTERM')
    } catch {
      try {
        this.#child.kill('SIGTERM')
      } catch {
        // Nothing left to stop.
      }
    }
  }
}

/**
 * Ask a DevTools HTTP endpoint whether a browser is already listening.
 *
 * @param {number} port - debugging port.
 * @returns {Promise<string | undefined>} endpoint base URL when alive.
 */
export async function probeEndpoint(port) {
  const endpoint = `http://127.0.0.1:${port}`
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(ENDPOINT_PROBE_MS) })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body?.webSocketDebuggerUrl === 'string' ? endpoint : undefined
  } catch {
    return undefined
  }
}

/**
 * Browser identity published by a DevTools endpoint.
 *
 * The browser socket URL ends in a GUID that is stable for one browser instance,
 * so it distinguishes our browser from an unrelated one that happens to sit on
 * the same port.
 *
 * @param {string} endpoint - endpoint base URL.
 * @returns {Promise<{ endpoint: string, id: string } | undefined>} identity when alive.
 */
async function readBrowserIdentity(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(ENDPOINT_PROBE_MS) })
    if (!response.ok) return undefined
    const body = await response.json()
    const socket = body?.webSocketDebuggerUrl
    if (typeof socket !== 'string') return undefined
    const match = /\/devtools\/browser\/([0-9a-f-]+)/iu.exec(socket)
    if (match === null) return undefined
    return { endpoint, id: match[1] }
  } catch {
    return undefined
  }
}

/**
 * Record the browser this profile owns, best effort.
 *
 * Chrome does not always write `DevToolsActivePort` (it omits it when an
 * explicit `--remote-debugging-port` is passed), so the host records the
 * endpoint and identity itself. The marker lives outside the profile, so
 * driving a personal profile never writes into it.
 *
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @param {string} endpoint - endpoint base URL.
 * @returns {Promise<void>} resolves once written or skipped.
 */
async function rememberOwnedBrowser(settings, endpoint) {
  const identity = await readBrowserIdentity(endpoint)
  if (identity === undefined) return
  try {
    mkdirSync(settings.markerDir, { recursive: true, mode: 0o700 })
    const record = { endpoint, id: identity.id, pid: process.pid, mode: settings.mode, profile: settings.userDataDir }
    writeFileSync(markerPath(settings.userDataDir, settings.markerDir), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // A read-only marker directory only costs a cold start next time.
  }
}

/**
 * Endpoint of the live browser this profile owns, if any.
 *
 * A stale marker (crash, or the port since reused by an unrelated process) is
 * rejected because the browser identity no longer matches.
 *
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @returns {Promise<string | undefined>} endpoint base URL.
 */
async function probeOwnedBrowser(settings) {
  for (const path of [markerPath(settings.userDataDir, settings.markerDir), legacyMarkerPath(settings.userDataDir)]) {
    const endpoint = await readRecordedEndpoint(path)
    if (endpoint !== undefined) return endpoint
  }
  return undefined
}

/**
 * Live browser already running for these settings, without ever starting one.
 *
 * The administrative scripts use this to decide whether a profile is safe to
 * reset; the seam itself goes through {@link BrowserHost#endpoint}.
 *
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @returns {Promise<string | undefined>} endpoint base URL.
 */
export function recordedBrowser(settings) {
  return probeOwnedBrowser(settings)
}

/**
 * Endpoint recorded in one marker file, verified against the live browser.
 *
 * @param {string} path - marker file path.
 * @returns {Promise<string | undefined>} endpoint base URL.
 */
async function readRecordedEndpoint(path) {
  if (!existsSync(path)) return undefined
  let endpoint
  let id
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    endpoint = typeof record?.endpoint === 'string' ? record.endpoint : undefined
    id = typeof record?.id === 'string' ? record.id : undefined
  } catch {
    return undefined
  }
  if (endpoint === undefined || id === undefined) return undefined
  const identity = await readBrowserIdentity(endpoint)
  if (identity === undefined || identity.id !== id) return undefined
  return endpoint
}

/**
 * First free debugging port at or above the configured one.
 *
 * A foreign process may already hold the configured port; Chrome would then
 * report a DevTools endpoint on a different port than the one requested, so a
 * free port is chosen here and the host adopts whatever port the launched
 * browser actually publishes.
 *
 * @param {number} preferred - configured port.
 * @returns {Promise<number>} a port that is free right now.
 */
async function pickPort(preferred) {
  for (let port = preferred; port < Math.min(preferred + 10, 65536); port += 1) {
    if ((await probeEndpoint(port)) === undefined) return port
  }
  return preferred
}

/**
 * Build a tab-creation failure, marked when retrying could plausibly help.
 *
 * @param {string} message - what went wrong.
 * @param {unknown} [cause] - transport-level cause.
 * @returns {WebBrowserError} the error.
 */
function targetError(message, cause) {
  const error = new WebBrowserError(message, CODE.BROWSER_TAB_FAILED, cause === undefined ? undefined : { cause })
  // A transport failure or a 5xx means Chrome is not serving targets yet (it
  // publishes the port before it accepts target creation); anything else is a
  // settled refusal.
  error.transient = cause !== undefined || /HTTP 5\d\d/u.test(message)
  return error
}

/**
 * One pass at opening a tab: PUT first, GET for older builds.
 *
 * @param {string} endpoint - endpoint base URL.
 * @returns {Promise<{ id: string, socketUrl: string }>} the new target.
 */
async function attemptTarget(endpoint) {
  let lastError
  for (const method of ['PUT', 'GET']) {
    try {
      const response = await fetch(`${endpoint}/json/new?about:blank`, { method, signal: AbortSignal.timeout(8000) })
      if (!response.ok) {
        lastError = targetError(`the browser refused a new tab (HTTP ${response.status})`)
        continue
      }
      const body = await response.json()
      if (typeof body?.webSocketDebuggerUrl !== 'string' || typeof body?.id !== 'string') {
        lastError = targetError('the browser returned no DevTools socket for the new tab')
        continue
      }
      return { id: body.id, socketUrl: body.webSocketDebuggerUrl }
    } catch (error) {
      lastError = targetError('the browser did not answer the new-tab request', error)
    }
  }
  throw lastError ?? targetError('the browser refused a new tab')
}

/**
 * Open a tab through the DevTools HTTP API (`PUT /json/new`), retrying briefly
 * while the browser is still bringing its target list up.
 *
 * @param {string} endpoint - endpoint base URL.
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] - retry budget.
 * @returns {Promise<{ id: string, socketUrl: string }>} the new target.
 */
async function createTarget(endpoint, { timeoutMs = 6000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await attemptTarget(endpoint)
    } catch (error) {
      if (error?.transient !== true || Date.now() >= deadline) throw error
      // Distinguish "still starting" from "gone": a browser that no longer
      // serves /json/version is dead, and the caller should relaunch instead of
      // spending the retry budget on a socket nobody owns.
      if (!(await endpointIsServing(endpoint))) throw error
      await sleep(intervalMs)
    }
  }
}

/**
 * Cheap liveness probe used to separate a starting browser from a dead one.
 *
 * @param {string} endpoint - endpoint base URL.
 * @returns {Promise<boolean>} whether /json/version answers.
 */
async function endpointIsServing(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}
