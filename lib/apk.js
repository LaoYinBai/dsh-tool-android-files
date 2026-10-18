/**
 * Bounded APK structure check.
 *
 * This reads the ZIP end-of-central-directory and the central directory headers
 * only. Nothing is decompressed, nothing is extracted, and no byte of file
 * content is returned to the caller. A positive result means "the ZIP container
 * lists AndroidManifest.xml", which is a type check — it says nothing about
 * signatures or installability.
 * @module af/apk
 */
import fsp from 'node:fs/promises'
import { throwIfAborted } from './errors.js'

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const EOCD_MIN = 22
const MAX_COMMENT = 66 * 1024
const MAX_CENTRAL_DIRECTORY = 8 * 1024 * 1024
const MAX_ENTRIES = 8192
const NAME_LIMIT = 4096

/**
 * @param {string} absPath
 * @param {number} size
 * @param {{signal?: AbortSignal}} [options]
 */
export async function inspectZipStructure(absPath, size, options = {}) {
  const result = {
    isZip: false,
    verdict: 'not-zip',
    entries: 0,
    hasManifest: false,
    hasDex: false,
  }
  if (!Number.isFinite(size) || size < EOCD_MIN) {
    result.verdict = 'too-small'
    return result
  }

  const tailLength = Math.min(size, MAX_COMMENT + EOCD_MIN)
  const tailOffset = size - tailLength
  const tail = Buffer.alloc(tailLength)
  const fh = await fsp.open(absPath, 'r')
  try {
    await fh.read(tail, 0, tailLength, tailOffset)
    throwIfAborted(options.signal)

    let eocd = -1
    for (let i = tailLength - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD_SIG) continue
      const commentLength = tail.readUInt16LE(i + 20)
      if (i + EOCD_MIN + commentLength === tailLength) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return result
    result.isZip = true

    const totalEntries = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    result.entries = totalEntries

    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      result.verdict = 'zip64-unsupported'
      return result
    }
    if (cdOffset + cdSize > size) {
      result.verdict = 'central-directory-out-of-range'
      return result
    }
    if (cdSize === 0 || cdSize > MAX_CENTRAL_DIRECTORY) {
      result.verdict = cdSize === 0 ? 'empty-archive' : 'central-directory-too-large'
      return result
    }

    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    throwIfAborted(options.signal)

    let cursor = 0
    let scanned = 0
    let namesRead = 0
    while (cursor + 46 <= cdSize && scanned < MAX_ENTRIES) {
      if (cd.readUInt32LE(cursor) !== CD_SIG) break
      const nameLength = cd.readUInt16LE(cursor + 28)
      const extraLength = cd.readUInt16LE(cursor + 30)
      const commentLength = cd.readUInt16LE(cursor + 32)
      const nameStart = cursor + 46
      if (nameStart + nameLength > cdSize) break
      if (namesRead < NAME_LIMIT) {
        const entryName = cd.toString('utf8', nameStart, nameStart + nameLength)
        if (entryName === 'AndroidManifest.xml') result.hasManifest = true
        if (entryName === 'classes.dex') result.hasDex = true
        namesRead++
      }
      scanned++
      cursor = nameStart + nameLength + extraLength + commentLength
    }

    result.verdict = result.hasManifest ? 'apk-structure-ok' : 'zip-without-manifest'
    return result
  } finally {
    await fh.close().catch(() => {})
  }
}
