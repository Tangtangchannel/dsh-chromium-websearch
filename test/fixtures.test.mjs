import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test } from './harness.mjs'
import { browserFixture } from './browser-fixture.mjs'
import { PageSession } from '../lib/page.js'
import { ENGINES, normalizeResults } from '../lib/search.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Open one fixture page and run an engine's extractor against it.
 *
 * @param {string} engine - engine id.
 * @param {string} fixture - fixture file name.
 * @param {number} [wanted] - result cap.
 * @returns {Promise<{ title: string, url: string, snippet?: string }[]>} normalized results.
 */
async function extractFixture(engine, fixture, wanted = 8) {
  const { host, settings } = await browserFixture()
  const page = await PageSession.open(host)
  try {
    const fileUrl = pathToFileURL(join(here, 'fixtures', fixture)).href
    await page.navigate(fileUrl, { timeoutMs: settings.navigateTimeoutMs })
    const raw = await page.evaluate(ENGINES[engine].extract, { timeoutMs: 8000 })
    return normalizeResults(raw, wanted)
  } finally {
    await page.close()
  }
}

test('bing extractor reads main results, drops schemes, ignores the sidebar', async () => {
  const results = await extractFixture('bing', 'bing.html')
  assert.deepEqual(results.map((entry) => entry.url), [
    'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    'https://nodejs.org/api/globals.html',
  ])
  assert.equal(results[0].snippet, 'The Fetch API provides an interface for fetching resources.')
})

test('duckduckgo extractor unwraps redirect links in the page', async () => {
  const results = await extractFixture('duckduckgo', 'duckduckgo.html')
  assert.deepEqual(results.map((entry) => entry.url), [
    'https://example.com/wrapped?a=1',
    'https://example.net/direct',
    'https://example.org/no-snippet',
  ])
  assert.equal(results[1].snippet, 'A snippet rendered in a div.')
  assert.equal(results[2].snippet, undefined)
})

test('baidu extractor prefers mu and data-tools over the redirect link', async () => {
  const results = await extractFixture('baidu', 'baidu.html')
  assert.deepEqual(results.map((entry) => entry.url), [
    'https://example.com/from-mu',
    'https://example.com/from-tools',
    'http://www.baidu.com/link?url=ghi',
  ])
  assert.equal(results[0].snippet, '摘要一。')
})

test('extracted results honour the requested cap', async () => {
  const results = await extractFixture('bing', 'bing.html', 1)
  assert.equal(results.length, 1)
})

test('fixtures contain no live-site dependencies', () => {
  for (const name of ['bing.html', 'duckduckgo.html', 'baidu.html']) {
    const body = readFileSync(join(here, 'fixtures', name), 'utf8')
    assert.ok(body.length > 200, `${name} should carry realistic markup`)
    assert.ok(!/https?:\/\/(?:www\.)?(?:bing|baidu|duckduckgo)\.com\/s/iu.test(body), `${name} must not embed a live search URL`)
  }
})
