/** Absolute-path boundary checks that never rely on string prefixes. @module af/paths */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { AfError, CODE } from './errors.js'

/**
 * Paths the plugin refuses to treat as scan roots or scan targets.
 *
 * `Android/data` and `Android/obb` are unreachable for the app UID on Android
 * 11+ even with MANAGE_EXTERNAL_STORAGE, so they are refused instead of being
 * reported as empty. Pseudo filesystems and the app-private `/data` root are
 * refused because managing them is out of scope for a personal file tidier.
 */
export const DENY_ROOTS = Object.freeze([
  '/storage/emulated/0/Android/data',
  '/storage/emulated/0/Android/obb',
  '/data',
  '/proc',
  '/sys',
  '/system',
  '/vendor',
  '/apex',
  '/dev',
])

const DENY_NORMALIZED = DENY_ROOTS.map((entry) => path.resolve(entry))

/**
 * True when `child` is `parent` itself or lies below it.
 *
 * Uses `path.relative`, never `startsWith`, so `/a/bc` is not inside `/a/b`.
 */
export function isSameOrInside(parent, child) {
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + path.sep)
}

/** Return the deny-list entry that covers `absPath`, or null. */
export function matchedDenyEntry(absPath) {
  const abs = path.resolve(absPath)
  for (const entry of DENY_NORMALIZED) {
    if (isSameOrInside(entry, abs)) return entry
  }
  return null
}

/** Throw when `absPath` falls inside a refused subtree. */
export function assertNotDenied(absPath, what = 'path') {
  const hit = matchedDenyEntry(absPath)
  if (hit) {
    throw new AfError(CODE.PATH_DENIED, `${what} is inside a permanently refused subtree: ${hit}`, {
      path: path.resolve(absPath),
      deniedBy: hit,
    })
  }
}

/**
 * Resolve a configured root into a scan descriptor.
 *
 * A root may itself be a symlink (Android exposes `/sdcard` that way). The link
 * is recorded, but every traversal afterwards uses `real`, so a symlink inside
 * the tree can never widen the boundary.
 */
export async function describeRoot(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new AfError(CODE.CONFIG, 'root must be a non-empty absolute path')
  }
  const abs = path.resolve(input)
  assertNotDenied(abs, 'configured root')

  let lst
  try {
    lst = await fsp.lstat(abs)
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new AfError(CODE.ROOT_MISSING, `configured root does not exist: ${abs}`, { path: abs })
    }
    throw new AfError(CODE.ROOT_MISSING, `cannot stat configured root: ${abs}`, {
      path: abs,
      cause: String(err?.code ?? err),
    })
  }

  const isLink = lst.isSymbolicLink()
  const real = await fsp.realpath(abs)
  assertNotDenied(real, 'resolved root')

  const st = await fsp.stat(real)
  if (!st.isDirectory()) {
    throw new AfError(CODE.ROOT_NOT_DIR, `configured root is not a directory: ${abs}`, {
      path: abs,
      real,
    })
  }
  return {
    input: abs,
    real,
    isLink,
    dev: Number(st.dev),
    ino: Number(st.ino),
    identityKnown: Number(st.ino) !== 0,
  }
}

/**
 * Re-prove that a root still points at the same directory inode.
 *
 * Cheap TOCTOU narrowing: a scan that starts and ends on different inodes has
 * had its boundary replaced underneath it.
 */
export async function assertRootIdentity(desc) {
  const st = await fsp.stat(desc.real)
  if (!st.isDirectory()) {
    throw new AfError(CODE.ROOT_CHANGED, `root is no longer a directory: ${desc.real}`, {
      path: desc.real,
    })
  }
  if (desc.identityKnown && Number(st.ino) !== desc.ino) {
    throw new AfError(CODE.ROOT_CHANGED, `root inode changed during the operation: ${desc.real}`, {
      path: desc.real,
      expectedIno: desc.ino,
      actualIno: Number(st.ino),
    })
  }
  return true
}

/** Relative path of `abs` inside `root`, or null when outside. */
export function relativeInside(root, abs) {
  if (!isSameOrInside(root, abs)) return null
  const rel = path.relative(root, abs)
  return rel === '' ? '.' : rel
}
