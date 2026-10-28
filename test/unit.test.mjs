import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from './harness.mjs'
import { normalizeSettings, resolveChrome, chromeCandidates, missingBrowserHint, PROVIDER_ID } from '../lib/config.js'
import { unwrapRedirect, normalizeResults, engineUrl, ENGINE_NAMES } from '../lib/search.js'
import { looksLikeChallenge } from '../lib/fetch.js'
import { normalizeUrl } from '../lib/providers.js'
import { createJournal, hash } from '../lib/journal.js'
import { collapse, truncate, sleep } from '../lib/util.js'
import { WebBrowserError, CODE } from '../lib/errors.js'

const bingWrap = (url) => `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(url, 'utf8').toString('base64url')}&ntb=1`

test('provider id is the documented browser id', () => {
  assert.equal(PROVIDER_ID, 'browser')
})

test('duckduckgo redirect wrapper is unwrapped', () => {
  const target = 'https://example.com/article?a=1&b=2'
  const wrapped = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=xyz`
  assert.equal(unwrapRedirect(wrapped), target)
})

test('bing ck/a wrapper is unwrapped', () => {
  const target = 'https://example.org/deep/path?x=1'
  assert.equal(unwrapRedirect(bingWrap(target)), target)
})

test('google url wrapper is unwrapped', () => {
  assert.equal(unwrapRedirect('https://www.google.com/url?q=https%3A%2F%2Fexample.net%2Fp&sa=U'), 'https://example.net/p')
})

test('protocol-relative href becomes https', () => {
  assert.equal(unwrapRedirect('//example.com/path'), 'https://example.com/path')
})

test('non-http schemes and relative hrefs are rejected', () => {
  assert.equal(unwrapRedirect('javascript:alert(1)'), undefined)
  assert.equal(unwrapRedirect('data:text/html,hi'), undefined)
  assert.equal(unwrapRedirect('/search?q=x'), undefined)
  assert.equal(unwrapRedirect(''), undefined)
  assert.equal(unwrapRedirect(undefined), undefined)
})

test('results are deduplicated and validated', () => {
  const results = normalizeResults(
    [
      { title: '  First  result ', href: 'https://example.com/a', snippet: 'line one\nline two' },
      { title: 'duplicate', href: 'https://example.com/a', snippet: 'dup' },
      { title: 'bad', href: 'javascript:alert(1)' },
      { title: '', href: 'https://fallback.example/b', snippet: '' },
      { title: 'third', href: 'https://example.com/c' },
    ],
    8,
  )
  assert.equal(results.length, 3)
  assert.deepEqual(results[0], { title: 'First result', url: 'https://example.com/a', snippet: 'line one line two' })
  assert.equal(results[1].title, 'fallback.example')
  assert.equal(results[2].snippet, undefined)
})

test('result count is capped and text is clipped', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    title: `t${index}`,
    href: `https://example.com/${index}`,
    snippet: 'x'.repeat(1000),
  }))
  const results = normalizeResults(candidates, 5)
  assert.equal(results.length, 5)
  assert.ok(results[0].snippet.length <= 400)
  assert.ok(results[0].snippet.endsWith('…'))
})

test('engine urls are absolute and encode the query', () => {
  const settings = normalizeSettings({})
  for (const name of ENGINE_NAMES) {
    const url = engineUrl(name, '爱斯妥 凝胶', settings)
    assert.match(url, /^https:\/\//u)
    assert.ok(!url.includes(' '), `${name} url must be encoded`)
  }
  assert.throws(() => engineUrl('nope', 'x', settings), /unknown search engine/u)
})

test('settings fall back to defaults and ignore unknown keys', () => {
  const settings = normalizeSettings({ somethingNew: true, port: '99999', bodyFormat: 'HTML' })
  assert.equal(settings.port, 65535)
  assert.equal(settings.bodyFormat, 'html')
  assert.deepEqual(settings.engines, ['bing', 'duckduckgo', 'baidu'])
  assert.equal(settings.headless, false)
})

test('settings reject unknown engines and body formats', () => {
  assert.throws(() => normalizeSettings({ engines: ['altavista'] }), /no supported engine/u)
  assert.throws(() => normalizeSettings({ bodyFormat: 'markdown' }), /bodyFormat/u)
  assert.throws(() => normalizeSettings({ port: 'abc' }), /finite number/u)
})

test('duplicate engines collapse in order', () => {
  assert.deepEqual(normalizeSettings({ engines: ['duckduckgo', 'bing', 'duckduckgo'] }).engines, ['duckduckgo', 'bing'])
})

test('chrome path can come from the environment', () => {
  const previous = process.env.DSH_BROWSER_CHROME
  process.env.DSH_BROWSER_CHROME = '/tmp/fake-chrome'
  try {
    assert.equal(normalizeSettings({}).chromePath, '/tmp/fake-chrome')
    assert.equal(normalizeSettings({ chromePath: '/opt/chrome' }).chromePath, '/opt/chrome')
  } finally {
    if (previous === undefined) delete process.env.DSH_BROWSER_CHROME
    else process.env.DSH_BROWSER_CHROME = previous
  }
})

test('missing chrome is reported with actionable guidance', () => {
  const settings = normalizeSettings({ chromePath: '/definitely/not/here/chrome' })
  assert.equal(resolveChrome(settings), undefined)
  const hint = missingBrowserHint(settings)
  assert.match(hint, /chromePath/u)
  assert.match(hint, /DSH_BROWSER_CHROME/u)
  assert.ok(hint.includes('/definitely/not/here/chrome'))
  assert.equal(missingBrowserHint(normalizeSettings({})).includes('Tried:') || chromeCandidates().length === 0, true)
})

test('challenge detection distinguishes walls from real pages', () => {
  assert.equal(looksLikeChallenge('Just a moment...'), true)
  assert.equal(looksLikeChallenge('Checking your browser before accessing'), true)
  assert.equal(looksLikeChallenge('请稍候，正在验证'), true)
  assert.equal(looksLikeChallenge('This article explains how to detect a challenge page in a browser.'), false)
})

test('url normalization accepts only absolute http(s)', () => {
  assert.equal(normalizeUrl('https://example.com/a#b'), 'https://example.com/a#b')
  assert.equal(normalizeUrl('  http://example.com  '), 'http://example.com/')
  assert.equal(normalizeUrl('file:///etc/hosts'), undefined)
  assert.equal(normalizeUrl('example.com'), undefined)
  assert.equal(normalizeUrl(42), undefined)
})

test('collapse and truncate keep output tidy', () => {
  assert.equal(collapse('  a \n\t b  '), 'a b')
  assert.equal(truncate('abcdef', 10), 'abcdef')
  assert.equal(truncate('abcdef', 3), 'ab…')
  assert.equal(truncate('😀😀😀', 2), '😀…')
  assert.equal(truncate('😀', 1), '😀')
})

test('journal records a query hash but never the query text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-web-browser-'))
  try {
    const journal = createJournal({ journal: true, journalPath: join(directory, 'events.jsonl') })
    journal.record({ op: 'search', ok: true, count: 3, durationMs: 12, query: 'secret query' })
    journal.record({ op: 'fetch', ok: false, durationMs: 3, host: 'example.com', code: 'CDP_TIMEOUT' })
    const lines = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(!lines[0].includes('secret query'))
    assert.equal(JSON.parse(lines[0]).queryHash, hash('secret query'))
    assert.equal(JSON.parse(lines[1]).host, 'example.com')
    assert.equal(JSON.parse(lines[1]).ok, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('journal is silent when disabled', () => {
  const journal = createJournal({ journal: false, journalPath: '/nonexistent/never' })
  journal.record({ op: 'search', ok: true, durationMs: 1, query: 'x' })
  assert.equal(journal.path, undefined)
})

test('disabled journal on a read-only path never throws', () => {
  const journal = createJournal({ journal: true, journalPath: '/proc/definitely/not/writable/events.jsonl' })
  assert.doesNotThrow(() => journal.record({ op: 'search', ok: true, durationMs: 1, query: 'x' }))
})

test('abort signalling surfaces a stable code', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(sleep(5000, controller.signal), (error) => error instanceof WebBrowserError && error.code === CODE.ABORTED)
})

test('errors carry a routable code and a cause chain', () => {
  const cause = new Error('inner')
  const error = new WebBrowserError('outer', CODE.CDP_ERROR, { cause })
  assert.equal(error.name, 'WebBrowserError')
  assert.equal(error.code, CODE.CDP_ERROR)
  assert.equal(error.cause, cause)
  assert.ok(error instanceof Error)
})
