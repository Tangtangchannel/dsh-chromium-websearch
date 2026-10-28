import { CdpConnection } from './cdp.js'
import { WebBrowserError, CODE } from './errors.js'
import { sleep, throwIfAborted } from './util.js'

const READY_POLL_MS = 100

/**
 * One tab driven over the DevTools protocol.
 *
 * Every request gets its own tab and closes it afterwards. That keeps a failed
 * page from leaking state into the next search, and keeps the reused browser
 * process free of accumulated background documents.
 */
export class PageSession {
  /** @type {CdpConnection} */
  #cdp
  #host
  #targetId
  /** @type {string | undefined} */
  #frameId
  /** @type {{ status: number, mimeType: string, url: string } | undefined} */
  #document
  #closed = false

  /**
   * @param {{ cdp: CdpConnection, host: import('./chrome.js').BrowserHost, targetId: string, frameId?: string }} parts - assembled session.
   */
  constructor(parts) {
    this.#cdp = parts.cdp
    this.#host = parts.host
    this.#targetId = parts.targetId
    this.#frameId = parts.frameId
  }

  /**
   * Open a tab and attach to it.
   *
   * @param {import('./chrome.js').BrowserHost} host - browser owner.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<PageSession>} an attached session.
   */
  static async open(host, signal) {
    const target = await host.openTab(signal)
    throwIfAborted(signal)
    const cdp = await CdpConnection.connect(target.socketUrl)
    try {
      await cdp.send('Page.enable')
      await cdp.send('Network.enable')
      const session = new PageSession({ cdp, host, targetId: target.id })
      session.#watchDocument()
      const tree = await cdp.send('Page.getFrameTree')
      session.#frameId = tree?.frameTree?.frame?.id
      return session
    } catch (error) {
      cdp.close()
      await host.closeTab(target.id)
      throw error
    }
  }

  /** Record the main document's status and MIME type as the page loads. */
  #watchDocument() {
    this.#cdp.on('Network.responseReceived', (params) => {
      if (params?.type !== 'Document') return
      if (this.#frameId !== undefined && params.frameId !== this.#frameId) return
      this.#document = {
        status: Number(params.response?.status ?? 0),
        mimeType: String(params.response?.mimeType ?? ''),
        url: String(params.response?.url ?? ''),
      }
    })
  }

  /**
   * Load a URL and wait until the document is complete.
   *
   * @param {string} url - absolute http(s) URL.
   * @param {{ timeoutMs: number, signal?: AbortSignal }} options - deadline and cancellation.
   * @returns {Promise<{ status: number, mimeType: string, url: string }>} the main document's response.
   */
  async navigate(url, options) {
    this.#document = undefined
    const response = await this.#cdp.send('Page.navigate', { url }, { timeoutMs: options.timeoutMs })
    if (response?.errorText) {
      throw new WebBrowserError(`the page could not be loaded: ${response.errorText}`, CODE.PROVIDER_ERROR)
    }
    if (this.#frameId === undefined && typeof response?.frameId === 'string') this.#frameId = response.frameId
    await this.waitForReady(options.timeoutMs, options.signal)
    return this.#document ?? { status: 0, mimeType: '', url }
  }

  /**
   * Wait until `document.readyState` is `complete`.
   *
   * Polling is deliberate: a `Page.loadEventFired` listener can be missed by a
   * navigation that finishes before the listener is wired up, while a poll
   * always observes the final state.
   *
   * @param {number} timeoutMs - deadline.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<void>} resolves when ready.
   */
  async waitForReady(timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      try {
        const state = await this.evaluate('document.readyState', { timeoutMs: 5000 })
        if (state === 'complete') return
      } catch (error) {
        lastError = error
        if (error instanceof WebBrowserError && error.code === CODE.CDP_CLOSED) throw error
      }
      await sleep(READY_POLL_MS, signal)
    }
    if (lastError instanceof WebBrowserError) throw lastError
    throw new WebBrowserError(`the page did not finish loading within ${timeoutMs} ms`, CODE.TIMEOUT)
  }

  /**
   * Evaluate an expression in the page and return its JSON value.
   *
   * @param {string} expression - JavaScript source, evaluated as an expression.
   * @param {{ timeoutMs?: number, awaitPromise?: boolean }} [options] - protocol options.
   * @returns {Promise<any>} the value produced by the expression.
   */
  async evaluate(expression, options = {}) {
    const result = await this.#cdp.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise !== false,
        userGesture: false,
      },
      { timeoutMs: options.timeoutMs ?? 15000 },
    )
    if (result?.exceptionDetails !== undefined) {
      const description = String(result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'page script failed')
      throw new WebBrowserError(`page script failed: ${description.split('\n')[0]}`, CODE.PAGE_SCRIPT_ERROR)
    }
    return result?.result?.value
  }

  /**
   * Read the browser's cookies for the given URLs.
   *
   * Used by the download tool so a saved file is fetched with the same session
   * the page would have used (pixiv, for example, serves some originals only
   * to a logged-in cookie jar).
   *
   * @param {string[]} urls - absolute URLs whose cookies are wanted.
   * @returns {Promise<{ name: string, value: string, domain?: string }[]>} cookie records.
   */
  async cookies(urls) {
    const result = await this.#cdp.send('Network.getCookies', { urls }, { timeoutMs: 5000 })
    return Array.isArray(result?.cookies) ? result.cookies : []
  }

  /**
   * Reload the current document (used once when a bot challenge stalls).
   *
   * @param {{ timeoutMs: number, signal?: AbortSignal }} options - deadline and cancellation.
   * @returns {Promise<void>} resolves after the reload completes.
   */
  async reload(options) {
    await this.#cdp.send('Page.reload', {}, { timeoutMs: options.timeoutMs })
    await this.waitForReady(options.timeoutMs, options.signal)
  }

  /** Close this tab and its socket. Safe to call more than once. */
  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#cdp.close()
    await this.#host.closeTab(this.#targetId)
  }
}
