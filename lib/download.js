import { createHash } from 'node:crypto'
import { mkdir, open as openFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

import { WebBrowserError, CODE } from './errors.js'
import { assertFetchableUrl } from './net-guard.js'
import { sleep, throwIfAborted } from './util.js'

/** Where downloads land when the caller does not choose a directory. */
export const DEFAULT_DOWNLOAD_DIR = join(homedir(), '.dsh', 'browser-web', 'downloads')

/**
 * Content types a download may write. Markup is refused on purpose: a login
 * wall or a bot challenge must not be saved as if it were the file, and a
 * `.html` written into a picture folder is a later privacy accident.
 */
export const ALLOWED_MIME = Object.freeze([
  /^image\//iu,
  /^video\//iu,
  /^audio\//iu,
  /^application\/(?:pdf|zip|x-zip-compressed|octet-stream|epub\+zip)$/iu,
])

/** Extension used when a content type has no obvious file suffix. */
const MIME_EXTENSION = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['application/pdf', '.pdf'],
  ['application/zip', '.zip'],
  ['application/octet-stream', '.bin'],
])

/** Suffixes kept when a URL already carries one; anything else is replaced. */
const SAFE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.bmp',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.pdf',
  '.zip',
])

const MAX_NAME_LENGTH = 120

/**
 * Whether a content type may be written to disk.
 *
 * @param {string} contentType - value of the `content-type` header, parameters allowed.
 * @param {readonly RegExp[]} [patterns] - accepted patterns.
 * @returns {boolean} true when the type is allowed.
 */
export function mimeAllowed(contentType, patterns = ALLOWED_MIME) {
  const value = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (value === '') return false
  return patterns.some((pattern) => pattern.test(value))
}

/**
 * Reduce a remote name to something safe to join onto a directory.
 *
 * @param {string} name - proposed file name (may come from a URL or a header).
 * @param {string} [fallback] - used when nothing usable survives.
 * @returns {string} a single path segment without separators or control bytes.
 */
export function sanitizeFilename(name, fallback = 'download') {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[/\\:*?"<>|]/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
  if (cleaned === '') return fallback
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned
  const ext = extname(cleaned)
  const base = cleaned.slice(0, cleaned.length - ext.length)
  const keep = Math.max(1, MAX_NAME_LENGTH - ext.length)
  return `${base.slice(0, keep)}${ext}`
}

/**
 * Pick a file suffix from the content type, falling back to the URL path.
 *
 * @param {string} url - resource URL.
 * @param {string} contentType - response content type.
 * @returns {string} `''` or a suffix starting with a dot.
 */
export function extensionFor(url, contentType) {
  const byMime = MIME_EXTENSION.get(String(contentType ?? '').split(';')[0].trim().toLowerCase())
  if (byMime !== undefined) return byMime
  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    return ''
  }
  const ext = extname(pathname).toLowerCase()
  return SAFE_EXTENSIONS.has(ext) ? ext : ''
}

/**
 * Derive the on-disk name for a resource.
 *
 * @param {string} url - resource URL.
 * @param {string} contentType - response content type.
 * @returns {string} a sanitized file name.
 */
export function filenameFor(url, contentType) {
  let stem = ''
  try {
    stem = decodeURIComponent(basename(new URL(url).pathname))
  } catch {
    stem = ''
  }
  const ext = extensionFor(url, contentType)
  const safe = sanitizeFilename(stem, '')
  if (safe !== '') {
    return extname(safe) === ext ? safe : `${safe}${ext}`
  }
  return `download${ext}`
}

/**
 * Create a file that did not exist before, adding `-1`, `-2`, … on collision.
 *
 * @param {string} dir - existing directory.
 * @param {string} name - sanitized file name.
 * @returns {Promise<{ path: string, handle: import('node:fs/promises').FileHandle }>} the opened file.
 */
async function openUnique(dir, name) {
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(dir, index === 0 ? name : `${base}-${index}${ext}`)
    try {
      return { path: candidate, handle: await openFile(candidate, 'wx') }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new WebBrowserError(`could not find a free file name for ${name} in ${dir}`, CODE.PROVIDER_ERROR)
}

/**
 * Download one URL to disk.
 *
 * The bytes never pass through the model: they are streamed straight from the
 * response into a file, hashed on the way, and only a summary is returned. The
 * caller supplies the browser's user agent, cookies, and Referer because
 * hotlink-protected hosts (pixiv's `i.pximg.net` is one) reject a bare request.
 *
 * @param {string} url - absolute http(s) URL.
 * @param {{
 *   dir?: string,
 *   referer?: string,
 *   headers?: Record<string, string>,
 *   maxBytes?: number,
 *   timeoutMs?: number,
 *   allowPrivateHosts?: boolean,
 *   patterns?: readonly RegExp[],
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 * }} [options] - target directory, request headers, and limits.
 * @returns {Promise<{ url: string, path: string, bytes: number, sha256: string, contentType: string, status: number }>} what landed on disk.
 */
export async function downloadToFile(url, options = {}) {
  assertFetchableUrl(url, { allowPrivateHosts: options.allowPrivateHosts === true })
  const dir = options.dir ?? DEFAULT_DOWNLOAD_DIR
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 60000
  const fetchImpl = options.fetchImpl ?? fetch
  const patterns = options.patterns ?? ALLOWED_MIME

  await mkdir(dir, { recursive: true })

  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal !== undefined) {
    if (options.signal.aborted) forwardAbort()
    else options.signal.addEventListener('abort', forwardAbort, { once: true })
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`download of ${url} timed out after ${timeoutMs} ms`)),
    timeoutMs,
  )

  try {
    const headers = { accept: '*/*', ...options.headers }
    if (options.referer !== undefined && options.referer !== '') headers.referer = options.referer

    let response
    try {
      response = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new WebBrowserError(`download of ${url} aborted`, CODE.TIMEOUT)
      throw new WebBrowserError(`the download request failed: ${error?.message ?? error}`, CODE.PROVIDER_ERROR)
    }

    if (!response.ok) {
      throw new WebBrowserError(`the server answered ${response.status} for ${url}`, CODE.PROVIDER_ERROR)
    }
    const contentType = String(response.headers.get('content-type') ?? '')
    if (!mimeAllowed(contentType, patterns)) {
      throw new WebBrowserError(
        `refusing to save ${contentType === '' ? 'a response with no content type' : contentType}: ${url}`,
        CODE.PROVIDER_ERROR,
      )
    }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WebBrowserError(
        `refusing to save ${declared} bytes (limit ${maxBytes}): ${url}`,
        CODE.PROVIDER_ERROR,
      )
    }

    const { path, handle } = await openUnique(dir, filenameFor(url, contentType))
    const hash = createHash('sha256')
    let bytes = 0
    try {
      if (response.body !== null && response.body !== undefined) {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength
          if (bytes > maxBytes) {
            throw new WebBrowserError(`refusing to save more than ${maxBytes} bytes: ${url}`, CODE.PROVIDER_ERROR)
          }
          hash.update(chunk)
          await handle.write(chunk)
        }
      }
      await handle.close()
    } catch (error) {
      await handle.close().catch(() => {})
      await rm(path, { force: true })
      throw error
    }

    return {
      url,
      path,
      bytes,
      sha256: hash.digest('hex'),
      contentType: contentType.split(';')[0].trim().toLowerCase(),
      status: response.status,
    }
  } finally {
    clearTimeout(timer)
    if (options.signal !== undefined) options.signal.removeEventListener('abort', forwardAbort)
  }
}

/**
 * Turn a cookie list into a request header value.
 *
 * @param {{ name?: string, value?: string }[]} cookies - cookies from the browser session.
 * @returns {string} `name=value; …`, or `''` when there is nothing to send.
 */
export function cookieHeader(cookies) {
  const parts = []
  for (const cookie of cookies ?? []) {
    if (typeof cookie?.name !== 'string' || cookie.name === '') continue
    if (typeof cookie?.value !== 'string') continue
    parts.push(`${cookie.name}=${cookie.value}`)
  }
  return parts.join('; ')
}

/**
 * Build the `web_download` tool: fetch resources with the browser's identity
 * and write them into a directory instead of into the model's context.
 *
 * @param {{
 *   settings: any,
 *   journal: { record: (entry: any) => void },
 *   openSession: () => Promise<any>,
 * }} deps - settings, trace sink, and a way to borrow a tab.
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
export function createDownloadTool(deps) {
  const { settings, journal, openSession } = deps

  return {
    name: 'web_download',
    description:
      'Save files (images, video, audio, PDF, zip) from the web onto this machine without putting the bytes in the conversation. Uses the browser session\'s user agent and cookies and sends `referer` when given, which hotlink-protected hosts such as pixiv\'s i.pximg.net require. Returns the saved path, size, and sha256 for each file.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'one absolute http(s) URL to save' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'several URLs; they are downloaded one at a time with a polite pause',
        },
        referer: {
          type: 'string',
          description: 'page the resource is embedded in; sent as the Referer header, defaults to the resource origin',
        },
        dir: { type: 'string', description: 'absolute target directory; defaults to ~/.dsh/browser-web/downloads/<YYYYMMDD>' },
        dryRun: { type: 'boolean', description: 'only report what would be saved (status, type, size)' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
    },
    /**
     * @param {{ url?: string, urls?: string[], referer?: string, dir?: string, dryRun?: boolean }} raw - tool arguments.
     * @param {{ signal?: AbortSignal }} [exec] - execution context.
     * @returns {Promise<string>} a JSON report.
     */
    execute: async (raw, exec = {}) => {
      const requested = []
      if (typeof raw?.url === 'string' && raw.url !== '') requested.push(raw.url)
      if (Array.isArray(raw?.urls)) for (const entry of raw.urls) if (typeof entry === 'string' && entry !== '') requested.push(entry)
      const unique = [...new Set(requested)]
      if (unique.length === 0) throw new WebBrowserError('web_download needs at least one url', CODE.PROVIDER_ERROR)
      if (unique.length > settings.downloadMaxFiles) {
        throw new WebBrowserError(
          `refusing ${unique.length} downloads in one call (limit ${settings.downloadMaxFiles})`,
          CODE.PROVIDER_ERROR,
        )
      }

      const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
      const dir = typeof raw?.dir === 'string' && raw.dir !== '' ? raw.dir : join(settings.downloadDir, day)
      const started = Date.now()

      let session
      const files = []
      const failures = []
      try {
        session = await openSession()
        const userAgent = await session.evaluate('navigator.userAgent')
        for (const [index, url] of unique.entries()) {
          throwIfAborted(exec.signal)
          const startedOne = Date.now()
          try {
            const referer =
              typeof raw?.referer === 'string' && raw.referer !== ''
                ? raw.referer
                : `${new URL(url).origin}/`
            const headers = { 'user-agent': String(userAgent ?? ''), referer }
            const cookies = typeof session.cookies === 'function' ? cookieHeader(await session.cookies([url])) : ''
            if (cookies !== '') headers.cookie = cookies

            if (raw?.dryRun === true) {
              const head = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' })
              const declaredBytes = Number(head.headers.get('content-length') ?? Number.NaN)
              files.push({
                url,
                status: head.status,
                contentType: String(head.headers.get('content-type') ?? ''),
                bytes: Number.isFinite(declaredBytes) ? declaredBytes : null,
                bytesKnown: Number.isFinite(declaredBytes),
                wouldSave: head.ok,
              })
            } else {
              const saved = await downloadToFile(url, {
                dir,
                referer,
                headers,
                maxBytes: settings.downloadMaxBytes,
                timeoutMs: settings.downloadTimeoutMs,
                allowPrivateHosts: settings.allowPrivateHosts === true,
                signal: exec.signal,
              })
              files.push(saved)
              journal.record({ op: 'download', ok: true, host: new URL(url).host, bytes: saved.bytes, durationMs: Date.now() - startedOne })
            }
            if (index < unique.length - 1) await sleep(settings.downloadMinIntervalMs, exec.signal)
          } catch (error) {
            const code = error instanceof WebBrowserError ? error.code : 'ERROR'
            failures.push({ url, error: error?.message ?? String(error), code })
            journal.record({ op: 'download', ok: false, host: new URL(url).host, code, durationMs: Date.now() - startedOne })
          }
        }
      } finally {
        if (session !== undefined) await session.close().catch(() => {})
      }

      return JSON.stringify(
        {
          dir,
          dryRun: raw?.dryRun === true,
          saved: files.filter((entry) => entry.path !== undefined).length,
          files,
          failures,
          durationMs: Date.now() - started,
        },
        null,
        2,
      )
    },
  }
}
