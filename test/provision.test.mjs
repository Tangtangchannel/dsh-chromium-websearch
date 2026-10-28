import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { test } from './harness.mjs'
import { ARCHIVE_LAYOUT, binaryIn, pickArchive, platformKey } from '../lib/provision.js'
import { extractZip, listEntries } from '../lib/zip.js'

/**
 * Build a ZIP archive in memory, with stored (0) and deflated (8) entries.
 *
 * @param {{ name: string, data: string, method?: 0 | 8 }[]} entries - archive entries.
 * @returns {Buffer} the archive bytes.
 */
function buildZip(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 0
    const name = Buffer.from(entry.name, 'utf8')
    const payload = Buffer.from(entry.data, 'utf8')
    const body = method === 8 ? deflateRawSync(payload) : payload

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(method, 8)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(payload.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(method, 10)
    record.writeUInt32LE(body.length, 20)
    record.writeUInt32LE(payload.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)

    local.push(header, name, body)
    central.push(record, name)
    offset += header.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

test('zip reader lists stored and deflated entries', () => {
  const archive = buildZip([
    { name: 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', data: 'binary' },
    { name: 'README', data: 'hello zip '.repeat(20), method: 8 },
  ])
  const entries = listEntries(archive)
  assert.equal(entries.length, 2)
  assert.equal(entries[1].method, 8)
})

test('zip extraction writes files and marks executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-browser-zip-'))
  try {
    const archive = buildZip([
      { name: 'chrome-linux64/chrome', data: '#!/bin/sh\n', method: 8 },
      { name: 'chrome-linux64/resources/readme.txt', data: 'plain' },
    ])
    extractZip(archive, root, { executableSuffixes: ['/chrome'] })
    assert.equal(readFileSync(join(root, 'chrome-linux64/resources/readme.txt'), 'utf8'), 'plain')
    const mode = statSync(join(root, 'chrome-linux64/chrome')).mode & 0o111
    assert.notEqual(mode, 0, 'the executable bit is set for chrome')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('zip extraction refuses path traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-browser-zip-'))
  try {
    const archive = buildZip([{ name: '../escape.txt', data: 'nope' }])
    assert.throws(() => extractZip(archive, root), /escapes the destination/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('platform keys follow the Chrome for Testing index', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'mac-arm64')
  assert.equal(platformKey('darwin', 'x64'), 'mac-x64')
  assert.equal(platformKey('linux', 'x64'), 'linux64')
  assert.equal(platformKey('win32', 'x64'), 'win64')
  assert.equal(platformKey('freebsd', 'x64'), undefined)
})

test('archive selection reads the stable channel only', () => {
  const index = {
    channels: {
      Stable: {
        version: '141.0.7390.54',
        downloads: { chrome: [{ platform: 'mac-x64', url: 'https://example.invalid/mac-x64.zip' }] },
      },
      Beta: { version: '142.0.0.0', downloads: { chrome: [{ platform: 'mac-x64', url: 'https://example.invalid/beta.zip' }] } },
    },
  }
  assert.deepEqual(pickArchive(index, 'mac-x64'), { version: '141.0.7390.54', url: 'https://example.invalid/mac-x64.zip' })
  assert.equal(pickArchive(index, 'linux64'), undefined)
  assert.equal(pickArchive({}, 'mac-x64'), undefined)
})

test('binary layout matches the official archives', () => {
  assert.equal(
    binaryIn('/cache/141.0.7390.54', 'mac-x64'),
    join('/cache/141.0.7390.54', 'mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  )
  assert.equal(binaryIn('/cache/141.0.7390.54', 'linux64'), join('/cache/141.0.7390.54', 'chrome-linux64', 'chrome'))
  assert.equal(binaryIn('/cache/141.0.7390.54', 'win64'), join('/cache/141.0.7390.54', 'chrome-win64', 'chrome.exe'))
  assert.deepEqual(Object.keys(ARCHIVE_LAYOUT).sort(), ['linux64', 'mac-arm64', 'mac-x64', 'win32', 'win64'])
})
