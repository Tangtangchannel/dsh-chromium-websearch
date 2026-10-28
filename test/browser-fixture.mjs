import { BrowserHost } from '../lib/chrome.js'
import { normalizeSettings } from '../lib/config.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Workspace-local scratch directory. Tests must not write into the user's home
 * directory: the acceptance run is expected to be self-contained, and a sandbox
 * may deny writes outside the workspace anyway.
 */
export const scratch = join(packageRoot, '.tmp')

let shared

/**
 * One browser shared by every browser-backed test, so the suite pays a single
 * cold start and the acceptance run leaves nothing behind.
 *
 * @param {Record<string, unknown>} [overrides] - config overrides.
 * @returns {Promise<{ host: BrowserHost, settings: ReturnType<typeof normalizeSettings> }>} the shared host.
 */
export async function browserFixture(overrides = {}) {
  if (shared === undefined) {
    const settings = normalizeSettings({
      closeBrowserOnDispose: true,
      settleMs: 200,
      journal: false,
      userDataDir: join(scratch, 'profile'),
      ...overrides,
    })
    const host = new BrowserHost(settings)
    await host.endpoint()
    shared = { host, settings }
  }
  return shared
}

/** Stop the browser if this suite started it. */
export async function closeFixture() {
  if (shared === undefined) return
  await shared.host.dispose()
  shared = undefined
}
