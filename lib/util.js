import { WebBrowserError, CODE } from './errors.js'

/** Reject as soon as the caller's signal aborts. */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw new WebBrowserError('the web request was aborted', CODE.ABORTED)
}

/**
 * Sleep for a bounded time, waking early on cancellation.
 *
 * Declared `async` so an already-aborted signal becomes a rejected promise
 * instead of a synchronous throw, which keeps call sites uniform.
 *
 * @param {number} ms - delay.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @returns {Promise<void>} resolves after the delay or on abort.
 */
export async function sleep(ms, signal) {
  throwIfAborted(signal)
  if (!Number.isFinite(ms) || ms <= 0) return
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Collapse every run of whitespace (including CR/LF) into one space.
 *
 * @param {unknown} value - candidate text.
 * @returns {string} normalized text, or an empty string.
 */
export function collapse(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

/**
 * Cut a string to a character budget without splitting a code point.
 *
 * Counted in code points rather than UTF-16 units so an emoji counts as one
 * character and is never cut in half.
 *
 * @param {string} value - source text.
 * @param {number} limit - maximum characters.
 * @returns {string} the original text or a safe prefix ending in an ellipsis.
 */
export function truncate(value, limit) {
  if (limit <= 0) return ''
  const points = Array.from(value)
  if (points.length <= limit) return value
  return `${points.slice(0, limit - 1).join('')}…`
}
