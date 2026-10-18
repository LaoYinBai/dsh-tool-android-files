/**
 * The only code in this plugin that touches user files.
 *
 * Measured device behaviour drives every decision here:
 * - `O_EXCL` and `COPYFILE_EXCL` work on both volumes, so a target is never
 *   created over an existing file;
 * - `rename` silently replaces an existing target on both volumes, so it is
 *   never used to "move" anything;
 * - `link()` is refused (EACCES) on both volumes, so no hardlink aliasing;
 * - `fsync` works on files and directories, so "committed" can mean the bytes
 *   and the directory entry reached the medium.
 *
 * Every step is journalled before and after it happens, and a source file is
 * only removed after the destination has been re-read and hashed.
 * @module af/execute
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { AfError, CODE, errorInfo, throwIfAborted } from './errors.js'
import { sha256File } from './hash.js'
import { assertPlanIntegrity } from './plan.js'

/** Same value as `fs.constants.COPYFILE_EXCL`; avoids importing `node:fs` twice. */
const COPYFILE_EXCL = 1

async function fsyncFile(target) {
  const handle = await fsp.open(target, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Directory fsync makes the rename/link count durable; harmless if refused. */
async function fsyncDir(target) {
  let handle
  try {
    handle = await fsp.open(target, 'r')
    await handle.sync()
  } catch {
    /* a filesystem that cannot fsync a directory still gets a verified copy */
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Re-prove that the source is exactly the file the plan was built from.
 *
 * `mtime` equality is treated as necessary but not sufficient: the shared
 * storage clock has 8 ms granularity, so the hash is what actually decides.
 */
async function revalidateSource(op, signal) {
  let stat
  try {
    stat = await fsp.lstat(op.srcPath)
  } catch (error) {
    throw new AfError(CODE.IO, `source is no longer readable (${String(error?.code ?? 'error')})`, {
      srcPath: op.srcPath,
    })
  }
  if (!stat.isFile()) {
    throw new AfError(CODE.IO, 'source is no longer a regular file', { srcPath: op.srcPath })
  }
  if (Number(stat.size) !== op.size) {
    throw new AfError(CODE.IO, `source size changed (${op.size} -> ${Number(stat.size)})`, { srcPath: op.srcPath })
  }
  if (String(stat.ino) !== op.ino || String(stat.dev) !== op.dev) {
    throw new AfError(CODE.IO, 'source identity changed (dev/ino)', { srcPath: op.srcPath })
  }
  if (Math.trunc(Number(stat.mtimeMs)) !== op.mtimeMs) {
    throw new AfError(CODE.IO, 'source modification time changed', { srcPath: op.srcPath })
  }
  const digest = await sha256File(op.srcPath, { signal })
  if (digest.sha256 !== op.hash) {
    throw new AfError(CODE.IO, 'source content changed since the scan', { srcPath: op.srcPath })
  }
  return stat
}

/**
 * Execute one operation: copy, verify, fsync, then remove the source.
 *
 * The order is deliberate. The source is removed only after the destination has
 * been re-hashed and the directory fsynced, so an interruption leaves either
 * "only source" or "source + verified copy" — never "nothing".
 */
async function executeOp(store, planId, op, context) {
  const { signal } = context
  const dstDir = path.dirname(op.dstPath)

  store.setOpState(planId, op.opId, 'checking')
  store.logExec(planId, op.opId, 'intent', `copy to ${op.dstPath}`)
  await revalidateSource(op, signal)

  let existing = null
  try {
    existing = await fsp.lstat(op.dstPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing) {
    throw new AfError(CODE.IO, 'quarantine target already exists; refusing to overwrite', { dstPath: op.dstPath })
  }

  await fsp.mkdir(dstDir, { recursive: true })
  throwIfAborted(signal)

  store.setOpState(planId, op.opId, 'copying')
  await fsp.copyFile(op.srcPath, op.dstPath, COPYFILE_EXCL)
  store.logExec(planId, op.opId, 'copied', `${op.size} bytes`)

  try {
    await fsyncFile(op.dstPath)
    store.setOpState(planId, op.opId, 'verifying')
    const copyDigest = await sha256File(op.dstPath, { signal })
    if (copyDigest.sha256 !== op.hash) {
      throw new AfError(CODE.IO, 'copy does not match the source hash', { dstPath: op.dstPath })
    }
  } catch (error) {
    // The copy is ours (created with EXCL) and provably wrong; remove it so the
    // quarantine does not accumulate torn files. The source is untouched.
    await fsp.unlink(op.dstPath).catch(() => {})
    store.logExec(planId, op.opId, 'copy-rejected', String(error?.message ?? error))
    throw error
  }

  await fsyncDir(dstDir)
  store.setOpState(planId, op.opId, 'committed')
  store.logExec(planId, op.opId, 'verified', 'destination hash matches')

  // Last check before the destructive step.
  const beforeUnlink = await fsp.lstat(op.srcPath)
  if (String(beforeUnlink.ino) !== op.ino || Math.trunc(Number(beforeUnlink.mtimeMs)) !== op.mtimeMs) {
    throw new AfError(CODE.IO, 'source changed while copying; source kept', { srcPath: op.srcPath })
  }

  await fsp.unlink(op.srcPath)
  await fsyncDir(path.dirname(op.srcPath))
  store.setOpState(planId, op.opId, 'source-removed')
  store.logExec(planId, op.opId, 'source-removed', op.srcPath)
}

/** Refuse to start a run that cannot possibly fit. */
export const SPACE_MARGIN_BYTES = 64 * 1024 * 1024

/**
 * Decide whether a run may start, given free space and what it needs.
 *
 * The check is deliberately conservative: it asks for the whole planned size
 * plus a margin, even though each source is removed right after its copy. A
 * refusal is cheap and explains itself; a half-finished run is not.
 */
export function spaceVerdict(input) {
  const freeBytes = Number(input.freeBytes)
  const neededBytes = Number(input.neededBytes)
  const marginBytes = Number.isFinite(input.marginBytes) ? Number(input.marginBytes) : SPACE_MARGIN_BYTES
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return { ok: true, reason: 'unknown-free-space' }
  const required = neededBytes + marginBytes
  if (freeBytes >= required) return { ok: true, reason: 'fits' }
  return { ok: false, reason: 'insufficient-space', required, freeBytes, shortfall: required - freeBytes }
}

/**
 * Execute an approved plan.
 *
 * @param {object} store index store
 * @param {object} plan plan row as returned by `getPlan`
 * @param {{quarantineDir: string, signal?: AbortSignal, onProgress?: Function}} options
 */
export async function executePlan(store, plan, options) {
  const { quarantineDir, signal, onProgress } = options
  if (plan.status !== 'approved') {
    throw new AfError(CODE.PLAN_NOT_PROPOSED, `plan is ${plan.status}, not approved`, { planId: plan.id })
  }
  if (plan.ops.length === 0) {
    throw new AfError(CODE.PLAN_EMPTY, 'plan has no operations', { planId: plan.id })
  }
  assertPlanIntegrity(plan)

  const neededBytes = plan.ops.reduce((sum, op) => sum + Number(op.size || 0), 0)
  let freeBytes = null
  try {
    let probe = path.resolve(quarantineDir)
    for (;;) {
      try {
        if ((await fsp.lstat(probe)).isDirectory()) break
      } catch {
        /* keep walking up */
      }
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    const stats = await fsp.statfs(probe)
    freeBytes = Number(stats.bavail) * Number(stats.bsize)
  } catch {
    freeBytes = null
  }
  const verdict = spaceVerdict({ freeBytes, neededBytes })
  if (!verdict.ok) {
    throw new AfError(CODE.UNSUPPORTED, 'not enough free space to start this plan safely', {
      planId: plan.id,
      required: verdict.required,
      freeBytes: verdict.freeBytes,
      shortfall: verdict.shortfall,
    })
  }

  if (!store.beginExecution(plan.id)) {
    throw new AfError(CODE.PLAN_NOT_PROPOSED, 'plan could not move to executing (already taken)', { planId: plan.id })
  }
  store.seedPlanOps(plan.id, plan.ops)
  store.logExec(plan.id, '*', 'execution-started', `${plan.ops.length} operations`)

  const result = { committed: 0, skipped: 0, failed: 0, bytes: 0, failures: [], cancelled: false }
  await fsp.mkdir(path.join(quarantineDir, String(plan.id)), { recursive: true })

  for (const op of plan.ops) {
    if (signal?.aborted) {
      result.cancelled = true
      result.skipped++
      store.setOpState(plan.id, op.opId, 'skipped', 'cancelled before this operation started')
      store.logExec(plan.id, op.opId, 'skipped', 'cancelled')
      continue
    }
    try {
      await executeOp(store, plan.id, op, { signal })
      result.committed++
      result.bytes += op.size
    } catch (error) {
      if (error instanceof AfError && error.code === CODE.ABORTED) {
        result.cancelled = true
        result.skipped++
        store.setOpState(plan.id, op.opId, 'skipped', 'cancelled')
        continue
      }
      const info = errorInfo(error)
      result.failed++
      result.failures.push({ opId: op.opId, message: info.message })
      store.setOpState(plan.id, op.opId, 'failed', info.message)
      store.logExec(plan.id, op.opId, 'failed', info.message)
    }
    onProgress?.(result)
  }

  const direction = plan.mode === 'restore' ? '恢复到原路径' : '移入隔离区'
  const status = result.failed > 0 || result.cancelled ? 'needs-review' : 'committed'
  const note = status === 'committed'
    ? `${result.committed} 个文件已${direction}`
    : `${result.committed} 成功 / ${result.failed} 失败 / ${result.skipped} 跳过，需人工核对`
  store.finishExecution(plan.id, status, note)
  store.logExec(plan.id, '*', 'execution-finished', `${status}: ${note}`)

  // A restore empties its own plan directory; a forward plan does not. rmdir is
  // the safe form here: it only succeeds when the directory is already empty and
  // it can only ever remove a directory this plugin created for this plan.
  const planDir = path.join(quarantineDir, String(plan.id))
  await fsp.rmdir(planDir).catch(() => {})

  return { ...result, status, note }
}
