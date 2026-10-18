/**
 * Write-path capability probe.
 *
 * M2 must never assume POSIX semantics: Android shared storage is FUSE, and the
 * app-private `/data` volume is ext4, so the same call can behave differently
 * depending on where it runs. This module measures what the current backend
 * actually does, in a directory the caller names, and removes everything it
 * created afterwards.
 *
 * Every check is independent: a failed one is recorded, not thrown, because the
 * decision that matters ("can we create a target without clobbering?") must be
 * answered from evidence rather than from a crash.
 * @module af/probe
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { AfError, CODE, throwIfAborted } from './errors.js'

const PAYLOAD = randomBytes(32 * 1024)

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function code(error) {
  const value = error?.code
  return typeof value === 'string' ? value : String(error?.message ?? error)
}

/**
 * Run every write-semantics check inside `baseDir`.
 *
 * @param {string} baseDir an existing directory that this probe may create files in
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<object>} capability report; `checks` is never empty
 */
export async function runProbe(baseDir, options = {}) {
  const signal = options.signal
  /** @type {Array<{id: string, ok: boolean, detail: string}>} */
  const checks = []
  /** @type {string[]} */
  const createdFiles = []
  /** @type {string[]} */
  const createdDirs = []
  const record = (id, ok, detail) => {
    checks.push({ id, ok, detail: String(detail ?? '') })
    return ok
  }

  const workDir = path.join(baseDir, `probe-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`)
  const subA = path.join(workDir, 'a')
  const subB = path.join(workDir, 'b')
  const report = {
    baseDir: workDir,
    exclusiveCreate: false,
    exclusiveCopy: false,
    hardlink: false,
    renameOverwrites: null,
    renameCrossDir: false,
    fsyncFile: false,
    fsyncDir: false,
    mtimeNsAvailable: false,
    mtimeResolutionMs: null,
    dev: null,
    freeBytes: null,
    cleanupOk: false,
    leftovers: [],
  }

  try {
    // 1. Directory creation, recursive, inside a directory the caller owns.
    try {
      await fsp.mkdir(subA, { recursive: true })
      await fsp.mkdir(subB, { recursive: true })
      // Recorded parent-first so the reversed cleanup removes deepest first.
      createdDirs.push(workDir, subA, subB)
      const workStat = await fsp.lstat(subA)
      report.dev = Number(workStat.dev)
      record('mkdir_recursive', true, `created a/ and b/ on dev ${report.dev}`)
    } catch (error) {
      record('mkdir_recursive', false, code(error))
      throw new AfError(CODE.IO, `probe cannot create its working directory: ${code(error)}`, { baseDir })
    }
    throwIfAborted(signal)

    // 2. Plain write then read-back equality: the baseline everything else needs.
    const payloadFile = path.join(subA, 'payload.bin')
    try {
      await fsp.writeFile(payloadFile, PAYLOAD)
      createdFiles.push(payloadFile)
      const readBack = await fsp.readFile(payloadFile)
      record('write_read', sha256(readBack) === sha256(PAYLOAD), `${readBack.length} bytes round-tripped`)
    } catch (error) {
      record('write_read', false, code(error))
    }
    throwIfAborted(signal)

    // 3. Exclusive create: the only primitive that can create a target without
    //    ever clobbering an existing file.
    const exclusiveFile = path.join(subA, 'exclusive.txt')
    try {
      const first = await fsp.open(exclusiveFile, 'wx')
      await first.write('first')
      await first.close()
      createdFiles.push(exclusiveFile)
      let secondCode = 'no-error'
      try {
        const second = await fsp.open(exclusiveFile, 'wx')
        await second.close()
      } catch (error) {
        secondCode = code(error)
      }
      report.exclusiveCreate = secondCode === 'EEXIST'
      record('exclusive_create', report.exclusiveCreate, `second open -> ${secondCode}`)
    } catch (error) {
      record('exclusive_create', false, code(error))
    }
    throwIfAborted(signal)

    // 4. Exclusive copy: how a verified copy lands without overwriting.
    const copySource = path.join(subA, 'copy-source.bin')
    const copyTarget = path.join(subA, 'copy-target.bin')
    try {
      await fsp.writeFile(copySource, 'copy-payload')
      createdFiles.push(copySource)
      await fsp.copyFile(copySource, copyTarget, fsp.constants?.COPYFILE_EXCL ?? 1)
      createdFiles.push(copyTarget)
      let secondCode = 'no-error'
      try {
        await fsp.copyFile(copySource, copyTarget, fsp.constants?.COPYFILE_EXCL ?? 1)
      } catch (error) {
        secondCode = code(error)
      }
      report.exclusiveCopy = secondCode === 'EEXIST'
      record('exclusive_copy', report.exclusiveCopy, `second copy -> ${secondCode}`)
    } catch (error) {
      record('exclusive_copy', false, code(error))
    }
    throwIfAborted(signal)

    // 5. Hardlink: gives an atomic no-clobber "create if absent" alias.
    const linkSource = path.join(subA, 'link-source.txt')
    const linkTarget = path.join(subA, 'link-target.txt')
    try {
      await fsp.writeFile(linkSource, 'link-payload')
      createdFiles.push(linkSource)
      await fsp.link(linkSource, linkTarget)
      createdFiles.push(linkTarget)
      const [sourceStat, targetStat] = await Promise.all([fsp.lstat(linkSource), fsp.lstat(linkTarget)])
      report.hardlink = Number(sourceStat.ino) === Number(targetStat.ino) && Number(sourceStat.nlink) === 2
      record('hardlink', report.hardlink, `ino equal=${Number(sourceStat.ino) === Number(targetStat.ino)}, nlink=${sourceStat.nlink}`)
    } catch (error) {
      record('hardlink', false, code(error))
    }
    throwIfAborted(signal)

    // 6. Does rename silently replace an existing target? POSIX says yes; a
    //    backend that says no is safer, so measure instead of assuming.
    const renameSource = path.join(subA, 'rename-source.txt')
    const renameTarget = path.join(subA, 'rename-target.txt')
    try {
      await fsp.writeFile(renameSource, 'SOURCE')
      await fsp.writeFile(renameTarget, 'TARGET')
      createdFiles.push(renameSource, renameTarget)
      await fsp.rename(renameSource, renameTarget)
      const winner = await fsp.readFile(renameTarget, 'utf8')
      report.renameOverwrites = winner === 'SOURCE'
      record('rename_overwrite', true, `target now holds ${winner === 'SOURCE' ? 'source (silently replaced)' : winner}`)
    } catch (error) {
      report.renameOverwrites = false
      record('rename_overwrite', true, `rename refused: ${code(error)}`)
    }
    throwIfAborted(signal)

    // 7. Same-volume rename across directories, with inode stability. This is
    //    what makes "move within a directory tree" cheap and non-destructive.
    const crossSource = path.join(subA, 'cross.txt')
    const crossTarget = path.join(subB, 'cross.txt')
    try {
      await fsp.writeFile(crossSource, 'cross-payload')
      createdFiles.push(crossSource)
      const before = await fsp.lstat(crossSource)
      await fsp.rename(crossSource, crossTarget)
      createdFiles.push(crossTarget)
      const after = await fsp.lstat(crossTarget)
      report.renameCrossDir = true
      report.dev = Number(after.dev)
      record(
        'rename_cross_dir',
        true,
        `ino stable=${Number(before.ino) === Number(after.ino)}, dev ${Number(after.dev)}`,
      )
    } catch (error) {
      record('rename_cross_dir', false, code(error))
    }
    throwIfAborted(signal)

    // 8. fsync on a file handle: whether "committed" can mean anything.
    const syncFile = path.join(subA, 'sync.bin')
    try {
      const handle = await fsp.open(syncFile, 'w')
      createdFiles.push(syncFile)
      await handle.write(PAYLOAD)
      await handle.sync()
      report.fsyncFile = true
      record('fsync_file', true, 'fsync ok')
      await handle.close()
    } catch (error) {
      record('fsync_file', false, code(error))
    }
    throwIfAborted(signal)

    // 9. fsync on a directory handle: what makes a rename durable.
    try {
      const dirHandle = await fsp.open(subA, 'r')
      try {
        await dirHandle.sync()
        report.fsyncDir = true
        record('fsync_dir', true, 'directory fsync ok')
      } finally {
        await dirHandle.close()
      }
    } catch (error) {
      record('fsync_dir', false, code(error))
    }
    throwIfAborted(signal)

    // 10. Timestamp resolution: drives concurrent-modification detection.
    const timeFile = path.join(subA, 'time.txt')
    try {
      await fsp.writeFile(timeFile, 't1')
      createdFiles.push(timeFile)
      const first = await fsp.lstat(timeFile)
      await new Promise((resolve) => setTimeout(resolve, 5))
      await fsp.appendFile(timeFile, 't2')
      const second = await fsp.lstat(timeFile)
      report.mtimeResolutionMs = Number(second.mtimeMs) - Number(first.mtimeMs)
      const big = await fsp.lstat(timeFile, { bigint: true })
      report.mtimeNsAvailable = typeof big.mtimeNs === 'bigint'
      record(
        'mtime_resolution',
        true,
        `delta ${report.mtimeResolutionMs}ms, mtimeNs available=${report.mtimeNsAvailable}`,
      )
    } catch (error) {
      record('mtime_resolution', false, code(error))
    }
    throwIfAborted(signal)

    // 11. Free space, so "how much can this operation need" is answerable.
    try {
      const stats = await fsp.statfs(workDir)
      report.freeBytes = Number(stats.bavail) * Number(stats.bsize)
      record('statfs', true, `free ${report.freeBytes} bytes`)
    } catch (error) {
      record('statfs', false, code(error))
    }
    throwIfAborted(signal)

    // 12. Delete: needed to clean up, and to prove a copy-then-delete move works.
    try {
      const removeFile = path.join(subA, 'remove.txt')
      await fsp.writeFile(removeFile, 'x')
      await fsp.unlink(removeFile)
      record('unlink', true, 'removed a file it created')
    } catch (error) {
      record('unlink', false, code(error))
    }
  } finally {
    const cleanup = await cleanupProbe(createdFiles, createdDirs)
    report.cleanupOk = cleanup.ok
    report.leftovers = cleanup.leftovers
  }

  return { ...report, checks }
}

/** Remove only the paths this probe created, deepest first. */
async function cleanupProbe(files, dirs) {
  const leftovers = []
  for (const file of [...files].reverse()) {
    try {
      await fsp.unlink(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') leftovers.push(`${file} (${code(error)})`)
    }
  }
  for (const dir of [...dirs].reverse()) {
    try {
      await fsp.rmdir(dir)
    } catch (error) {
      if (error?.code !== 'ENOENT') leftovers.push(`${dir} (${code(error)})`)
    }
  }
  return { ok: leftovers.length === 0, leftovers }
}
