import { WebBrowserError, CODE } from './errors.js'
import { PageSession } from './page.js'
import { clearChallenge } from './fetch.js'
import { collapse, sleep, throwIfAborted, truncate } from './util.js'

const TITLE_LIMIT = 200
const SNIPPET_LIMIT = 400
const POLL_MS = 300
const STABLE_POLLS = 4
const MIN_ENGINE_BUDGET_MS = 5000
const ENGINE_RETRY_PAUSE_MS = 500
const RETRY_PASS_MIN_MS = 3000

/**
 * Engine definitions. Each `extract` string runs inside the page and returns
 * raw `{ title, href, snippet }` candidates; URL cleaning happens in Node so it
 * can be unit-tested without a browser.
 */
export const ENGINES = Object.freeze({
  bing: {
    label: 'Bing',
    url: (query, settings) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(20, Math.max(settings.maxResults, 10))}&setlang=en`,
    extract: `(() => {
      const out = [];
      for (const item of document.querySelectorAll('#b_results > li.b_algo')) {
        const link = item.querySelector('h2 a[href]');
        if (!link) continue;
        const snippet = item.querySelector('.b_caption p, .b_snippet, .b_algoSlug, p');
        out.push({ title: link.textContent || '', href: link.href || '', snippet: snippet ? snippet.textContent : '' });
      }
      return out;
    })()`,
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    url: (query) => `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    extract: `(() => {
      const scope = document.querySelector('#links') || document;
      const out = [];
      for (const item of scope.querySelectorAll('.result, .web-result')) {
        const link = item.querySelector('a.result__a[href], h2 a[href]');
        if (!link) continue;
        const snippet = item.querySelector('.result__snippet, .result-snippet');
        out.push({
          title: link.textContent || '',
          href: link.getAttribute('href') || link.href || '',
          snippet: snippet ? snippet.textContent : '',
        });
      }
      return out;
    })()`,
  },
  baidu: {
    label: 'Baidu',
    url: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=20`,
    extract: `(() => {
      const out = [];
      for (const item of document.querySelectorAll('#content_left > div')) {
        const link = item.querySelector('h3 a[href]');
        if (!link) continue;
        let href = item.getAttribute('mu') || '';
        if (!href) {
          const tools = item.getAttribute('data-tools');
          if (tools) {
            try {
              const parsed = JSON.parse(tools);
              href = typeof parsed.url === 'string' ? parsed.url : '';
            } catch {
              href = '';
            }
          }
        }
        if (!href) href = link.href || '';
        const snippet = item.querySelector('.c-abstract, [class*="content-right"], .c-span-last');
        out.push({ title: link.textContent || '', href, snippet: snippet ? snippet.textContent : '' });
      }
      return out;
    })()`,
  },
})

/** Engine ids in the order a profile may prefer. */
export const ENGINE_NAMES = Object.freeze(Object.keys(ENGINES))

/**
 * Resolve the search URL for one engine.
 *
 * @param {string} name - engine id.
 * @param {string} query - model-supplied query.
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @returns {string} the URL to load.
 */
export function engineUrl(name, query, settings) {
  const engine = ENGINES[name]
  if (engine === undefined) throw new WebBrowserError(`unknown search engine "${name}"`, CODE.PROVIDER_ERROR)
  return engine.url(query, settings)
}

/**
 * Follow the redirect wrappers search engines put around result links.
 *
 * @param {string} href - raw href from the results page.
 * @returns {string | undefined} the destination URL, or undefined when it cannot be recovered.
 */
export function unwrapRedirect(href) {
  const raw = typeof href === 'string' ? href.trim() : ''
  if (raw.length === 0) return undefined
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw
  let parsed
  try {
    parsed = new URL(absolute)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname

  if (host.endsWith('duckduckgo.com') && path.startsWith('/l/')) {
    const target = parsed.searchParams.get('uddg')
    return target === null ? undefined : decodeURIComponent(target)
  }
  if (host.endsWith('bing.com') && path.startsWith('/ck/')) {
    const encoded = parsed.searchParams.get('u')
    if (encoded === null) return undefined
    const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded
    try {
      return Buffer.from(payload, 'base64url').toString('utf8')
    } catch {
      return undefined
    }
  }
  if ((host === 'www.google.com' || host === 'google.com') && path === '/url') {
    const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url')
    return target === null ? undefined : target
  }
  return absolute
}

/**
 * Clean, validate, deduplicate, and bound one engine's raw candidates.
 *
 * @param {{ title?: string, href?: string, snippet?: string }[]} candidates - extractor output.
 * @param {number} maxResults - hard cap.
 * @returns {{ title: string, url: string, snippet?: string }[]} marketable results.
 */
export function normalizeResults(candidates, maxResults) {
  const seen = new Set()
  const results = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = unwrapRedirect(candidate?.href)
    if (url === undefined || seen.has(url)) continue
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    const title = truncate(collapse(candidate.title) || parsed.hostname, TITLE_LIMIT)
    const snippet = truncate(collapse(candidate.snippet), SNIPPET_LIMIT)
    seen.add(url)
    results.push(snippet.length > 0 ? { title, url, snippet } : { title, url })
    if (results.length >= maxResults) break
  }
  return results
}

/**
 * Run one query through the preferred engines until one yields enough results.
 *
 * Engines are tried in order and each gets a slice of the remaining budget, so
 * a single blocked engine cannot consume the whole request.
 *
 * @param {import('./chrome.js').BrowserHost} host - browser owner.
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @param {{ query: string, maxResults?: number }} request - seam request.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ sources: { title: string, url: string, snippet?: string }[] }>} the search result.
 */
export async function searchInBrowser(host, settings, request, signal) {
  const query = typeof request?.query === 'string' ? request.query.trim() : ''
  if (query.length === 0) throw new WebBrowserError('the search query is empty', CODE.PROVIDER_ERROR)
  const maxResults = Math.min(settings.maxResults, Math.max(1, Number(request?.maxResults) || settings.maxResults))
  const deadline = Date.now() + settings.searchTimeoutMs
  const failures = []

  // Engines are visited in order. A second pass gives a transient miss (a
  // closed DevTools socket, a consent interstitial that cleared late, an engine
  // that was still rate-limiting) one more chance while the budget lasts.
  for (let pass = 0; pass < 2; pass += 1) {
    if (pass > 0) {
      if (deadline - Date.now() < RETRY_PASS_MIN_MS) break
      await sleep(ENGINE_RETRY_PAUSE_MS, signal)
    }
    for (const [index, name] of settings.engines.entries()) {
      throwIfAborted(signal)
      const remaining = deadline - Date.now()
      if (remaining <= 1000) break
      const enginesLeft = settings.engines.length - index
      const budget = Math.max(MIN_ENGINE_BUDGET_MS, Math.floor(remaining / enginesLeft))
      try {
        const sources = await searchOnce(host, settings, name, query, maxResults, Math.min(deadline, Date.now() + budget), signal)
        if (sources.length >= Math.min(settings.minResults, maxResults)) {
          // `truncated` is a required boolean in the tool's output schema: a
          // provider that omits it fails result serialization, not the search.
          return { sources, truncated: sources.length >= maxResults }
        }
        failures.push(`${name}: ${sources.length} result(s)`)
      } catch (error) {
        if (error instanceof WebBrowserError && error.code === CODE.ABORTED) throw error
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  throw new WebBrowserError(
    `no search engine produced enough results (${failures.join('; ')})`.slice(0, 900),
    CODE.PROVIDER_ERROR,
  )
}

/**
 * Drive one engine and poll its results page until it yields enough links.
 *
 * @param {import('./chrome.js').BrowserHost} host - browser owner.
 * @param {ReturnType<import('./config.js').normalizeSettings>} settings - normalized config.
 * @param {string} name - engine id.
 * @param {string} query - search query.
 * @param {number} wanted - result count to stop at.
 * @param {number} deadline - absolute stop time.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{ title: string, url: string, snippet?: string }[]>} normalized sources.
 */
async function searchOnce(host, settings, name, query, wanted, deadline, signal) {
  const page = await PageSession.open(host, signal)
  try {
    const nav = await page.navigate(engineUrl(name, query, settings), { timeoutMs: Math.max(5000, Math.min(settings.navigateTimeoutMs, deadline - Date.now())), signal })
    if (nav.status >= 400 && nav.status !== 429) {
      throw new WebBrowserError(`the engine answered HTTP ${nav.status}`, CODE.PROVIDER_ERROR)
    }
    await clearChallenge(page, settings, signal)
    let best = []
    let stable = 0
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const candidates = await page.evaluate(ENGINES[name].extract, { timeoutMs: 10000 })
      const results = normalizeResults(candidates, wanted)
      if (results.length > best.length) {
        best = results
        stable = 0
      } else {
        stable += 1
      }
      if (best.length >= wanted || stable >= STABLE_POLLS) break
      await sleep(POLL_MS, signal)
    }
    return best
  } finally {
    await page.close()
  }
}
