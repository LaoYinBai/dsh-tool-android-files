/**
 * Iterative directory walk.
 *
 * The walk never follows symlinks, re-stats every directory before descending
 * (narrowing a swap race), and reports per-entry failures instead of aborting
 * the whole scan.
 * @module af/scan
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { AfError, CODE, throwIfAborted } from './errors.js'

export const MAX_DEPTH = 64

/** Compile a very small glob dialect (`*` only) into a case-insensitive RegExp. */
export function compileNamePattern(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return null
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${escaped}$`, 'i')
  } catch {
    return null
  }
}

/**
 * @param {import('./paths.js').describeRoot extends never ? never : {real: string, dev: number, ino: number}} rootDesc
 * @param {{
 *   includeSubdirs?: boolean,
 *   maxEntries?: number,
 *   excludeNames?: Set<string>,
 *   excludeExts?: Set<string>,
 *   excludePatterns?: RegExp[],
 *   excludeDirs?: string[],
 *   signal?: AbortSignal,
 *   onProgress?: (progress: {files: number, dirs: number, bytes: number}) => void,
 * }} options
 * @param {(entry: object) => (void|Promise<void>)} onFile
 */
export async function walkTree(rootDesc, options, onFile) {
  const includeSubdirs = options.includeSubdirs !== false
  const maxEntries = Number.isFinite(options.maxEntries) ? Number(options.maxEntries) : Infinity
  const excludeNames = options.excludeNames ?? new Set()
  const excludeExts = options.excludeExts ?? new Set()
  const excludePatterns = options.excludePatterns ?? []
  const excludeDirs = new Set((options.excludeDirs ?? []).map((dir) => path.resolve(dir)))
  const stats = {
    dirs: 0,
    files: 0,
    bytes: 0,
    skippedSymlinks: 0,
    skippedOther: 0,
    excluded: 0,
    errors: [],
    truncated: false,
    maxDepthHit: 0,
  }

  /** @type {Array<{dir: string, depth: number, rel: string}>} */
  const stack = [{ dir: rootDesc.real, depth: 0, rel: '' }]
  const progressEvery = 200

  while (stack.length > 0) {
    throwIfAborted(options.signal)
    const current = stack.pop()
    if (excludeDirs.has(path.resolve(current.dir))) {
      stats.excluded++
      continue
    }
    let entries
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true })
    } catch (err) {
      stats.errors.push({
        path: current.rel === '' ? '.' : current.rel,
        code: String(err?.code ?? 'EIO'),
        phase: 'readdir',
      })
      continue
    }

    for (const dirent of entries) {
      throwIfAborted(options.signal)
      const name = dirent.name
      const rel = current.rel === '' ? name : `${current.rel}/${name}`
      const abs = path.join(current.dir, name)

      if (excludeNames.has(name)) {
        stats.excluded++
        continue
      }
      if (excludePatterns.some((pattern) => pattern.test(name))) {
        stats.excluded++
        continue
      }
      if (excludeExts.size > 0) {
        const dot = name.lastIndexOf('.')
        if (dot > 0 && excludeExts.has(name.slice(dot + 1).toLowerCase())) {
          stats.excluded++
          continue
        }
      }

      if (dirent.isSymbolicLink()) {
        stats.skippedSymlinks++
        continue
      }
      if (dirent.isDirectory()) {
        if (!includeSubdirs) {
          stats.excluded++
          continue
        }
        if (current.depth + 1 > MAX_DEPTH) {
          stats.maxDepthHit++
          stats.errors.push({ path: rel, code: 'EMAXDEPTH', phase: 'descend' })
          continue
        }
        let dirStat
        try {
          dirStat = await fsp.lstat(abs)
        } catch (err) {
          stats.errors.push({ path: rel, code: String(err?.code ?? 'EIO'), phase: 'lstat-dir' })
          continue
        }
        // A directory entry that is no longer a directory (or became a link
        // between readdir and lstat) is skipped rather than descended into.
        if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
          stats.skippedOther++
          continue
        }
        stats.dirs++
        stack.push({ dir: abs, depth: current.depth + 1, rel })
        continue
      }
      if (!dirent.isFile()) {
        stats.skippedOther++
        continue
      }

      let fileStat
      try {
        fileStat = await fsp.lstat(abs)
      } catch (err) {
        stats.errors.push({ path: rel, code: String(err?.code ?? 'EIO'), phase: 'lstat-file' })
        continue
      }
      if (!fileStat.isFile()) {
        if (fileStat.isSymbolicLink()) stats.skippedSymlinks++
        else stats.skippedOther++
        continue
      }

      stats.files++
      stats.bytes += Number(fileStat.size)
      await onFile({
        abs,
        rel,
        name,
        size: Number(fileStat.size),
        mtimeMs: Number(fileStat.mtimeMs),
        dev: Number(fileStat.dev),
        ino: Number(fileStat.ino),
        mode: Number(fileStat.mode),
        rootReal: rootDesc.real,
      })

      if (stats.files >= maxEntries) {
        stats.truncated = true
        return stats
      }
      if (options.onProgress && stats.files % progressEvery === 0) {
        options.onProgress({ files: stats.files, dirs: stats.dirs, bytes: stats.bytes })
      }
    }
  }
  return stats
}

/** Guard used by callers that must translate a walk failure into a code. */
export function walkError(err) {
  if (err instanceof AfError) return err
  return new AfError(CODE.IO, `scan failed: ${String(err?.message ?? err)}`)
}
