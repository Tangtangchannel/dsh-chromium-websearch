import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/**
 * Minimal ZIP reader, enough for the Chrome-for-Testing archives.
 *
 * A dependency-free bundle cannot pull in an unzip library, and shelling out to
 * `unzip` is not portable (Windows, minimal containers). Only the two methods
 * that matter in practice are supported: stored (0) and deflate (8).
 *
 * Every entry path is sanitised: absolute paths, `..` segments and drive
 * letters are rejected, so a hostile archive cannot write outside `destDir`.
 */
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

// A downloaded archive is only checked structurally (no signature check), so
// the inflation step keeps its own ceiling. The factor covers archives whose
// binaries compress well; the floor keeps small archives with unusual ratios
// from being rejected for being small.
const INFLATE_RATIO_LIMIT = 20
const INFLATE_FLOOR_BYTES = 64 * 1024 * 1024

/**
 * Locate the end-of-central-directory record.
 *
 * @param {Buffer} buffer - whole archive.
 * @returns {number} offset of the record.
 */
function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 66_000)
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('not a zip archive: end of central directory not found')
}

/**
 * Reject entry names that would escape the destination directory.
 *
 * @param {string} name - entry name from the archive.
 * @returns {string} normalised relative path.
 */
function safeEntryPath(name) {
  const slashed = name.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) {
    throw new Error(`zip entry has an absolute path: ${name}`)
  }
  const normalised = posix.normalize(slashed)
  if (normalised === '..' || normalised.startsWith('../')) {
    throw new Error(`zip entry escapes the destination: ${name}`)
  }
  return normalised
}

/**
 * Read the central directory.
 *
 * @param {Buffer} buffer - whole archive.
 * @returns {{ name: string, method: number, compressedSize: number, localOffset: number }[]} entries.
 */
export function listEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  const total = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('corrupt zip archive: central directory signature mismatch')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Decompress one entry.
 *
 * @param {Buffer} buffer - whole archive.
 * @param {{ method: number, compressedSize: number, localOffset: number }} entry - central directory record.
 * @returns {Buffer} uncompressed bytes.
 */
export function readEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error('corrupt zip archive: local header signature mismatch')
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) {
    const limit = Math.max(entry.compressedSize * INFLATE_RATIO_LIMIT, INFLATE_FLOOR_BYTES)
    try {
      return inflateRawSync(raw, { maxOutputLength: limit })
    } catch (error) {
      throw new Error(`zip entry "${entry.name}" expands past the ${limit} byte limit (compressed ${entry.compressedSize} bytes)`, { cause: error })
    }
  }
  throw new Error(`unsupported zip compression method: ${entry.method}`)
}

/**
 * Extract a whole archive into `destDir`.
 *
 * @param {Buffer} buffer - whole archive.
 * @param {string} destDir - destination directory (created when missing).
 * @param {{ executableSuffixes?: string[] }} [options] - suffixes that get +x.
 * @returns {string[]} extracted relative paths.
 */
export function extractZip(buffer, destDir, options = {}) {
  const executableSuffixes = options.executableSuffixes ?? []
  const written = []
  for (const entry of listEntries(buffer)) {
    const relative = safeEntryPath(entry.name)
    if (relative === '.' || relative.endsWith('/')) continue
    const target = join(destDir, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readEntry(buffer, entry))
    if (executableSuffixes.some((suffix) => relative.endsWith(suffix))) {
      try {
        chmodSync(target, 0o755)
      } catch {
        // Filesystems without POSIX modes (Windows) do not need this.
      }
    }
    written.push(relative)
  }
  return written
}

/**
 * Convenience wrapper for callers that already have a zip on disk.
 *
 * @param {string} zipPath - archive path.
 * @param {string} destDir - destination directory.
 * @param {{ executableSuffixes?: string[] }} [options] - extraction options.
 * @returns {string[]} extracted relative paths.
 */
export function extractZipFile(zipPath, destDir, options) {
  return extractZip(readFileSync(zipPath), destDir, options)
}
