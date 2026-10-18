/** Streaming SHA-256 over a file descriptor; never buffers the whole file. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { AfError, CODE, throwIfAborted } from './errors.js'

export const HASH_CHUNK_SIZE = 256 * 1024

/**
 * Hash a file by streaming it.
 *
 * `signal` is checked between chunks, so cancellation lands within one chunk
 * of I/O rather than at the end of the file.
 *
 * @param {string} absPath
 * @param {{signal?: AbortSignal, highWaterMark?: number}} [options]
 * @returns {Promise<{sha256: string, bytes: number, elapsedMs: number}>}
 */
export async function sha256File(absPath, options = {}) {
  const started = Date.now()
  const hash = createHash('sha256')
  const stream = createReadStream(absPath, {
    highWaterMark: options.highWaterMark ?? HASH_CHUNK_SIZE,
  })
  let bytes = 0
  try {
    for await (const chunk of stream) {
      throwIfAborted(options.signal)
      hash.update(chunk)
      bytes += chunk.length
    }
  } catch (err) {
    stream.destroy()
    if (err instanceof AfError) throw err
    throw new AfError(CODE.IO, `hash failed: ${String(err?.message ?? err)}`, {
      path: absPath,
      cause: String(err?.code ?? ''),
    })
  }
  return { sha256: hash.digest('hex'), bytes, elapsedMs: Date.now() - started }
}

/**
 * Reuse a previously computed hash only when the identity quadruple matches.
 *
 * Size and mtime alone are not proof of unchanged content, so the caller must
 * still re-verify before any destructive step; this helper only saves I/O.
 */
export function hashCacheKey(stat) {
  if (!stat || !Number.isFinite(Number(stat.ino)) || Number(stat.ino) === 0) return null
  return `${Number(stat.dev)}:${Number(stat.ino)}:${Number(stat.size)}:${Number(stat.mtimeMs)}`
}
