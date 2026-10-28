#!/usr/bin/env node
/**
 * Acceptance run for dsh-web-browser.
 *
 * Sections, in order:
 *   1. static   - repository hygiene, no secrets, no personal paths, no host imports
 *   2. unit     - pure logic (URL unwrapping, normalization, config, journal)
 *   3. fixtures - engine extractors against local HTML fixtures in a real browser
 *   4. live     - real search + fetch through the same code the provider uses
 *
 * Exits non-zero on the first failing section summary, so it is usable as a gate.
 * Run with the runtime's node binary:
 *   node ./scripts/accept.mjs            # everything
 *   node ./scripts/accept.mjs --skip-live
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runAll, reset } from '../test/harness.mjs'
import { closeFixture } from '../test/browser-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const args = new Set(process.argv.slice(2))
const skipBrowser = args.has('--skip-live')

/** Runtime files that must never contain machine paths, secrets, or memory references. */
const RUNTIME_FILES = ['index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'SECURITY.md', 'icon.svg']

/**
 * Walk a directory, returning files relative to the bundle root.
 *
 * @param {string} directory - absolute directory.
 * @returns {string[]} relative file paths.
 */
function walk(directory) {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...walk(absolute))
    else if (entry.isFile()) out.push(relative(root, absolute))
  }
  return out
}

/** Collected static findings; empty means clean. */
const findings = []

/**
 * Record a static violation.
 *
 * @param {string} file - offending file.
 * @param {string} message - what is wrong.
 */
function violation(file, message) {
  findings.push(`${file}: ${message}`)
}

/** Patterns assembled from fragments so this scanner does not match itself. */
const SECRET_PATTERNS = [
  { name: 'api key literal', re: new RegExp(`\\bsk-[A-Za-z0-9_-]{16,}`, 'u') },
  { name: 'bearer token', re: new RegExp(`\\bBearer\\s+[A-Za-z0-9._-]{16,}`, 'u') },
  { name: 'credential assignment', re: new RegExp(`(?:api[_-]?key|secret|password|passwd|token)\\s*[:=]\\s*["'][^"']{8,}["']`, 'iu') },
  { name: 'private key block', re: new RegExp('-----BEGIN [A-Z ]*PRIVATE KEY-----', 'u') },
]
const PERSONAL_PATH_PATTERNS = [
  { name: 'absolute user home path', re: new RegExp(`/Users/(?!<)[A-Za-z0-9._-]{2,}/`, 'u') },
  { name: 'windows user profile path', re: new RegExp(`[A-Za-z]:\\\\Users\\\\[A-Za-z0-9._-]{2,}\\\\`, 'u') },
]
const MEMORY_PATTERNS = [
  { name: 'harness memory file reference', re: new RegExp(['AGENTS', '\\.md'].join(''), 'u') },
  { name: 'credential store reference', re: new RegExp(['\\.credentials', 'yaml'].join(''), 'u') },
  { name: 'session log reference', re: new RegExp(['sessions', '/'].join(''), 'u') },
]

/** Check every runtime file plus the lib/, scripts/ and test/ trees for forbidden content. */
function scanRepository() {
  const files = [
    ...RUNTIME_FILES,
    ...(existsSync(join(root, 'lib')) ? walk(join(root, 'lib')) : []),
    ...(existsSync(join(root, 'scripts')) ? walk(join(root, 'scripts')) : []),
    ...(existsSync(join(root, 'test')) ? walk(join(root, 'test')) : []),
    ...walk(join(root, 'locale')),
  ]
  for (const file of files) {
    const absolute = join(root, file)
    if (!existsSync(absolute)) {
      violation(file, 'listed file does not exist')
      continue
    }
    const body = readFileSync(absolute, 'utf8')
    for (const { name, re } of SECRET_PATTERNS) if (re.test(body)) violation(file, `contains a ${name}`)
    for (const { name, re } of PERSONAL_PATH_PATTERNS) if (re.test(body)) violation(file, `contains an ${name}`)
    for (const { name, re } of MEMORY_PATTERNS) if (re.test(body)) violation(file, `contains a ${name}`)
  }
}

/**
 * Extract module specifiers from real import/export statements only.
 *
 * A line-based scan avoids matching `export const X = 'browser'`, which a
 * pattern over the whole file would misread as an import.
 *
 * @param {string} body - file contents.
 * @returns {string[]} specifiers.
 */
function importSpecifiers(body) {
  const specifiers = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!/^(?:import|export)\b/u.test(trimmed)) continue
    const from = /\bfrom\s*['"]([^'"]+)['"]/u.exec(trimmed)
    if (from !== null) {
      specifiers.push(from[1])
      continue
    }
    const bare = /^import\s*['"]([^'"]+)['"]/u.exec(trimmed)
    if (bare !== null) specifiers.push(bare[1])
  }
  return specifiers
}

/** Runtime imports must stay inside this bundle or in node: builtins. */
function scanImports() {
  const files = ['index.js', ...walk(join(root, 'lib'))]
  for (const file of files) {
    const body = readFileSync(join(root, file), 'utf8')
    for (const specifier of importSpecifiers(body)) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('./') || specifier.startsWith('../')) continue
      violation(file, `imports a non-relative, non-builtin module: ${specifier}`)
    }
  }
}

/** The manifest must describe files that exist and an icon that is redistributable. */
function scanManifest() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.type !== 'module') violation('package.json', 'must set "type": "module"')
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') violation('package.json', 'must declare dsh.bundle.patch')
  for (const entry of manifest.files ?? []) {
    const absolute = join(root, entry)
    if (!existsSync(absolute)) violation('package.json', `files entry is missing on disk: ${entry}`)
  }
  for (const key of ['.', './icon']) {
    const target = manifest.exports?.[key]
    if (typeof target !== 'string') violation('package.json', `exports["${key}"] is missing`)
    else if (!existsSync(join(root, target))) violation('package.json', `exports["${key}"] points at a missing file`)
  }
  const icon = join(root, 'icon.svg')
  if (!existsSync(icon)) violation('icon.svg', 'missing')
  else if (statSync(icon).size > 256 * 1024) violation('icon.svg', 'exceeds the 256 KiB icon limit')
  if (manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length > 0) {
    violation('package.json', 'must not declare runtime dependencies')
  }
}

/** The patch must pin both providers and stay portable. */
function scanPatch() {
  const body = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const active = body
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  for (const needle of [
    'searchProvider: browser',
    'fetchProvider: browser',
    "name: 'dsh-web-browser'",
    'mode: anonymous',
  ]) {
    if (!active.includes(needle)) violation('cordis.patch.yml', `missing "${needle}"`)
  }
  if (/^\s*chromePath\s*:/mu.test(active)) violation('cordis.patch.yml', 'must not pin a machine-specific chromePath')
  if (/^\s*personalProfileDir\s*:/mu.test(active)) {
    violation('cordis.patch.yml', 'must not ship a personal profile path; personal mode is opt-in per machine')
  }
}

/** Run the static section and report. */
function staticSection() {
  scanRepository()
  scanImports()
  scanManifest()
  scanPatch()
  if (findings.length === 0) {
    console.log('ok   static checks: no secrets, no personal paths, no host imports, manifest consistent')
    return true
  }
  console.log('FAIL static checks')
  for (const finding of findings) console.log(`     ${finding}`)
  return false
}

const sections = []

console.log('== static ==')
sections.push({ name: 'static', ok: staticSection() })

console.log('\n== unit ==')
await import('../test/unit.test.mjs')
await import('../test/modes.test.mjs')
const unit = await runAll({ filter: '' })
sections.push({ name: 'unit', ok: unit.failed === 0, ...unit })
reset()

console.log('\n== fixtures ==')
await import('../test/fixtures.test.mjs')
const fixtures = await runAll({ filter: '' })
sections.push({ name: 'fixtures', ok: fixtures.failed === 0, ...fixtures })
reset()

if (skipBrowser) {
  console.log('\n== live skipped by flag ==')
} else {
  console.log('\n== live ==')
  await import('../test/live.test.mjs')
  const live = await runAll({ filter: '', timeoutMs: 240000 })
  sections.push({ name: 'live', ok: live.failed === 0, ...live })
  reset()
}
// The fixtures section shares one browser whether or not the live section runs,
// so it is closed here rather than inside the live branch.
await closeFixture()
// Chrome's helper processes take a moment to exit after the main process is
// signalled; scanning immediately would report them as leaks.
await new Promise((resolve) => setTimeout(resolve, 1500))
const swept = sweepScratchBrowsers()
if (swept > 0) console.log(`\nswept ${swept} browser process(es) still holding the scratch profile`)

/**
 * Stop any Chromium still running against the workspace scratch profile.
 *
 * A browser that outlives its host keeps the CDP port busy and can make the
 * next run look like it reused a browser when it merely found a zombie, so the
 * acceptance run guarantees its own cleanup rather than trusting plugin
 * disposal alone.
 *
 * @returns {number} processes signalled.
 */
function sweepScratchBrowsers() {
  let listing = ''
  try {
    listing = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return 0
  }
  const marker = `--user-data-dir=${join(root, '.tmp', 'profile')}`
  let killed = 0
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null || !match[2].includes(marker)) continue
    try {
      process.kill(Number(match[1]), 'SIGTERM')
      killed += 1
    } catch {
      // Already gone.
    }
  }
  return killed
}

console.log('\n== summary ==')
let failed = 0
for (const section of sections) {
  const detail = section.total === undefined ? '' : ` (${section.total - section.failed}/${section.total} cases)`
  console.log(`${section.ok ? 'PASS' : 'FAIL'} ${section.name}${detail}`)
  if (!section.ok) failed += 1
}
const totalCases = sections.reduce((sum, section) => sum + (section.total ?? 0), 0)
console.log(`\n${failed === 0 ? 'ACCEPTED' : 'REJECTED'}: ${sections.length - failed}/${sections.length} sections, ${totalCases} cases`)
process.exit(failed === 0 ? 0 : 1)
