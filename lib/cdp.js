import { WebBrowserError, CODE } from './errors.js'

const OPEN_TIMEOUT_MS = 15000
const SEND_TIMEOUT_MS = 30000

/**
 * Minimal Chrome DevTools Protocol client over the WebSocket global.
 *
 * One connection drives exactly one target (a tab). The transport is the only
 * thing this bundle needs from Node besides `child_process`: no native module,
 * no third-party package, nothing that reads the user's prompt or memory.
 */
export class CdpConnection {
  /** @type {WebSocket | undefined} */
  #socket
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout, method: string }>} */
  #pending = new Map()
  /** @type {Map<string, Set<(params: any) => void>>} */
  #handlers = new Map()
  #nextId = 1
  #closed = false

  /**
   * Open a connection to a target WebSocket URL.
   *
   * @param {string} url - `webSocketDebuggerUrl` from the DevTools HTTP endpoint.
   * @param {{ timeoutMs?: number }} [options] - open deadline.
   * @returns {Promise<CdpConnection>} a ready connection.
   */
  static async connect(url, options = {}) {
    const connection = new CdpConnection()
    await connection.#open(url, options.timeoutMs ?? OPEN_TIMEOUT_MS)
    return connection
  }

  /**
   * @param {string} url - target socket.
   * @param {number} timeoutMs - open deadline in milliseconds.
   * @returns {Promise<void>} resolves once the socket is open.
   */
  #open(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      /** @type {WebSocket} */
      let socket
      try {
        socket = new WebSocket(url)
      } catch (error) {
        reject(new WebBrowserError('the DevTools socket could not be created', CODE.CDP_ERROR, { cause: error }))
        return
      }
      this.#socket = socket
      let settled = false
      const settle = (failure) => {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        if (failure !== undefined) reject(failure)
        return true
      }
      const timer = setTimeout(() => {
        if (settle(new WebBrowserError('timed out opening the DevTools socket', CODE.TIMEOUT))) {
          try { socket.close() } catch { /* already closing */ }
        }
      }, timeoutMs)
      socket.addEventListener('open', () => { if (settle(undefined)) resolve() })
      socket.addEventListener('error', (event) => {
        settle(new WebBrowserError('the DevTools socket failed to open', CODE.CDP_ERROR, { cause: event?.error ?? event }))
      })
      socket.addEventListener('message', (event) => this.#dispatch(event?.data))
      socket.addEventListener('close', () => this.#shutdown())
    })
  }

  /**
   * Send one DevTools command.
   *
   * @param {string} method - protocol method, e.g. `Page.navigate`.
   * @param {Record<string, unknown>} [params] - method parameters.
   * @param {{ timeoutMs?: number }} [options] - response deadline.
   * @returns {Promise<any>} the command result.
   */
  send(method, params = {}, options = {}) {
    if (this.#closed || this.#socket === undefined) {
      return Promise.reject(new WebBrowserError('the DevTools connection is closed', CODE.CDP_CLOSED))
    }
    const id = this.#nextId++
    const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new WebBrowserError(`${method} did not answer within ${timeoutMs} ms`, CODE.TIMEOUT))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new WebBrowserError(`${method} could not be sent`, CODE.CDP_CLOSED, { cause: error }))
      }
    })
  }

  /**
   * Listen for one protocol event.
   *
   * @param {string} event - protocol event name.
   * @param {(params: any) => void} handler - listener.
   * @returns {() => void} unsubscribe.
   */
  on(event, handler) {
    let set = this.#handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  /** Route an incoming frame to a pending command or an event listener. */
  #dispatch(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (typeof message?.id === 'number') {
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) {
        entry.reject(new WebBrowserError(`${entry.method} failed: ${message.error?.message ?? 'unknown protocol error'}`, CODE.CDP_ERROR))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    const handlers = this.#handlers.get(message?.method)
    if (handlers === undefined) return
    for (const handler of handlers) {
      try {
        handler(message.params)
      } catch {
        // A listener must never break the transport.
      }
    }
  }

  /** Fail every pending command once the socket is gone. */
  #shutdown() {
    if (this.#closed) return
    this.#closed = true
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new WebBrowserError('the DevTools connection closed', CODE.CDP_CLOSED))
    }
    this.#pending.clear()
  }

  /** Close the socket. Safe to call more than once. */
  close() {
    this.#shutdown()
    try {
      this.#socket?.close()
    } catch {
      // Already closed.
    }
  }
}
