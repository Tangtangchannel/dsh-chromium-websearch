import { WebBrowserError, CODE } from './errors.js'
import { fetchInBrowser } from './fetch.js'
import { assertFetchableUrl } from './net-guard.js'
import { searchInBrowser } from './search.js'

/**
 * Build the two `ctx.web` providers this bundle registers.
 *
 * Both are always `available()`: they can start the browser on demand, so a
 * cheap liveness probe would only convert a working request into a
 * "provider unavailable" error before the browser ever got a chance. Failures
 * are instead reported per request with an actionable message.
 *
 * @param {import('./chrome.js').BrowserHost} host - browser owner.
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @param {{ record: (entry: any) => void }} journal - trace sink.
 * @returns {{ search: WebProvider, fetch: WebProvider }} the providers.
 */
export function createProviders(host, settings, journal) {
  /** @type {WebProvider} */
  const search = {
    id: 'browser',
    label: 'Headful browser',
    available: () => true,
    ready: () => true,
    async search(request, signal) {
      const started = Date.now()
      try {
        const result = await searchInBrowser(host, settings, request, signal)
        journal.record({
          op: 'search',
          ok: true,
          engine: result.engine,
          count: result.sources.length,
          durationMs: Date.now() - started,
          query: String(request?.query ?? ''),
        })
        return result
      } catch (error) {
        journal.record({
          op: 'search',
          ok: false,
          durationMs: Date.now() - started,
          query: String(request?.query ?? ''),
          code: error instanceof WebBrowserError ? error.code : 'UNKNOWN',
        })
        throw error
      }
    },
  }

  /** @type {WebProvider} */
  const fetch = {
    id: 'browser',
    label: 'Headful browser',
    available: () => true,
    ready: () => true,
    async fetch(request, signal) {
      const started = Date.now()
      const url = normalizeUrl(request?.url)
      if (url === undefined) {
        throw new WebBrowserError('only absolute http(s) URLs can be fetched', CODE.PROVIDER_ERROR)
      }
      try {
        assertFetchableUrl(url, settings)
        const result = await fetchInBrowser(host, settings, url, signal)
        journal.record({
          op: 'fetch',
          ok: true,
          host: new URL(result.url).host,
          durationMs: Date.now() - started,
        })
        return result
      } catch (error) {
        journal.record({
          op: 'fetch',
          ok: false,
          host: safeHost(url),
          durationMs: Date.now() - started,
          code: error instanceof WebBrowserError ? error.code : 'UNKNOWN',
        })
        throw error
      }
    },
  }

  return { search, fetch }
}

/**
 * @typedef {object} WebProvider
 * @property {string} id - registry id.
 * @property {string} label - display label.
 * @property {() => boolean} available - cheap local check.
 * @property {() => boolean} ready - configuration-level check; must not touch the network.
 * @property {(request: any, signal?: AbortSignal) => Promise<any>} [search] - search implementation.
 * @property {(request: any, signal?: AbortSignal) => Promise<any>} [fetch] - fetch implementation.
 */

/**
 * Accept only absolute http(s) URLs; browsers treat anything else as a local
 * file or a script scheme.
 *
 * @param {unknown} value - model-supplied URL.
 * @returns {string | undefined} the normalized URL.
 */
export function normalizeUrl(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

/**
 * Host of a URL for tracing, without throwing on bad input.
 *
 * @param {string} url - absolute URL.
 * @returns {string | undefined} the host.
 */
function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}
