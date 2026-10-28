/**
 * Error type shared by every module in this bundle.
 *
 * The web seam (`ctx.web`) documents failures as errors carrying a
 * machine-routable `code`. This bundle cannot import the harness' own error
 * class (plugin packages do not resolve the host's node_modules), so it
 * re-implements the same shape: a normal `Error` whose `code` is a stable
 * string and whose `cause` chains the underlying failure.
 */
export class WebBrowserError extends Error {
  /**
   * @param {string} message - human-readable detail; never contains a query or page body.
   * @param {string} code - machine-routable code consumed by the web seam.
   * @param {{ cause?: unknown }} [options] - chained failure.
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WebBrowserError'
    this.code = code
  }
}

/**
 * Thrown when the patch, the mode, or the profile cannot be honoured.
 *
 * Raised while the plugin is being applied (config normalization), before any
 * browser is touched, so the composition shows the misconfiguration instead of
 * a failed first search.
 */
export class WebBrowserConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WebBrowserConfigError'
  }
}

/** Stable codes this bundle throws. */
export const CODE = Object.freeze({
  /** Caller aborted the request. */
  ABORTED: 'WEB_ABORTED',
  /** Search or fetch could not be completed by the browser. */
  PROVIDER_ERROR: 'WEB_PROVIDER_ERROR',
  /** No Chromium-based browser binary was found. */
  BROWSER_NOT_FOUND: 'BROWSER_NOT_FOUND',
  /** Browser process started but published no DevTools endpoint. */
  BROWSER_START_FAILED: 'BROWSER_START_FAILED',
  /** Browser refused to open a tab. */
  BROWSER_TAB_FAILED: 'BROWSER_TAB_FAILED',
  /** DevTools protocol transport failure. */
  CDP_ERROR: 'CDP_ERROR',
  /** DevTools protocol transport closed. */
  CDP_CLOSED: 'CDP_CLOSED',
  /** A DevTools command or a page wait exceeded its deadline. */
  TIMEOUT: 'CDP_TIMEOUT',
  /** Page itself threw while the extractor ran. */
  PAGE_SCRIPT_ERROR: 'PAGE_SCRIPT_ERROR',
})

/**
 * True when a failure means "the caller cancelled", so it is rethrown as
 * `WEB_ABORTED` instead of being recorded as a provider failure.
 *
 * @param {unknown} error - caught failure.
 * @param {AbortSignal | undefined} signal - the request's signal.
 * @returns {boolean} whether the failure is a cancellation.
 */
export function isAborted(error, signal) {
  if (signal?.aborted === true) return true
  return error instanceof WebBrowserError && error.code === CODE.ABORTED
}
