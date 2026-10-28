import { WebBrowserError, CODE } from './errors.js'

/**
 * Address checks applied to `web_fetch` targets before the browser navigates.
 *
 * The tool layer lets a model pass any http(s) URL, and this bundle then opens
 * that URL in a real browser — which, in `signed-in` and `personal` modes,
 * carries the user's cookies. Without this guard a model could be talked into
 * fetching `http://127.0.0.1:8080` or a LAN appliance and the page body would be
 * returned as tool output, so loopback and private ranges are refused by
 * default.
 *
 * The guard is deliberately a string/octet check, not a DNS lookup: the bundle
 * drives a real browser on purpose, and resolving hostnames ahead of time would
 * both add a probe the plugin exists to avoid and still be racy against a
 * second resolution inside Chromium. A hostname that only *resolves* to a
 * private address therefore passes here — the residual DNS-rebinding risk is
 * documented in SECURITY.md.
 */

/** Names that always mean this machine, regardless of platform resolver config. */
const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost'])

/**
 * Split a dotted-quad string into octets.
 *
 * @param {string} host - hostname that may be an IPv4 literal.
 * @returns {number[] | undefined} four octets, or undefined when not IPv4.
 */
function ipv4Octets(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) return undefined
  const octets = host.split('.').map((part) => Number(part))
  return octets.every((part) => part >= 0 && part <= 255) ? octets : undefined
}

/**
 * Whether an IPv4 literal falls in a loopback, private, link-local, or
 * otherwise non-public range.
 *
 * @param {number[]} octets - four octets.
 * @returns {boolean} true when the address is not reachable from the public internet.
 */
function isPrivateIPv4(octets) {
  const [a, b] = octets
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 carrier-grade NAT
  return false
}

/**
 * Whether an IPv6 literal is loopback, unique-local, or link-local.
 *
 * IPv4-mapped addresses (`::ffff:127.0.0.1`) are unwrapped and re-checked, since
 * a browser accepts them as the IPv4 address they carry.
 *
 * @param {string} host - IPv6 literal without brackets.
 * @returns {boolean} true when the address is not globally routable.
 */
function isPrivateIPv6(host) {
  const address = host.toLowerCase().split('%')[0] // strip a zone index such as %25en0
  if (address === '::' || address === '::1') return true
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address)
  if (mapped) {
    const octets = ipv4Octets(mapped[1])
    return octets === undefined ? true : isPrivateIPv4(octets)
  }
  // Compressed forms such as ::ffff:7f00:1 encode the same mapped IPv4 space.
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/u.test(address)) return true
  const first = Number.parseInt(address.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  return false
}

/**
 * Whether a hostname names this machine or a private network.
 *
 * @param {string} hostname - `URL.hostname` output, brackets included for IPv6.
 * @returns {boolean} true when the host is loopback, private, or link-local.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname).trim().toLowerCase().replace(/\.$/u, '')
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (LOOPBACK_NAMES.has(bare) || bare.endsWith('.localhost')) return true
  const octets = ipv4Octets(bare)
  if (octets !== undefined) return isPrivateIPv4(octets)
  if (bare.includes(':')) return isPrivateIPv6(bare)
  return false
}

/**
 * Refuse a fetch target that points at loopback or a private network.
 *
 * Called after `normalizeUrl()` so that function keeps its single job (scheme
 * and format), while the policy decision stays separate and unit-testable.
 *
 * @param {string} url - absolute, normalized http(s) URL.
 * @param {{ allowPrivateHosts?: boolean | string[] }} [settings] - normalized settings.
 * @throws {WebBrowserError} with `CODE.PROVIDER_ERROR` when the host is refused.
 * @returns {void}
 */
export function assertFetchableUrl(url, settings = {}) {
  const hostname = new URL(url).hostname
  if (!isPrivateHost(hostname)) return
  const allow = settings.allowPrivateHosts
  if (allow === true) return
  if (Array.isArray(allow)) {
    const host = hostname.trim().toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '')
    if (allow.some((entry) => String(entry).trim().toLowerCase().replace(/\.$/u, '') === host)) return
  }
  throw new WebBrowserError(
    `refusing to fetch a private or loopback address (${hostname}); set allowPrivateHosts to override`,
    CODE.PROVIDER_ERROR,
  )
}
