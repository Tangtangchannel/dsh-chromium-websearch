import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

import { test } from './harness.mjs'
import { scratch } from './browser-fixture.mjs'
import { BrowserHost } from '../lib/chrome.js'
import { normalizeSettings } from '../lib/config.js'
import { searchInBrowser } from '../lib/search.js'
import { fetchInBrowser } from '../lib/fetch.js'
import { createProviders } from '../lib/providers.js'
import { createJournal } from '../lib/journal.js'
import { markerPath } from '../lib/modes.js'

/**
 * Live settings: real engines, real timeouts, a scratch profile unique to one
 * test. Sharing a profile across tests would make each test depend on whether
 * the previous browser had finished shutting down.
 *
 * @param {string} directory - per-test scratch directory.
 * @param {Record<string, unknown>} [overrides] - config overrides.
 * @returns {ReturnType<typeof normalizeSettings>} settings.
 */
function liveSettings(directory, overrides = {}) {
  return normalizeSettings({
    engines: ['bing', 'duckduckgo'],
    searchTimeoutMs: 60000,
    fetchTimeoutMs: 60000,
    settleMs: 300,
    closeBrowserOnDispose: true,
    journal: false,
    userDataDir: join(directory, 'profile'),
    ...overrides,
  })
}

/**
 * Run a body against a fresh browser host on its own profile, then tear both
 * down. The directory is removed even when the body throws.
 *
 * @param {Record<string, unknown>} overrides - config overrides.
 * @param {(context: { host: BrowserHost, settings: ReturnType<typeof normalizeSettings>, directory: string }) => Promise<void>} body
 * @returns {Promise<void>} resolves after cleanup.
 */
async function withBrowser(overrides, body) {
  const directory = mkdtempSync(join(scratch, 'live-'))
  const settings = liveSettings(directory, overrides)
  const host = new BrowserHost(settings)
  try {
    await body({ host, settings, directory })
  } finally {
    await host.dispose()
    // The browser writes into its profile while shutting down; removing the
    // directory immediately can therefore race with its own writes.
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
}

/**
 * Find the browser process that is holding one profile.
 *
 * @param {string} profileDir - user data directory.
 * @returns {number | undefined} its pid.
 */
function browserPid(profileDir) {
  const output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/u)
    if (match === null) continue
    if (!match[2].includes('--remote-debugging-port')) continue
    if (!match[2].includes(`--user-data-dir=${profileDir}`)) continue
    return Number(match[1])
  }
  return undefined
}

test('live search returns https sources for a plain query', async () => {
  await withBrowser({}, async ({ host, settings }) => {
    const result = await searchInBrowser(host, settings, { query: 'example domain', maxResults: 5 })
    assert.ok(result.sources.length >= 1, 'expected at least one source')
    assert.equal(typeof result.truncated, 'boolean', 'truncated must be present for the tool output schema')
    for (const source of result.sources) {
      assert.match(source.url, /^https?:\/\//u)
      assert.ok(source.title.length > 0)
    }
    assert.ok(
      result.sources.some((source) => source.url.includes('example.com') || source.url.includes('iana.org')),
      `expected a page about example domains, got ${result.sources.map((source) => source.url).join(', ')}`,
    )
  })
})

test('live fetch returns html for a plain page', async () => {
  await withBrowser({}, async ({ host, settings }) => {
    const result = await fetchInBrowser(host, settings, 'https://example.com/', undefined)
    assert.equal(result.statusCode, 200)
    assert.equal(result.body.kind, 'html')
    assert.match(result.body.content, /Example Domain/u)
    assert.match(result.url, /^https:\/\/example\.com\//u)
    assert.equal(result.truncated, false)
  })
})

test('providers satisfy the web seam and trace without leaking the query', async () => {
  await withBrowser({ journal: true, minResults: 1 }, async ({ host, settings, directory }) => {
    const journalPath = join(directory, 'events.jsonl')
    const journal = createJournal({ ...settings, journalPath })
    const providers = createProviders(host, settings, journal)
    try {
      assert.equal(providers.search.id, 'browser')
      assert.equal(providers.fetch.id, 'browser')
      assert.equal(providers.search.available(), true)
      assert.equal(providers.search.ready(), true)

      const query = 'iana example domain'
      const result = await providers.search.search({ query, maxResults: 4 }, undefined)
      assert.ok(result.sources.length >= 1)
      assert.equal(typeof result.truncated, 'boolean')

      const fetched = await providers.fetch.fetch({ url: 'https://example.com/' }, undefined)
      assert.equal(fetched.body.kind, 'html')

      const trace = readFileSync(journalPath, 'utf8')
      const lines = trace.trim().split('\n').map((line) => JSON.parse(line))
      assert.ok(lines.some((line) => line.op === 'search' && line.ok === true && line.count >= 1))
      assert.ok(lines.some((line) => line.op === 'fetch' && line.ok === true && line.host === 'example.com'))
      assert.ok(!trace.includes(query), 'journal must not contain the query text')
    } finally {
      journal.close()
    }
  })
})

test('providers reject a non-http url before touching the browser', async () => {
  await withBrowser({}, async ({ host, settings }) => {
    const providers = createProviders(host, settings, createJournal({ journal: false }))
    await assert.rejects(providers.fetch.fetch({ url: 'file:///etc/hosts' }), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      return true
    })
  })
})

test('a stale ownership marker does not send the host to a dead port', async () => {
  await withBrowser({}, async ({ host, settings }) => {
    mkdirSync(settings.userDataDir, { recursive: true })
    writeFileSync(
      join(settings.userDataDir, 'dsh-web-browser.json'),
      `${JSON.stringify({ endpoint: 'http://127.0.0.1:9', id: '00000000-0000-0000-0000-000000000000' })}\n`,
    )
    const endpoint = await host.endpoint()
    assert.notEqual(endpoint, 'http://127.0.0.1:9', 'a dead recorded endpoint must not be reused')
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.ok, true)
  })
})

test('a foreign browser on the configured port is not adopted', async () => {
  const first = mkdtempSync(join(scratch, 'foreign-a-'))
  const second = mkdtempSync(join(scratch, 'foreign-b-'))
  const a = new BrowserHost(liveSettings(first, { port: 9451 }))
  const endpointA = await a.endpoint()
  const b = new BrowserHost(liveSettings(second, { port: 9451 }))
  try {
    const endpointB = await b.endpoint()
    assert.notEqual(endpointB, endpointA, 'a browser from another profile must not be reused')
    const own = await fetch(`${endpointB}/json/version`, { signal: AbortSignal.timeout(5000) })
    assert.equal(own.ok, true)
  } finally {
    await b.dispose()
    await a.dispose()
    rmSync(first, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    rmSync(second, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

test('signed-in mode launches with session restore and searches normally', async () => {
  const directory = mkdtempSync(join(scratch, 'signed-'))
  const settings = liveSettings(directory, { mode: 'signed-in', markerDir: join(directory, 'markers') })
  const host = new BrowserHost(settings)
  try {
    assert.equal(settings.restoreSession, true, 'signed-in mode must ask Chrome to restore the session')
    const endpoint = await host.endpoint()
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u)
    const result = await searchInBrowser(host, settings, { query: 'example domain', maxResults: 3 })
    assert.ok(result.sources.length >= 1)
  } finally {
    await host.dispose()
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

test('personal mode drives an existing profile and writes no marker into it', async () => {
  const directory = mkdtempSync(join(scratch, 'personal-'))
  const profile = join(directory, 'Existing Chrome')
  const markers = join(directory, 'markers')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'Local State'), '{}\n')
  const settings = liveSettings(directory, {
    mode: 'personal',
    personalProfileDir: profile,
    userDataDir: undefined,
    markerDir: markers,
  })
  const host = new BrowserHost(settings)
  try {
    assert.equal(settings.userDataDir, profile)
    assert.equal(settings.externalProfile, true)
    const endpoint = await host.endpoint()
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u)
    assert.equal(existsSync(join(profile, 'dsh-web-browser.json')), false, 'the personal profile must stay untouched')
    assert.equal(existsSync(markerPath(profile, markers)), true, 'the marker belongs in the marker directory')
  } finally {
    await host.dispose()
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

test('a browser already published by this profile is reused', async () => {
  const directory = mkdtempSync(join(scratch, 'reuse-'))
  const settings = liveSettings(directory)
  const first = new BrowserHost(settings)
  const second = new BrowserHost(settings)
  try {
    const endpoint = await first.endpoint()
    assert.equal(await second.endpoint(), endpoint)
  } finally {
    await second.dispose()
    await first.dispose()
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

test('a browser that vanished between requests is replaced', async () => {
  await withBrowser({}, async ({ host, settings }) => {
    const first = await host.openTab()
    assert.equal(typeof first.id, 'string')
    const pid = browserPid(settings.userDataDir)
    assert.notEqual(pid, undefined, 'expected a browser process for the scratch profile')

    process.kill(pid, 'SIGKILL')
    // The killed browser leaves a stale profile lock behind, which is exactly
    // what the next launch has to tolerate.
    await new Promise((resolve) => setTimeout(resolve, 750))

    const second = await host.openTab()
    assert.equal(typeof second.id, 'string')
    assert.notEqual(second.id, first.id, 'the replacement must open a fresh tab')
    await host.closeTab(second.id)
  })
})
