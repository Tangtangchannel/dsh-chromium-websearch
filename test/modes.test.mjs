import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { test } from './harness.mjs'
import { normalizeSettings } from '../lib/config.js'
import {
  MODES,
  assertProfileIdle,
  legacyMarkerPath,
  markerPath,
  normalizeMode,
  profileLockOwner,
} from '../lib/modes.js'
import { WebBrowserConfigError } from '../lib/errors.js'

/**
 * Create a scratch directory that looks like a Chrome profile.
 *
 * @returns {string} profile directory.
 */
function fakeProfile() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-mode-'))
  writeFileSync(join(directory, 'Local State'), '{}\n')
  return directory
}

/**
 * Run one of this bundle's scripts the way the harness would.
 *
 * @param {string} script - script file name under scripts/.
 * @param {string[]} args - arguments.
 * @returns {{ status: number, stdout: string, stderr: string }} outcome.
 */
function runScript(script, args) {
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', script)
  try {
    const stdout = execFileSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

test('anonymous is the default mode and owns the historical profile', () => {
  const settings = normalizeSettings({})
  assert.equal(settings.mode, 'anonymous')
  assert.equal(settings.userDataDir, join(homedir(), '.dsh', 'browser-web', 'profile'))
  assert.equal(settings.loginWindow, false)
  assert.equal(settings.restoreSession, false)
  assert.equal(settings.externalProfile, false)
  assert.ok(settings.markerDir.endsWith(`${sep}markers`))
})

test('modes accept the A/B/C shorthand', () => {
  assert.equal(normalizeMode('A'), 'anonymous')
  assert.equal(normalizeMode('a'), 'anonymous')
  assert.equal(normalizeMode(' B '), 'signed-in')
  assert.equal(normalizeMode('c'), 'personal')
  assert.equal(normalizeMode(undefined), 'anonymous')
  assert.throws(() => normalizeMode('D'), (error) => {
    assert.ok(error instanceof WebBrowserConfigError)
    assert.match(error.message, /anonymous \(A\), signed-in \(B\), or personal \(C\)/u)
    return true
  })
})

test('signed-in mode uses its own profile and restores the session', () => {
  const settings = normalizeSettings({ mode: 'signed-in' })
  assert.equal(settings.mode, 'signed-in')
  assert.equal(settings.loginWindow, true)
  assert.equal(settings.restoreSession, true)
  assert.equal(settings.userDataDir, join(homedir(), '.dsh', 'browser-web', 'signed-in'))
  assert.notEqual(settings.userDataDir, normalizeSettings({}).userDataDir)
})

test('personal mode requires an existing profile and never creates one', () => {
  assert.throws(() => normalizeSettings({ mode: 'personal' }), /personalProfileDir/u)
  assert.throws(
    () => normalizeSettings({ mode: 'personal', personalProfileDir: join(tmpdir(), 'dsh-mode-missing') }),
    /does not exist/u,
  )
})

test('personal mode rejects a directory that is not a Chrome profile', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-mode-empty-'))
  try {
    assert.throws(
      () => normalizeSettings({ mode: 'personal', personalProfileDir: empty }),
      /does not look like a Chrome profile/u,
    )
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('personal mode accepts a real profile and keeps marker state outside it', () => {
  const profile = fakeProfile()
  try {
    const settings = normalizeSettings({ mode: 'personal', personalProfileDir: profile })
    assert.equal(settings.userDataDir, profile)
    assert.equal(settings.personalProfileDir, profile)
    assert.equal(settings.externalProfile, true)
    assert.equal(settings.loginWindow, true)
    assert.equal(settings.restoreSession, true)
    assert.equal(settings.markerDir.includes(profile), false, 'markers must not live inside the personal profile')
    assert.ok(settings.markerDir.endsWith(`${sep}markers`))
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('personal mode refuses two different profile targets', () => {
  const profile = fakeProfile()
  try {
    assert.throws(
      () => normalizeSettings({ mode: 'personal', personalProfileDir: profile, userDataDir: join(tmpdir(), 'other') }),
      /set only "personalProfileDir"/u,
    )
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('userDataDir wins over the mode default and expands ~', () => {
  const settings = normalizeSettings({ mode: 'signed-in', userDataDir: '~/elsewhere/profile' })
  assert.equal(settings.userDataDir, join(homedir(), 'elsewhere', 'profile'))
  assert.equal(settings.mode, 'signed-in')
  assert.throws(() => normalizeSettings({ userDataDir: 'relative/dir' }), /must be an absolute path/u)
})

test('a running Chrome lock blocks the launch with a clear message', () => {
  const profile = fakeProfile()
  try {
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'))
    assert.deepEqual(profileLockOwner(profile), { pid: process.pid, host: hostname() })
    assert.throws(() => assertProfileIdle(profile, 'personal'), /in use by a running Chrome/u)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('a lock left by a dead process is not an owner', () => {
  const profile = fakeProfile()
  try {
    symlinkSync(`${hostname()}-999999`, join(profile, 'SingletonLock'))
    assert.equal(profileLockOwner(profile), undefined)
    assert.doesNotThrow(() => assertProfileIdle(profile, 'anonymous'))
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('ownership markers are per profile and the legacy location stays readable', () => {
  const first = markerPath('/tmp/a/profile', '/tmp/a/markers')
  const second = markerPath('/tmp/b/profile', '/tmp/a/markers')
  assert.notEqual(first, second)
  assert.ok(first.startsWith('/tmp/a/markers'))
  assert.equal(legacyMarkerPath('/tmp/a/profile'), join('/tmp/a/profile', 'dsh-web-browser.json'))
})

test('the login helper refuses anonymous mode', () => {
  const outcome = runScript('login.mjs', ['--mode', 'anonymous'])
  assert.equal(outcome.status, 2)
  assert.match(outcome.stderr, /no sign-in window/u)
  assert.match(outcome.stderr, /--mode signed-in/u)
})

test('the login helper lists every mode without touching a browser', () => {
  const outcome = runScript('login.mjs', ['--list'])
  assert.equal(outcome.status, 0)
  for (const mode of Object.values(MODES)) assert.ok(outcome.stdout.includes(mode.id))
})

test('logout refuses to delete a personal profile', () => {
  const profile = fakeProfile()
  try {
    const outcome = runScript('logout.mjs', ['--profile', profile, '--yes'])
    assert.equal(outcome.status, 3)
    assert.match(outcome.stderr, /refusing to delete a personal Chrome profile/u)
    assert.equal(existsSync(join(profile, 'Local State')), true)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})

test('logout prints a plan instead of deleting without --yes', () => {
  const outcome = runScript('logout.mjs', [])
  // A live anonymous browser cannot be detected without a profile; when one is
  // running this returns 4 (close it first) instead of 1.
  assert.ok(outcome.status === 1 || outcome.status === 4, `unexpected status ${outcome.status}: ${outcome.stderr}`)
  if (outcome.status === 1) {
    assert.match(outcome.stdout, /would delete/u)
    assert.match(outcome.stdout, /--yes/u)
  }
})

test('modes keep their state under the bundle state root', async () => {
  const { STATE_ROOT } = await import('../lib/modes.js')
  assert.ok(STATE_ROOT.endsWith(`${sep}.dsh${sep}browser-web`))
  assert.equal(dirname(MODES.anonymous.profileDir), STATE_ROOT)
  assert.equal(dirname(MODES['signed-in'].profileDir), STATE_ROOT)
  assert.equal(MODES.personal.profileDir, undefined)
})
