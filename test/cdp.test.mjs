import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'

import { test } from './harness.mjs'
import { CdpConnection } from '../lib/cdp.js'
import { WebBrowserError, CODE } from '../lib/errors.js'

/*
 * CDP transport smoke test: a real WebSocket handshake and framing, no browser.
 *
 * It exists for version detection: `lib/cdp.js` builds its connection on the
 * global `WebSocket`, which only exists from Node 21 on (stable in 22). Every
 * other offline suite is pure logic and passes on Node 20, so without this file
 * the CI matrix could keep an engine the bundle cannot actually run on.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// One unmasked text frame: servers never mask, so the mask bit stays clear.
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, payload])
}

// Decode the masked frames a client sends. CDP commands stay under 64 KiB, so
// the 7-bit and 16-bit payload lengths are enough.
function decodeFrames(buffer) {
  const frames = []
  let rest = buffer
  while (rest.length >= 2) {
    const opcode = rest[0] & 0x0f
    const masked = (rest[1] & 0x80) !== 0
    let length = rest[1] & 0x7f
    let offset = 2
    if (length === 126) { if (rest.length < 4) break; length = rest.readUInt16BE(2); offset = 4 }
    const keyLength = masked ? 4 : 0
    if (rest.length < offset + keyLength + length) break
    const key = masked ? rest.subarray(offset, offset + 4) : undefined
    offset += keyLength
    const payload = Buffer.from(rest.subarray(offset, offset + length))
    if (key !== undefined) for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index % 4]
    rest = rest.subarray(offset + length)
    if (opcode === 0x1) frames.push(payload.toString('utf8'))
  }
  return { frames, rest }
}

// Answer one CDP method and echo the id; "Failing.method" answers with an error.
function startCdpServer() {
  const sockets = new Set()
  const server = http.createServer((_request, response) => { response.writeHead(426); response.end() })
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => { /* the client closing first is normal */ })
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const decoded = decodeFrames(buffer)
      buffer = decoded.rest
      for (const frame of decoded.frames) {
        const message = JSON.parse(frame)
        const reply = message.method === 'Failing.method'
          ? { id: message.id, error: { message: 'no such method' } }
          : { id: message.id, result: { echo: message.method } }
        socket.write(textFrame(JSON.stringify(reply)))
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `ws://127.0.0.1:${server.address().port}/devtools/page/smoke`,
    // An upgraded socket is not tracked by http.Server#close, so close() would
    // wait forever without tearing them down first.
    close: () => new Promise((done) => {
      for (const open of sockets) open.destroy()
      sockets.clear()
      server.close(() => done())
    }),
  })))
}

test('CDP connection needs the Node 22 WebSocket global', () => {
  assert.equal(typeof WebSocket, 'function', 'this bundle requires Node 22+ (global WebSocket)')
})

test('CDP client connects, sends, and rejects after close', async () => {
  const server = await startCdpServer()
  try {
    const connection = await CdpConnection.connect(server.url, { timeoutMs: 5000 })
    const result = await connection.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 5000 })
    assert.deepEqual(result, { echo: 'Runtime.evaluate' })
    connection.close()
    await assert.rejects(
      () => connection.send('Runtime.evaluate', {}),
      (error) => error instanceof WebBrowserError && error.code === CODE.CDP_CLOSED,
    )
  } finally {
    await server.close()
  }
})

test('CDP client turns a protocol error into a routable code', async () => {
  const server = await startCdpServer()
  try {
    const connection = await CdpConnection.connect(server.url, { timeoutMs: 5000 })
    await assert.rejects(
      () => connection.send('Failing.method', {}, { timeoutMs: 5000 }),
      (error) => error instanceof WebBrowserError && error.code === CODE.CDP_ERROR && /no such method/u.test(error.message),
    )
    connection.close()
  } finally {
    await server.close()
  }
})
