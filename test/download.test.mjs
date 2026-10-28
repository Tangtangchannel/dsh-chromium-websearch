import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from './harness.mjs'
import {
  cookieHeader,
  downloadToFile,
  extensionFor,
  filenameFor,
  mimeAllowed,
  sanitizeFilename,
} from '../lib/download.js'

/** Bytes that look like a JPEG to `file(1)`, short enough to inline. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024, 7)])

/**
 * Serve a fixed set of routes on loopback for the duration of one test.
 *
 * @param {(server: import('node:http').Server, base: string) => Promise<void>} body - test body.
 * @returns {Promise<void>} resolves after the server is closed.
 */
async function withServer(body) {
  const server = createServer((request, response) => {
    if (request.url === '/pic.jpg') {
      response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(JPEG.length) })
      response.end(JPEG)
      return
    }
    if (request.url === '/page.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>not an image</body></html>')
      return
    }
    if (request.url === '/big.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(5 * 1024 * 1024) })
      response.end(Buffer.alloc(5 * 1024 * 1024, 1))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  try {
    await body(server, `http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('mimeAllowed accepts media and refuses markup', () => {
  assert.equal(mimeAllowed('image/jpeg'), true)
  assert.equal(mimeAllowed('image/webp; q=1'), true)
  assert.equal(mimeAllowed('video/mp4'), true)
  assert.equal(mimeAllowed('application/pdf'), true)
  assert.equal(mimeAllowed('text/html'), false)
  assert.equal(mimeAllowed(''), false)
})

test('sanitizeFilename keeps one path segment', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
  assert.equal(sanitizeFilename('...hidden'), 'hidden')
  assert.equal(sanitizeFilename('  spaced  '), 'spaced')
  assert.equal(sanitizeFilename('bad\u0000name'), 'badname')
  assert.equal(sanitizeFilename('', 'fallback'), 'fallback')
  assert.equal(sanitizeFilename('.', 'fallback'), 'fallback')
  const long = sanitizeFilename(`${'x'.repeat(400)}.jpg`)
  assert.equal(long.length, 120)
  assert.equal(long.endsWith('.jpg'), true)
})

test('extensionFor prefers the content type', () => {
  assert.equal(extensionFor('https://cdn.example/a/1_0.png', 'image/jpeg'), '.jpg')
  assert.equal(extensionFor('https://cdn.example/a/1_0.png', ''), '.png')
  assert.equal(extensionFor('https://cdn.example/a/script', ''), '')
  assert.equal(extensionFor('https://cdn.example/a/file.php', ''), '')
})

test('filenameFor keeps a usable stem and suffix', () => {
  assert.equal(filenameFor('https://i.pximg.net/img/151210425_p0.jpg', 'image/jpeg'), '151210425_p0.jpg')
  assert.equal(filenameFor('https://cdn.example/art/1234.png', 'image/jpeg'), '1234.png.jpg')
  assert.equal(filenameFor('https://cdn.example/download', 'image/png'), 'download.png')
  assert.equal(filenameFor('https://cdn.example/', 'image/png'), 'download.png')
})

test('cookieHeader serializes cookies and skips junk', () => {
  assert.equal(cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2')
  assert.equal(cookieHeader([{ name: '', value: 'x' }, { name: 'ok', value: 'y' }]), 'ok=y')
  assert.equal(cookieHeader([]), '')
})

test('downloadToFile streams a file to disk and reports bytes and hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
  try {
    await withServer(async (_server, base) => {
      const saved = await downloadToFile(`${base}/pic.jpg`, { dir, allowPrivateHosts: true })
      assert.equal(saved.status, 200)
      assert.equal(saved.contentType, 'image/jpeg')
      assert.equal(saved.bytes, JPEG.length)
      assert.equal(saved.sha256, createHash('sha256').update(JPEG).digest('hex'))
      assert.equal(existsSync(saved.path), true)
      assert.deepEqual(readFileSync(saved.path), JPEG)
      assert.equal(saved.path.startsWith(dir), true)
      assert.equal(saved.path.endsWith('pic.jpg'), true)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadToFile refuses markup and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
  try {
    await withServer(async (_server, base) => {
      await assert.rejects(
        () => downloadToFile(`${base}/page.html`, { dir, allowPrivateHosts: true }),
        /refusing to save text\/html/,
      )
      assert.deepEqual(readdirSync(dir), [])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadToFile enforces maxBytes while streaming', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
  try {
    await withServer(async (_server, base) => {
      await assert.rejects(
        () => downloadToFile(`${base}/big.bin`, { dir, allowPrivateHosts: true, maxBytes: 1024 * 1024 }),
        /refusing to save/,
      )
      assert.deepEqual(readdirSync(dir), [])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadToFile refuses loopback unless the guard is opened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
  try {
    await withServer(async (_server, base) => {
      await assert.rejects(() => downloadToFile(`${base}/pic.jpg`, { dir }), /private or loopback/)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadToFile reports a non-2xx response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-'))
  try {
    await withServer(async (_server, base) => {
      await assert.rejects(
        () => downloadToFile(`${base}/missing.jpg`, { dir, allowPrivateHosts: true }),
        /answered 404/,
      )
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply registers web_download with the tools service', async () => {
  const registered = []
  let disposed = 0
  const ctx = {
    web: {
      registerSearchProvider: () => () => {},
      registerFetchProvider: () => () => {},
    },
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => {
          disposed += 1
        }
      },
    },
    effect: (factory) => {
      const disposer = factory()
      return disposer
    },
  }
  const { apply } = await import('../index.js')
  const dispose = apply(ctx, { journal: false })
  assert.equal(disposed >= 0, true)
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'web_download')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(Array.isArray(tool.parameters.properties.urls.items) === false, true)
  assert.equal(tool.parameters.properties.urls.type, 'array')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(typeof tool.output.render, 'function')
  if (typeof dispose === 'function') await dispose()
})
