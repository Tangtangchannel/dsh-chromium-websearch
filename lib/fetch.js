import { WebBrowserError, CODE } from './errors.js'
import { PageSession } from './page.js'
import { collapse, sleep, throwIfAborted } from './util.js'

/** Text that appears on interstitial bot walls rather than on real pages. */
export const CHALLENGE_PATTERN = /just a moment|attention required|checking your browser|verify(?:ing)? (?:that )?you are (?:a )?human|please wait while we|enable javascript and cookies to continue|安全验证|人机验证|请稍候|访问验证/iu

/** Content types whose text can be read straight out of the rendered DOM. */
const READABLE_MIME = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|ecmascript))/iu

/**
 * Whether a page's visible text is a bot challenge instead of content.
 *
 * @param {string} text - visible page text.
 * @returns {boolean} true when the text looks like an interstitial.
 */
export function looksLikeChallenge(text) {
  return CHALLENGE_PATTERN.test(text) && text.length < 4000
}

/**
 * Script run inside the page: clone the document, drop non-content nodes, and
 * return the trimmed HTML plus the visible text.
 *
 * @param {number} limit - character cap applied to both outputs.
 * @returns {string} an expression evaluating to the page payload.
 */
function extractionScript(limit) {
  return `(() => {
    const cap = ${Math.max(1, Math.floor(limit))};
    const doc = document;
    const root = doc.documentElement;
    let html = '';
    let text = '';
    if (root) {
      const clone = root.cloneNode(true);
      for (const node of clone.querySelectorAll('script,style,noscript,template,svg,iframe,object,embed,link[rel="stylesheet"],meta[http-equiv="refresh"]')) {
        node.remove();
      }
      html = clone.outerHTML || '';
    }
    try {
      text = (doc.body ? doc.body.innerText : '') || '';
    } catch {
      text = '';
    }
    if (!text.trim() && root) {
      try { text = root.textContent || ''; } catch { text = ''; }
    }
    return {
      title: doc.title || '',
      url: location.href,
      mime: doc.contentType || '',
      html,
      text,
      htmlLength: html.length,
      textLength: text.length,
    };
  })()`
}

/**
 * Load a URL in a fresh tab and return its body for the web seam.
 *
 * @param {import('./chrome.js').BrowserHost} host - browser owner.
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @param {string} url - absolute http(s) URL supplied by the model.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ url: string, statusCode: number, body: { kind: 'html' | 'text', content: string }, truncated: boolean }>} the fetch result.
 */
export async function fetchInBrowser(host, settings, url, signal) {
  const page = await PageSession.open(host, signal)
  try {
    const nav = await page.navigate(url, { timeoutMs: settings.navigateTimeoutMs, signal })
    await sleep(settings.settleMs, signal)
    await clearChallenge(page, settings, signal)

    const mime = (nav.mimeType || '').toLowerCase()
    const payload = await page.evaluate(extractionScript(settings.maxBodyChars), { timeoutMs: 20000 })
    if (payload === undefined || payload === null) {
      throw new WebBrowserError('the page produced no readable content', CODE.PROVIDER_ERROR)
    }
    const visible = collapse(payload.text)
    if (looksLikeChallenge(visible)) {
      throw new WebBrowserError(
        'the site served a bot challenge that did not clear; it may require a login or a CAPTCHA in the browser window',
        CODE.PROVIDER_ERROR,
      )
    }
    const isHtml = mime.includes('html') || mime === ''
    if (!isHtml && !READABLE_MIME.test(mime)) {
      throw new WebBrowserError(
        `the browser cannot turn "${mime || 'unknown content type'}" into text; give the model a direct download link instead`,
        CODE.PROVIDER_ERROR,
      )
    }
    const kind = settings.bodyFormat === 'text' ? 'text' : settings.bodyFormat === 'auto' ? (isHtml ? 'html' : 'text') : (isHtml ? 'html' : 'text')
    const source = kind === 'html' ? payload.html : payload.text
    const content = typeof source === 'string' ? source : ''
    const originalLength = kind === 'html' ? payload.htmlLength : payload.textLength
    return {
      url: typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : url,
      statusCode: nav.status > 0 ? nav.status : 200,
      body: { kind, content: content.slice(0, settings.maxBodyChars) },
      truncated: Number(originalLength) > settings.maxBodyChars,
    }
  } finally {
    await page.close()
  }
}

/**
 * Wait out (then reload past) an interstitial. Real browsers pass most walls on
 * their own; the reload is a second chance for the ones that need a fresh load.
 *
 * @param {PageSession} page - attached tab.
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<void>} resolves once the wall is gone or the budget is spent.
 */
export async function clearChallenge(page, settings, signal) {
  if (settings.challengeTimeoutMs <= 0) return
  const deadline = Date.now() + settings.challengeTimeoutMs
  let reloaded = false
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    let text = ''
    try {
      text = await page.evaluate('(() => (document.body ? document.body.innerText : "").slice(0, 4000))()', { timeoutMs: 5000 })
    } catch {
      text = ''
    }
    if (!looksLikeChallenge(String(text))) return
    if (!reloaded && Date.now() + 3000 < deadline) {
      reloaded = true
      try {
        await page.reload({ timeoutMs: settings.navigateTimeoutMs, signal })
      } catch {
        // Keep polling; the reload is best effort.
      }
      continue
    }
    await sleep(600, signal)
  }
}
