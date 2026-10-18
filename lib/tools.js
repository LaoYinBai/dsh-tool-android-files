/**
 * Model-visible tool definitions.
 *
 * Every tool here is read-only with respect to the user's files. The only
 * writes are to the plugin's own SQLite index under its data directory.
 * @module af/tools
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AfError, CODE, errorInfo, throwIfAborted } from './errors.js'
import { assertRootIdentity, describeRoot, isSameOrInside } from './paths.js'
import { compileNamePattern, walkTree } from './scan.js'
import { buildRules, classify } from './classify.js'
import { analyzeName } from './naming.js'
import { sha256File } from './hash.js'
import { inspectZipStructure } from './apk.js'
import { openStore } from './db.js'
import { CATEGORIES } from './exts.js'
import { PLUGIN_VERSION } from './version.js'
import { runProbe } from './probe.js'
import { classifyProtection, encodeProtection, redactProtection } from './protect.js'
import { PLAN_MODES, DEDUPE_POLICY, RESTORE_POLICY, buildDedupePlan, buildRestorePlan, planDigest, planText, assertPlanIntegrity } from './plan.js'
import { requestPlanApproval } from './confirm.js'
import { executePlan } from './execute.js'

const CATEGORY_LABEL = {
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档',
  archive: '压缩包',
  installer: '安装包',
  other: '其他',
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

/** Property descriptor for the DSH value-schema DSL. */
const P = (type, description, required = false) => {
  const node = { type, description }
  if (required) node.required = true
  return node
}

const P_ENUM = (values, description, required = false) => {
  const node = { type: 'string', enum: values, description }
  if (required) node.required = true
  return node
}

const text = (value) => [{ type: 'text', text: value }]

/**
 * Render a compact `key=value` line.
 *
 * Only `render()` reaches the model — the canonical JSON value stays in the
 * session for programmatic callers — so every field the model must reason about
 * has to appear in the rendered text as well.
 */
function kv(pairs) {
  const parts = []
  for (const [key, value] of Object.entries(pairs)) {
    if (value === undefined || value === null) continue
    parts.push(`${key}=${value === '' ? '""' : value}`)
  }
  return parts.join(' ')
}

/** Indent a multi-line block so it reads as a section body. */
function indentBlock(block, prefix = '  ') {
  if (!block) return ''
  return block
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => prefix + line)
    .join('\n')
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`
}

function fmtDuration(ms) {
  const n = Number(ms) || 0
  if (n < 1000) return `${n}ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.floor(n / 60_000)}m${Math.round((n % 60_000) / 1000)}s`
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

function categoryLine(counts) {
  return CATEGORIES.map((category) => {
    const entry = counts[category]
    if (!entry || entry.count === 0) return null
    return `${CATEGORY_LABEL[category]} ${entry.count}`
  })
    .filter(Boolean)
    .join(' · ')
}

function maskName(item) {
  const ext = item.ext ? `.${item.ext}` : ''
  return `#${item.id}${ext}`
}

/** Lazily open the index; the seam keeps `apply()` free of I/O. */
async function ensureStore(state) {
  if (state.store) return state.store
  if (!state.storePromise) {
    const dbPath = path.join(state.config.dataDir, 'index.sqlite')
    state.storePromise = openStore(dbPath).then((store) => {
      state.store = store
      return store
    })
    state.storePromise.catch(() => {
      state.storePromise = null
    })
  }
  return state.storePromise
}

function requireScan(store, requested) {  const scan = store.getScan(requested)
  if (!scan) {
    const hint = requested === undefined || requested === null ? 'no scan has been recorded yet' : `scan ${requested} does not exist`
    throw new AfError(CODE.SCAN_NOT_FOUND, hint)
  }
  return scan
}

/** Resolve a stored plan, defaulting to the most recent one. */
function requirePlan(store, requested) {
  const plan = store.getPlan(requested)
  if (!plan) {
    const hint = requested === undefined || requested === null
      ? 'no plan has been created yet'
      : `plan ${requested} does not exist`
    throw new AfError(CODE.PLAN_NOT_FOUND, hint)
  }
  return plan
}

/**
 * Prove that a directory may receive plugin writes before creating anything.
 *
 * The configured path may not exist yet, so the check walks up to the nearest
 * existing ancestor, resolves it, and requires that ancestor to sit inside a
 * configured root (or, on Android, the app's public directory).
 */
async function assertWritableBase(config, dir) {
  let probe = path.resolve(dir)
  for (;;) {
    try {
      const stat = await fsp.lstat(probe)
      if (!stat.isDirectory()) {
        throw new AfError(CODE.PATH_DENIED, `quarantine path is a file, not a directory: ${probe}`)
      }
      break
    } catch (error) {
      if (error instanceof AfError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(probe)
    if (parent === probe) {
      throw new AfError(CODE.PATH_DENIED, `quarantine path has no existing ancestor: ${dir}`)
    }
    probe = parent
  }

  const ancestor = await describeRoot(probe)
  let permitted = false
  for (const root of config.roots) {
    try {
      const rootDesc = await describeRoot(root)
      if (isSameOrInside(rootDesc.real, ancestor.real)) {
        permitted = true
        break
      }
    } catch {
      /* an unreadable root cannot authorize anything */
    }
  }
  if (!permitted && process.platform === 'android') {
    try {
      const appPublic = await fsp.realpath('/storage/emulated/0/DeepSeekHarness')
      if (isSameOrInside(appPublic, ancestor.real)) permitted = true
    } catch {
      /* no app public directory on this device */
    }
  }
  if (!permitted) {
    throw new AfError(
      CODE.PATH_DENIED,
      'quarantine path is outside every configured root and the app public directory',
      { quarantineDir: path.resolve(dir), nearestExisting: ancestor.real },
    )
  }
  return path.resolve(dir)
}

/**
 * Resolve which configured roots a scan may touch.
 *
 * A requested subdirectory is accepted only when its *real* path stays inside a
 * configured root's *real* path, so a symlink inside the tree cannot widen the
 * authorized boundary.
 */
async function resolveScanRoots(config, requestedRoot) {
  if (config.roots.length === 0) {
    throw new AfError(CODE.CONFIG, 'no roots configured; set roots in the plugin config before scanning')
  }
  if (requestedRoot === undefined || requestedRoot === null || requestedRoot === '') {
    const targets = []
    const skipped = []
    for (const root of config.roots) {
      try {
        targets.push(await describeRoot(root))
      } catch (err) {
        skipped.push({ root, reason: `${errorInfo(err).code}` })
      }
    }
    if (targets.length === 0) {
      throw new AfError(CODE.ROOT_MISSING, `no configured root could be opened (${skipped.length} skipped)`)
    }
    return { targets, skipped }
  }

  const requested = String(requestedRoot)
  if (!path.isAbsolute(requested)) {
    throw new AfError(CODE.ROOT_NOT_ALLOWED, 'root must be an absolute path')
  }
  const resolved = path.resolve(requested)
  const insideConfigured = config.roots.some((root) => isSameOrInside(root, resolved))
  if (!insideConfigured) {
    throw new AfError(CODE.ROOT_NOT_ALLOWED, 'requested root is outside every configured root', {
      requested: resolved,
    })
  }
  const target = await describeRoot(resolved)
  let proven = false
  for (const root of config.roots) {
    if (!isSameOrInside(root, resolved)) continue
    try {
      const desc = await describeRoot(root)
      if (isSameOrInside(desc.real, target.real)) {
        proven = true
        break
      }
    } catch {
      /* an unusable sibling root simply cannot prove containment */
    }
  }
  if (!proven) {
    throw new AfError(CODE.ROOT_NOT_ALLOWED, 'requested root resolves outside its configured root', {
      requested: resolved,
      resolvedReal: target.real,
    })
  }
  return { targets: [target], skipped: [] }
}

function scanAbortStatus(err) {
  const info = errorInfo(err)
  return info.code === CODE.ABORTED ? 'cancelled' : 'failed'
}

/**
 * Register every tool. Returns the disposers Cordis needs for hot reload.
 *
 * @param {object} ctx Cordis context with `tools` injected
 * @param {{config: object, store: object|null, storePromise: Promise<object>|null, scanning: boolean}} state
 */
export function registerTools(ctx, state) {
  const disposers = []
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }

  register(defineTool({
    name: 'af_backend',
    description:
      'Report this plugin\'s file-access backend: platform, Node and SQLite versions, index database location and '
      + 'writability, configured roots and whether each one currently opens, and which capabilities are actually '
      + 'available. Read-only, touches nothing outside the plugin data directory. Call this first when a scan or '
      + 'path operation behaves unexpectedly.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when the backend report was produced', true),
          plugin_version: P('string', 'version of this plugin package as loaded', true),
          platform: P('string', 'process.platform', true),
          arch: P('string', 'process.arch', true),
          node: P('string', 'Node.js version', true),
          sqlite: P('string', 'SQLite library version', true),
          journal_mode: P('string', 'SQLite journal mode in effect', true),
          data_dir: P('string', 'plugin data directory, absolute', true),
          db_path: P('string', 'index database path, absolute', true),
          db_writable: P('boolean', 'whether the index database could be opened for writing', true),
          roots_configured: P('number', 'number of roots in the plugin config', true),
          roots_ready: P('number', 'number of configured roots that open as directories right now', true),
          roots_text: P('string', 'per-root status lines', true),
          capabilities_text: P('string', 'capability lines with availability', true),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => text([
        value.ok
          ? `af_backend ok · v${value.plugin_version} · ${value.platform}/${value.arch} · node ${value.node} · sqlite ${value.sqlite} · ${value.journal_mode}`
          : `af_backend ok=false · v${value.plugin_version} · ${value.error}`,
        kv({
          ok: value.ok,
          plugin_version: value.plugin_version,
          platform: value.platform,
          arch: value.arch,
          node: value.node,
          sqlite: value.sqlite,
          journal_mode: value.journal_mode,
          db_writable: value.db_writable,
          roots_configured: value.roots_configured,
          roots_ready: value.roots_ready,
        }),
        `data_dir=${value.data_dir}`,
        `db_path=${value.db_path}`,
        'roots:',
        indentBlock(value.roots_text),
        'capabilities:',
        indentBlock(value.capabilities_text),
        value.error ? `error=${value.error}` : '',
      ].filter(Boolean).join('\n')),
    },
    async execute(_args, exec) {
      throwIfAborted(exec.signal)
      const { config } = state
      const lines = []
      let store = null
      let dbWritable = false
      let dbError = ''
      try {
        store = await ensureStore(state)
        dbWritable = true
      } catch (err) {
        dbError = `${errorInfo(err).code}: ${errorInfo(err).message}`
      }

      let statfsLine = 'statfs: unsupported on this platform'
      try {
        const stats = await fsp.statfs(config.dataDir)
        statfsLine = `statfs: ok (free ${fmtBytes(Number(stats.bavail) * Number(stats.bsize))} of ${fmtBytes(Number(stats.blocks) * Number(stats.bsize))})`
      } catch (err) {
        statfsLine = `statfs: unavailable (${String(err?.code ?? 'error')})`
      }

      const roots = []
      for (const root of config.roots) {
        try {
          const desc = await describeRoot(root)
          roots.push(`${root} → ok (dev ${desc.dev}, ino ${desc.ino}${desc.isLink ? ', symlink root' : ''})`)
        } catch (err) {
          const info = errorInfo(err)
          roots.push(`${root} → ${info.code}: ${info.message}`)
        }
      }
      if (roots.length === 0) roots.push('(no roots configured)')

      const capabilities = [
        'file backend: node:fs/promises (app UID)',
        'content:// / SAF / MediaStore: not available to the Node process',
        'Android/data and Android/obb: refused by policy and unreadable for the app UID',
        'symlinks: never followed during scans',
        statfsLine,
        'mime type: not available from the runtime; classification uses extensions only',
      ]

      if (!dbWritable) {
        return {
          ok: false,
          plugin_version: PLUGIN_VERSION,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          sqlite: '',
          journal_mode: '',
          data_dir: config.dataDir,
          db_path: path.join(config.dataDir, 'index.sqlite'),
          db_writable: false,
          roots_configured: config.roots.length,
          roots_ready: roots.filter((line) => line.includes('→ ok')).length,
          roots_text: roots.join('\n'),
          capabilities_text: [...capabilities, `index: ${dbError}`].join('\n'),
          error: dbError,
        }
      }

      return {
        ok: true,
        plugin_version: PLUGIN_VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        sqlite: store.sqliteVersion,
        journal_mode: store.journalMode,
        data_dir: config.dataDir,
        db_path: store.dbPath,
        db_writable: true,
        roots_configured: config.roots.length,
        roots_ready: roots.filter((line) => line.includes('→ ok')).length,
        roots_text: roots.join('\n'),
        capabilities_text: capabilities.join('\n'),
        error: '',
      }
    },
  }))

  register(defineTool({
    name: 'af_probe_write',
    description:
      'Measure what writing actually does on this device without touching user files. Creates a few temporary files '
      + 'inside the plugin data directory (and inside the configured probeDir when it is set and permitted), tests '
      + 'exclusive create, exclusive copy, hard links, whether rename silently replaces a target, cross-directory '
      + 'rename, fsync on files and directories, timestamp resolution and free space, then removes everything it '
      + 'created and reports any leftover. M2 relies on this to decide whether a move can be a plain rename or must '
      + 'be copy-verify-delete.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when the app-private probe ran', true),
          app_dir: P('string', 'working directory used on the app-private volume', true),
          app_exclusive_create: P('boolean', "O_EXCL create refuses an existing file", true),
          app_exclusive_copy: P('boolean', 'COPYFILE_EXCL copy refuses an existing target', true),
          app_hardlink: P('boolean', 'link() works and shares the inode', true),
          app_rename_overwrites: P('boolean', 'rename silently replaces an existing target (POSIX default)', true),
          app_rename_cross_dir: P('boolean', 'rename works across directories of the same volume', true),
          app_fsync_file: P('boolean', 'fsync on a file descriptor succeeds', true),
          app_fsync_dir: P('boolean', 'fsync on a directory descriptor succeeds', true),
          app_mtime_resolution_ms: P('number', 'observed timestamp delta for two writes 5ms apart', true),
          app_free_bytes: P('number', 'free space reported by statfs', true),
          shared_ran: P('boolean', 'true when the shared-storage probe actually ran', true),
          shared_dir: P('string', 'working directory used on shared storage', true),
          shared_exclusive_create: P('boolean', 'same check on shared storage', true),
          shared_exclusive_copy: P('boolean', 'same check on shared storage', true),
          shared_hardlink: P('boolean', 'same check on shared storage', true),
          shared_rename_overwrites: P('boolean', 'same check on shared storage', true),
          shared_rename_cross_dir: P('boolean', 'same check on shared storage', true),
          shared_fsync_file: P('boolean', 'same check on shared storage', true),
          shared_fsync_dir: P('boolean', 'same check on shared storage', true),
          shared_mtime_resolution_ms: P('number', 'same measurement on shared storage', true),
          shared_free_bytes: P('number', 'free space on shared storage', true),
          same_device: P('boolean', 'true when both volumes report the same dev, so rename could cross them', true),
          cleanup_ok: P('boolean', 'true when every temporary path was removed', true),
          checks_text: P('string', 'one line per check, per backend', true),
          note: P('string', 'why the shared probe was skipped, when it was'),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_probe_write ok · app-private volume probed${value.shared_ran ? ' + shared storage' : ' (shared storage skipped)'}`
          : `af_probe_write ok=false · ${value.error}`
        const lines = [
          head,
          kv({
            ok: value.ok,
            app_exclusive_create: value.app_exclusive_create,
            app_exclusive_copy: value.app_exclusive_copy,
            app_hardlink: value.app_hardlink,
            app_rename_overwrites: value.app_rename_overwrites,
            app_rename_cross_dir: value.app_rename_cross_dir,
            app_fsync_file: value.app_fsync_file,
            app_fsync_dir: value.app_fsync_dir,
            app_mtime_resolution_ms: value.app_mtime_resolution_ms,
            app_free_bytes: value.app_free_bytes,
          }),
          value.shared_ran
            ? kv({
              shared_exclusive_create: value.shared_exclusive_create,
              shared_exclusive_copy: value.shared_exclusive_copy,
              shared_hardlink: value.shared_hardlink,
              shared_rename_overwrites: value.shared_rename_overwrites,
              shared_rename_cross_dir: value.shared_rename_cross_dir,
              shared_fsync_file: value.shared_fsync_file,
              shared_fsync_dir: value.shared_fsync_dir,
              shared_mtime_resolution_ms: value.shared_mtime_resolution_ms,
              shared_free_bytes: value.shared_free_bytes,
              same_device: value.same_device,
            })
            : 'shared_ran=false',
          `cleanup_ok=${value.cleanup_ok}`,
          indentBlock(value.checks_text),
          value.note ? `note: ${value.note}` : '',
          value.error ? `error=${value.error}` : '',
        ].filter(Boolean)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      throwIfAborted(exec.signal)
      const { config } = state
      const base = {
        ok: false,
        app_dir: '',
        app_exclusive_create: false,
        app_exclusive_copy: false,
        app_hardlink: false,
        app_rename_overwrites: false,
        app_rename_cross_dir: false,
        app_fsync_file: false,
        app_fsync_dir: false,
        app_mtime_resolution_ms: 0,
        app_free_bytes: 0,
        shared_ran: false,
        shared_dir: '',
        shared_exclusive_create: false,
        shared_exclusive_copy: false,
        shared_hardlink: false,
        shared_rename_overwrites: false,
        shared_rename_cross_dir: false,
        shared_fsync_file: false,
        shared_fsync_dir: false,
        shared_mtime_resolution_ms: 0,
        shared_free_bytes: 0,
        same_device: false,
        cleanup_ok: false,
        checks_text: '',
        note: '',
        error: '',
      }

      const lines = []
      let app
      try {
        const appBase = path.join(config.dataDir, 'probe')
        await fsp.mkdir(appBase, { recursive: true })
        app = await runProbe(appBase, { signal: exec.signal })
        lines.push(`app-private (${appBase}):`)
        for (const check of app.checks) lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}`)
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, ok: false, error: `${info.code}: ${info.message}` }
      }

      let shared = null
      let note = ''
      if (!config.probeDir) {
        note = 'probeDir is not configured, so shared-storage semantics were not measured'
      } else {
        try {
          const desc = await describeRoot(config.probeDir)
          let permitted = false
          for (const root of config.roots) {
            try {
              const rootDesc = await describeRoot(root)
              if (isSameOrInside(rootDesc.real, desc.real)) {
                permitted = true
                break
              }
            } catch {
              /* an unreadable sibling root cannot authorize anything */
            }
          }
          if (!permitted && process.platform === 'android') {
            // The app's own public directory is a legitimate measurement target
            // even when it is not a scan root, and it holds no user documents.
            try {
              const appPublic = await fsp.realpath('/storage/emulated/0/DeepSeekHarness')
              if (isSameOrInside(appPublic, desc.real)) permitted = true
            } catch {
              /* no public app directory on this device */
            }
          }
          if (!permitted) {
            note = 'probeDir is outside every configured root and outside the app public directory; shared probe skipped'
          } else {
            shared = await runProbe(desc.real, { signal: exec.signal })
            lines.push(`shared storage (${desc.real}):`)
            for (const check of shared.checks) lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}: ${check.detail}`)
          }
        } catch (err) {
          const info = errorInfo(err)
          note = `shared probe skipped: ${info.code}: ${info.message}`
        }
      }

      return {
        ...base,
        ok: true,
        app_dir: app.baseDir,
        app_exclusive_create: app.exclusiveCreate,
        app_exclusive_copy: app.exclusiveCopy,
        app_hardlink: app.hardlink,
        app_rename_overwrites: app.renameOverwrites === true,
        app_rename_cross_dir: app.renameCrossDir,
        app_fsync_file: app.fsyncFile,
        app_fsync_dir: app.fsyncDir,
        app_mtime_resolution_ms: app.mtimeResolutionMs ?? 0,
        app_free_bytes: app.freeBytes ?? 0,
        shared_ran: shared !== null,
        shared_dir: shared ? shared.baseDir : '',
        shared_exclusive_create: shared ? shared.exclusiveCreate : false,
        shared_exclusive_copy: shared ? shared.exclusiveCopy : false,
        shared_hardlink: shared ? shared.hardlink : false,
        shared_rename_overwrites: shared ? shared.renameOverwrites === true : false,
        shared_rename_cross_dir: shared ? shared.renameCrossDir : false,
        shared_fsync_file: shared ? shared.fsyncFile : false,
        shared_fsync_dir: shared ? shared.fsyncDir : false,
        shared_mtime_resolution_ms: shared ? shared.mtimeResolutionMs ?? 0 : 0,
        shared_free_bytes: shared ? shared.freeBytes ?? 0 : 0,
        same_device: shared !== null && app.dev !== null && shared.dev !== null && app.dev === shared.dev,
        cleanup_ok: app.cleanupOk && (shared === null || shared.cleanupOk),
        checks_text: lines.join('\n'),
        note,
        error: '',
      }
    },
  }))

  register(defineTool({
    name: 'af_scan',
    description:
      'Index the files under one configured root (or every configured root) into the local SQLite index: names, '
      + 'sizes, modification times, category, numbered-name analysis, and SHA-256 for same-size candidates. '
      + 'Read-only with respect to user files: nothing is moved, renamed, or deleted. Never follows symlinks and '
      + 'refuses Android/data, Android/obb and pseudo filesystems. Returns aggregate counts only, not the file list.',
    parameters: {
      root: P('string', 'absolute path to scan; must be inside a configured root. Omit to scan every configured root.'),
      maxEntries: P('number', 'maximum files to index before stopping early (default from config)'),
      includeSubdirs: P('boolean', 'descend into subdirectories; defaults to the plugin config'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when the scan finished', true),
          scan_id: P('number', 'index id for this scan', true),
          status: P('string', 'completed, truncated, failed or cancelled', true),
          files: P('number', 'files indexed', true),
          dirs: P('number', 'directories visited', true),
          bytes: P('number', 'sum of indexed file sizes', true),
          hashed: P('number', 'files whose SHA-256 was computed now', true),
          reused: P('number', 'hashes reused from the cache because identity was unchanged', true),
          duplicate_groups: P('number', 'groups of files with identical size and content hash', true),
          duplicate_files: P('number', 'files that belong to a duplicate group', true),
          zero_byte: P('number', 'zero-byte files, listed separately and never deduplicated', true),
          protected: P('number', 'in-progress downloads, split-volume members and side files that no automatic action may touch', true),
          peak_rss_mb: P('number', 'peak resident memory of the engine process, for scale verification', true),
          skipped: P('number', 'entries skipped (symlinks, sockets, excluded) and directories not opened', true),
          errors: P('number', 'per-entry errors recorded during the scan', true),
          truncated: P('boolean', 'true when maxEntries stopped the scan early', true),
          elapsed_ms: P('number', 'wall-clock duration', true),
          categories: P('string', 'per-category counts', true),
          note: P('string', 'extra context such as skipped roots'),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_scan ok · scan #${value.scan_id} ${value.status} · ${value.files} files · ${fmtBytes(value.bytes)} · ${fmtDuration(value.elapsed_ms)}`
          : `af_scan ok=false · ${value.error}`
        return text([
          head,
          kv({
            ok: value.ok,
            scan_id: value.scan_id,
            status: value.status,
            files: value.files,
            dirs: value.dirs,
            bytes: value.bytes,
            hashed: value.hashed,
            reused: value.reused,
            duplicate_groups: value.duplicate_groups,
            duplicate_files: value.duplicate_files,
            zero_byte: value.zero_byte,
            protected: value.protected,
            peak_rss_mb: value.peak_rss_mb,
            skipped: value.skipped,
            errors: value.errors,
            truncated: value.truncated,
            elapsed_ms: value.elapsed_ms,
          }),
          value.categories ? `categories: ${value.categories}` : '',
          value.truncated ? 'note: stopped at maxEntries, results are partial' : '',
          value.note ? `note: ${value.note}` : '',
          value.error ? `error=${value.error}` : '',
        ].filter(Boolean).join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { config } = state
      if (state.scanning) {
        return failScan(CODE.BUSY, 'another scan is already running')
      }
      let scanId = 0
      let store
      try {
        store = await ensureStore(state)
      } catch (err) {
        const info = errorInfo(err)
        return failScan(info.code, info.message)
      }

      let resolved
      try {
        resolved = await resolveScanRoots(config, args.root)
      } catch (err) {
        const info = errorInfo(err)
        return failScan(info.code, info.message)
      }

      const { rules } = buildRules(config.rules)
      const excludeNames = new Set(['.af-quarantine', ...config.excludeNames])
      const excludeExts = new Set(config.excludeExts)
      const excludePatterns = config.excludePatterns.map(compileNamePattern).filter(Boolean)
      const maxEntries = clampInt(args.maxEntries, config.maxEntries, 1, 200_000)
      const includeSubdirs = typeof args.includeSubdirs === 'boolean' ? args.includeSubdirs : config.includeSubdirs

      scanId = store.startScan(resolved.targets.map((target) => target.input))
      state.scanning = true
      const started = Date.now()
      const totals = {
        files: 0,
        dirs: 0,
        bytes: 0,
        skipped: 0,
        errors: 0,
        truncated: false,
      }
      const batch = []
      const flush = () => {
        if (batch.length === 0) return
        store.insertFiles(scanId, batch.splice(0, batch.length))
        store.updateScanCounts(scanId, totals)
      }

      try {
        for (const target of resolved.targets) {
          const stats = await walkTree(
            target,
            {
              includeSubdirs,
              maxEntries: Math.max(1, maxEntries - totals.files),
              excludeNames,
              excludeExts,
              excludePatterns,
              signal: exec.signal,
              onProgress: () => flush(),
            },
            async (entry) => {
              throwIfAborted(exec.signal)
              const naming = analyzeName(entry.name)
              const classification = classify(
                {
                  name: entry.name,
                  size: entry.size,
                  relDir: path.posix.dirname(entry.rel),
                  ext: naming.ext,
                  compound: naming.compound,
                  extKnown: naming.extKnown,
                },
                rules,
              )
              const row = {
                root: target.input,
                relPath: entry.rel,
                name: entry.name,
                ext: naming.ext,
                size: entry.size,
                mtimeMs: Math.trunc(entry.mtimeMs),
                dev: entry.dev,
                ino: entry.ino,
                category: classification.category,
                ruleId: classification.ruleId,
                conflict: classification.conflict,
                conflictCategory: classification.conflictCategory ?? '',
                number: naming.number,
                numberForm: naming.numberForm,
                baseName: naming.baseName,
                canonicalName: naming.canonicalName,
                flags: naming.flags,
                apkVerdict: '',
                protection: encodeProtection(classifyProtection(entry.name)),
                error: null,
              }
              if (naming.number !== null && naming.ext === 'apk') {
                try {
                  const zip = await inspectZipStructure(entry.abs, entry.size, { signal: exec.signal })
                  row.apkVerdict = zip.verdict
                } catch (err) {
                  row.apkVerdict = err instanceof AfError && err.code === CODE.ABORTED ? '' : 'check-failed'
                  if (err instanceof AfError && err.code === CODE.ABORTED) throw err
                }
              }
              batch.push(row)
              totals.files++
              totals.bytes += entry.size
              if (batch.length >= 200) flush()
            },
          )
          totals.dirs += stats.dirs
          totals.skipped += stats.skippedSymlinks + stats.skippedOther + stats.excluded + stats.maxDepthHit
          totals.errors += stats.errors.length
          totals.truncated = totals.truncated || stats.truncated
          await assertRootIdentity(target)
          if (totals.files >= maxEntries) {
            totals.truncated = true
            break
          }
        }
        flush()

        const hash = await hashCandidates(store, scanId, resolved.targets, exec.signal, (progress) => {
          totals.errors += progress.errors
        })

        const duplicates = store.duplicateStats(scanId)
        const elapsedMs = Date.now() - started
        const status = totals.truncated ? 'truncated' : 'completed'
        store.finishScan(scanId, {
          status,
          files: totals.files,
          dirs: totals.dirs,
          bytes: totals.bytes,
          hashed: hash.hashed,
          skipped: totals.skipped,
          errors: totals.errors,
          truncated: totals.truncated,
          elapsedMs,
        })
        const counts = store.categoryCounts(scanId)
        return {
          ok: true,
          scan_id: scanId,
          status,
          files: totals.files,
          dirs: totals.dirs,
          bytes: totals.bytes,
          hashed: hash.hashed,
          reused: hash.reused,
          duplicate_groups: duplicates.groups,
          duplicate_files: duplicates.files,
          zero_byte: duplicates.zeroByte,
          protected: store.protectedCount(scanId),
          peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
          skipped: totals.skipped,
          errors: totals.errors,
          truncated: totals.truncated,
          elapsed_ms: elapsedMs,
          categories: categoryLine(counts),
          note: resolved.skipped.length > 0 ? `skipped roots: ${resolved.skipped.map((entry) => entry.root).join(', ')}` : '',
          error: '',
        }
      } catch (err) {
        const info = errorInfo(err)
        try {
          store.markScan(scanId, scanAbortStatus(err), `${info.code}: ${info.message}`)
        } catch {
          /* the index may itself be unusable; the original error wins */
        }
        if (info.code === CODE.ABORTED) throw err
        return failScan(info.code, info.message, scanId)
      } finally {
        state.scanning = false
      }
    },
  }))

  register(defineTool({
    name: 'af_scan_report',
    description:
      'Summarize one indexed scan (default: the latest): counts per category, duplicate statistics, zero-byte '
      + 'files, conflicts and errors. Read-only, aggregate only — it never lists paths. Use af_files or '
      + 'af_duplicates when the user explicitly asks to see specific entries.',
    parameters: {
      scan_id: P('number', 'scan to report on; defaults to the latest scan'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when a scan was found', true),
          scan_id: P('number', 'scan id', true),
          status: P('string', 'scan status', true),
          started_at: P('number', 'epoch milliseconds', true),
          finished_at: P('number', 'epoch milliseconds, 0 when unfinished', true),
          roots: P('string', 'roots covered by this scan', true),
          files: P('number', 'files indexed', true),
          dirs: P('number', 'directories visited', true),
          bytes: P('number', 'total bytes indexed', true),
          hashed: P('number', 'files with a stored content hash', true),
          errors: P('number', 'per-entry errors', true),
          truncated: P('boolean', 'whether the scan stopped at maxEntries', true),
          elapsed_ms: P('number', 'duration in milliseconds', true),
          categories: P('string', 'per-category counts', true),
          duplicate_groups: P('number', 'duplicate group count', true),
          duplicate_files: P('number', 'files inside duplicate groups', true),
          zero_byte: P('number', 'zero-byte file count', true),
          conflicts: P('number', 'files whose type evidence conflicts', true),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_scan_report ok · scan #${value.scan_id} ${value.status} · ${value.files} files · ${fmtBytes(value.bytes)}`
          : `af_scan_report ok=false · ${value.error}`
        return text([
          head,
          kv({
            ok: value.ok,
            scan_id: value.scan_id,
            status: value.status,
            files: value.files,
            dirs: value.dirs,
            bytes: value.bytes,
            hashed: value.hashed,
            errors: value.errors,
            truncated: value.truncated,
            elapsed_ms: value.elapsed_ms,
            duplicate_groups: value.duplicate_groups,
            duplicate_files: value.duplicate_files,
            zero_byte: value.zero_byte,
            conflicts: value.conflicts,
          }),
          `started_at=${value.started_at > 0 ? new Date(value.started_at).toISOString() : '""'} finished_at=${value.finished_at > 0 ? new Date(value.finished_at).toISOString() : '""'}`,
          `roots: ${value.roots || '(none)'}`,
          `categories: ${value.categories || '(empty)'}`,
          value.error ? `error=${value.error}` : '',
        ].filter(Boolean).join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      let store
      try {
        store = await ensureStore(state)
      } catch (err) {
        const info = errorInfo(err)
        return { ...emptyReport(), ok: false, error: `${info.code}: ${info.message}` }
      }
      let scan
      try {
        scan = requireScan(store, args.scan_id)
      } catch (err) {
        const info = errorInfo(err)
        return { ...emptyReport(), ok: false, error: `${info.code}: ${info.message}` }
      }
      const duplicates = store.duplicateStats(scan.id)
      return {
        ok: true,
        scan_id: scan.id,
        status: scan.status,
        started_at: scan.startedAt,
        finished_at: scan.finishedAt ?? 0,
        roots: scan.roots.join(', '),
        files: scan.files,
        dirs: scan.dirs,
        bytes: scan.bytes,
        hashed: scan.hashed,
        errors: scan.errors,
        truncated: scan.truncated,
        elapsed_ms: scan.elapsedMs ?? 0,
        categories: categoryLine(store.categoryCounts(scan.id)),
        duplicate_groups: duplicates.groups,
        duplicate_files: duplicates.files,
        zero_byte: duplicates.zeroByte,
        conflicts: store.conflictCount(scan.id),
        error: '',
      }
    },
  }))

  register(defineTool({
    name: 'af_files',
    description:
      'Page through indexed files for one scan. Names and paths are MASKED by default: only ids, categories and '
      + 'sizes are returned. Pass reveal=true only after the user explicitly asks to see particular files, and say '
      + 'in your reply that filenames leave the device when the tool result is sent to the model. Read-only.',
    parameters: {
      scan_id: P('number', 'scan to read; defaults to the latest'),
      category: P_ENUM(CATEGORIES, 'restrict to one category'),
      limit: P('number', `page size, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}`),
      offset: P('number', 'page offset'),
      reveal: P('boolean', 'return real names and relative paths; default false'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when files were listed', true),
          scan_id: P('number', 'scan id', true),
          total: P('number', 'total entries matching the filter', true),
          returned: P('number', 'entries returned in this page', true),
          offset: P('number', 'page offset', true),
          limit: P('number', 'page size', true),
          revealed: P('boolean', 'whether names are unmasked', true),
          items: {
            type: 'array',
            description: 'one object per file',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: P('number', 'index id', true),
                category: P('string', 'category', true),
                size: P('number', 'size in bytes', true),
                mtime_ms: P('number', 'modification time in epoch milliseconds', true),
                name: P('string', 'basename, masked unless revealed', true),
                rel_path: P('string', 'path relative to its root, masked unless revealed', true),
                masked: P('boolean', 'true when the name is masked', true),
                conflict: P('boolean', 'true when type evidence conflicts', true),
                protection: P('string', 'non-empty when the file is a partial download, split-volume member or side file', true),
              },
            },
          },
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_files ok · scan #${value.scan_id} · ${value.total} files · page ${value.offset + 1}-${value.offset + value.returned} · revealed=${value.revealed}`
          : `af_files ok=false · ${value.error}`
        const lines = [
          head,
          kv({
            ok: value.ok,
            scan_id: value.scan_id,
            total: value.total,
            returned: value.returned,
            offset: value.offset,
            limit: value.limit,
            revealed: value.revealed,
          }),
        ]
        if (value.ok) {
          lines.push('id\tcategory\tsize\tmasked\tconflict\tprotection\trel_path')
          for (const item of value.items) {
            lines.push(`${item.id}\t${item.category}\t${fmtBytes(item.size)}\t${item.masked}\t${item.conflict}\t${item.protection || '-'}\t${item.rel_path}`)
          }
          if (value.items.length === 0) lines.push('(no rows)')
          if (!value.revealed) {
            lines.push('note: names and paths are masked; only ids, categories and sizes were disclosed')
          }
        }
        if (value.error) lines.push(`error=${value.error}`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const reveal = args.reveal === true
      const base = { ok: true, scan_id: 0, total: 0, returned: 0, offset, limit, revealed: reveal, items: [], error: '' }
      let store
      try {
        store = await ensureStore(state)
        const scan = requireScan(store, args.scan_id)
        const { total, items } = store.listFiles(scan.id, { category: args.category, limit, offset })
        return {
          ...base,
          scan_id: scan.id,
          total,
          returned: items.length,
          items: items.map((item) => ({
            id: item.id,
            category: item.category,
            size: item.size,
            mtime_ms: item.mtimeMs,
            name: reveal ? item.name : maskName(item),
            rel_path: reveal ? item.relPath : maskName(item),
            masked: !reveal,
            conflict: item.conflict,
            protection: redactProtection(item.protection, reveal),
          })),
        }
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, ok: false, error: `${info.code}: ${info.message}` }
      }
    },
  }))

  register(defineTool({
    name: 'af_duplicates',
    description:
      'List duplicate groups for one scan: files with identical size and identical SHA-256 content. Members are '
      + 'masked by default; pass reveal=true only when the user asks which files are duplicated. This tool only '
      + 'reports — it never isolates or deletes anything. Zero-byte files are counted separately and never grouped.',
    parameters: {
      scan_id: P('number', 'scan to read; defaults to the latest'),
      limit: P('number', `page size, default 20, max ${MAX_LIMIT}`),
      offset: P('number', 'page offset'),
      reveal: P('boolean', 'return real names and relative paths; default false'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when groups were listed', true),
          scan_id: P('number', 'scan id', true),
          groups: P('number', 'total duplicate groups', true),
          returned: P('number', 'groups returned in this page', true),
          offset: P('number', 'page offset', true),
          wasted_bytes: P('number', 'bytes held by redundant copies in this page', true),
          protected_groups: P('number', 'groups skipped because a member is a partial download or split volume', true),
          protected_bytes: P('number', 'redundant bytes inside those skipped groups', true),
          zero_byte: P('number', 'zero-byte files excluded from grouping', true),
          revealed: P('boolean', 'whether names are unmasked', true),
          items: {
            type: 'array',
            description: 'one object per duplicate group',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                group_id: P('number', 'page-local group number', true),
                size: P('number', 'size of each member in bytes', true),
                count: P('number', 'number of members', true),
                protected: P('boolean', 'true when the group may not be actioned because a member is protected', true),
                members: {
                  type: 'array',
                  description: 'group members',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: P('number', 'index id', true),
                      name: P('string', 'basename, masked unless revealed', true),
                      rel_path: P('string', 'relative path, masked unless revealed', true),
                    },
                  },
                },
              },
            },
          },
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_duplicates ok · scan #${value.scan_id} · ${value.groups} groups · page saves ${fmtBytes(value.wasted_bytes)}`
          : `af_duplicates ok=false · ${value.error}`
        const lines = [
          head,
          kv({
            ok: value.ok,
            scan_id: value.scan_id,
            groups: value.groups,
            returned: value.returned,
            offset: value.offset,
            wasted_bytes: value.wasted_bytes,
            protected_groups: value.protected_groups,
            protected_bytes: value.protected_bytes,
            zero_byte: value.zero_byte,
            revealed: value.revealed,
          }),
        ]
        if (value.ok) {
          for (const group of value.items) {
            lines.push(`#${group.group_id} ${fmtBytes(group.size)} × ${group.count}${group.protected ? ' [protected: skipped]' : ''}`)
            for (const member of group.members) lines.push(`  ${member.id}\t${member.rel_path}`)
          }
          if (value.items.length === 0) lines.push('(no duplicate groups)')
          if (!value.revealed) lines.push('note: member names are masked')
        }
        if (value.error) lines.push(`error=${value.error}`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const limit = clampInt(args.limit, 20, 1, MAX_LIMIT)
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const reveal = args.reveal === true
      const base = { ok: true, scan_id: 0, groups: 0, returned: 0, offset, wasted_bytes: 0, protected_groups: 0, protected_bytes: 0, zero_byte: 0, revealed: reveal, items: [], error: '' }
      let store
      try {
        store = await ensureStore(state)
        const scan = requireScan(store, args.scan_id)
        const page = store.duplicateGroups(scan.id, { limit, offset })
        const duplicates = store.duplicateStats(scan.id)
        return {
          ...base,
          scan_id: scan.id,
          groups: page.total,
          returned: page.items.length,
          wasted_bytes: page.wasted,
          protected_groups: duplicates.protectedGroups,
          protected_bytes: duplicates.protectedBytes,
          zero_byte: duplicates.zeroByte,
          items: page.items.map((group) => ({
            group_id: group.groupId,
            size: group.size,
            count: group.count,
            protected: group.protected,
            members: group.members.map((member) => ({
              id: member.id,
              name: reveal ? member.name : `#${member.id}`,
              rel_path: reveal ? member.relPath : `#${member.id}`,
            })),
          })),
        }
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, ok: false, error: `${info.code}: ${info.message}` }
      }
    },
  }))

  register(defineTool({
    name: 'af_names',
    description:
      'List numbered-filename findings for one scan: names whose only difference is a trailing (1)/(2) style counter, '
      + 'names whose counter sits after the extension, and suspicious entries (type conflicts, or APK-looking names '
      + 'that fail the ZIP structure check). Reports a canonical candidate only; it never renames anything. '
      + 'Numbers may be versions or years, so findings are marked needs_confirmation rather than assumed to be copies.',
    parameters: {
      scan_id: P('number', 'scan to read; defaults to the latest'),
      kind: P_ENUM(['numbered', 'suspicious', 'all'], 'which findings to list; default numbered'),
      limit: P('number', `page size, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}`),
      offset: P('number', 'page offset'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when findings were listed', true),
          scan_id: P('number', 'scan id', true),
          kind: P('string', 'the requested filter', true),
          total: P('number', 'total matching entries', true),
          returned: P('number', 'entries returned in this page', true),
          offset: P('number', 'page offset', true),
          items: {
            type: 'array',
            description: 'one object per finding',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: P('number', 'index id', true),
                name: P('string', 'basename as stored', true),
                canonical_name: P('string', 'candidate normalised name', true),
                number: P('string', 'the counter digits, empty when none', true),
                number_form: P('string', 'before-ext, after-ext, tail, or empty', true),
                category: P('string', 'category', true),
                apk_verdict: P('string', 'ZIP structure verdict for numbered .apk files', true),
                flags: P('string', 'comma separated analysis flags', true),
                conflict: P('boolean', 'true when type evidence conflicts', true),
              },
            },
          },
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_names ok · scan #${value.scan_id} · kind=${value.kind} · ${value.total} findings · page ${value.offset + 1}-${value.offset + value.returned}`
          : `af_names ok=false · ${value.error}`
        const lines = [
          head,
          kv({
            ok: value.ok,
            scan_id: value.scan_id,
            kind: value.kind,
            total: value.total,
            returned: value.returned,
            offset: value.offset,
          }),
        ]
        if (value.ok) {
          for (const item of value.items) {
            const tail = item.number ? ` -> ${item.canonical_name}` : ''
            const apk = item.apk_verdict ? ` apk=${item.apk_verdict}` : ''
            const flags = item.flags ? ` flags=${item.flags}` : ''
            lines.push(`${item.id}\t${item.name}${tail}\t${item.number_form || 'plain'}${apk}${flags}`)
          }
          if (value.items.length === 0) lines.push('(no findings)')
        }
        if (value.error) lines.push(`error=${value.error}`)
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const kind = args.kind ?? 'numbered'
      const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const base = { ok: true, scan_id: 0, kind, total: 0, returned: 0, offset, items: [], error: '' }
      let store
      try {
        store = await ensureStore(state)
        const scan = requireScan(store, args.scan_id)
        const page = store.numberedFiles(scan.id, { kind, limit, offset })
        return {
          ...base,
          scan_id: scan.id,
          total: page.total,
          returned: page.items.length,
          items: page.items.map((item) => ({
            id: item.id,
            name: item.name,
            canonical_name: item.canonicalName,
            number: item.number ?? '',
            number_form: item.numberForm ?? '',
            category: item.category,
            apk_verdict: item.apkVerdict,
            flags: item.flags.join(','),
            conflict: item.conflict,
          })),
        }
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, ok: false, error: `${info.code}: ${info.message}` }
      }
    },
  }))

  register(defineTool({
    name: 'af_plan_create',
    description:
      'Build an immutable dedupe plan for one scan: for every group of byte-identical files keep one and move the '
      + 'rest into the quarantine directory. Writes nothing to user files; it only records the plan and its digest. '
      + 'Groups holding a protected member (partial download, split volume, side file) are skipped and reported. '
      + 'Any later change to the plan produces a new plan id and a new digest, invalidating earlier approvals.',
    parameters: {
      scan_id: P('number', 'scan to plan against; defaults to the latest'),
      mode: P_ENUM([...PLAN_MODES], 'plan mode; only dedupe exists'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when a plan with at least one operation was stored', true),
          plan_id: P('number', 'plan id used by preview and apply', true),
          scan_id: P('number', 'scan the plan was built from', true),
          mode: P('string', 'plan mode', true),
          digest: P('string', 'sha256 over the canonical plan; approvals bind to it', true),
          ops: P('number', 'number of operations', true),
          keep: P('number', 'files kept in place', true),
          skipped_groups: P('number', 'duplicate groups skipped because a member is protected', true),
          skipped_bytes: P('number', 'redundant bytes inside those skipped groups', true),
          planned_bytes: P('number', 'bytes proposed to move into quarantine', true),
          quarantine_dir: P('string', 'quarantine root used by this plan', true),
          note: P('string', 'extra context'),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_plan_create ok · plan #${value.plan_id} · ${value.ops} ops · ${fmtBytes(value.planned_bytes)}`
          : `af_plan_create ok=false · ${value.error}`
        return text([
          head,
          kv({
            ok: value.ok,
            plan_id: value.plan_id,
            scan_id: value.scan_id,
            mode: value.mode,
            ops: value.ops,
            keep: value.keep,
            planned_bytes: value.planned_bytes,
            skipped_groups: value.skipped_groups,
            skipped_bytes: value.skipped_bytes,
          }),
          value.digest ? `digest=${value.digest}` : '',
          value.quarantine_dir ? `quarantine_dir=${value.quarantine_dir}` : '',
          value.note ? `note: ${value.note}` : '',
          value.error ? `error=${value.error}` : '',
        ].filter(Boolean).join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { config } = state
      const base = {
        ok: false,
        plan_id: 0,
        scan_id: 0,
        mode: args.mode ?? 'dedupe',
        digest: '',
        ops: 0,
        keep: 0,
        skipped_groups: 0,
        skipped_bytes: 0,
        planned_bytes: 0,
        quarantine_dir: config.quarantineDir,
        note: '',
        error: '',
      }
      if (!config.quarantineDir) {
        return { ...base, error: `${CODE.QUARANTINE_MISSING}: quarantineDir is not configured` }
      }
      let store
      try {
        store = await ensureStore(state)
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, error: `${info.code}: ${info.message}` }
      }
      let scan
      try {
        scan = requireScan(store, args.scan_id)
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, error: `${info.code}: ${info.message}` }
      }

      const mode = PLAN_MODES.includes(args.mode) ? args.mode : 'dedupe'
      const planId = store.createPlan(scan.id, mode, DEDUPE_POLICY)
      const built = buildDedupePlan({
        groups: store.duplicateMemberGroups(scan.id),
        scanId: scan.id,
        planId,
        quarantineDir: config.quarantineDir,
      })
      const digest = planDigest(planId, mode, built.policy, built.ops)
      store.finalizePlan(planId, { digest, ops: built.ops, ...built })

      const note = built.skippedReasons.length > 0
        ? `skipped ${built.skippedGroups} protected groups: ${built.skippedReasons.map((entry) => `${fmtBytes(entry.bytes)} (${entry.reason})`).join('; ')}`
        : ''
      if (built.ops.length === 0) {
        return {
          ...base,
          plan_id: planId,
          scan_id: scan.id,
          mode,
          digest,
          ops: 0,
          keep: built.keepCount,
          skipped_groups: built.skippedGroups,
          skipped_bytes: built.skippedBytes,
          note,
          error: `${CODE.PLAN_EMPTY}: nothing actionable in this scan`,
        }
      }
      return {
        ...base,
        ok: true,
        plan_id: planId,
        scan_id: scan.id,
        mode,
        digest,
        ops: built.ops.length,
        keep: built.keepCount,
        skipped_groups: built.skippedGroups,
        skipped_bytes: built.skippedBytes,
        planned_bytes: built.plannedBytes,
        note,
      }
    },
  }))

  register(defineTool({
    name: 'af_plan_preview',
    description:
      'Page through one stored plan exactly as it will execute: source, quarantine target, size and reason per '
      + 'operation, plus the counts of what was left alone. Read-only. Paths are masked unless the user asked to see '
      + 'them.',
    parameters: {
      plan_id: P('number', 'plan to preview; defaults to the latest'),
      limit: P('number', `page size, default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}`),
      offset: P('number', 'page offset'),
      reveal: P('boolean', 'return real paths; default false'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when the plan was found', true),
          plan_id: P('number', 'plan id', true),
          status: P('string', 'proposed, approved, rejected', true),
          mode: P('string', 'plan mode', true),
          digest: P('string', 'plan digest', true),
          total: P('number', 'number of operations in the plan', true),
          returned: P('number', 'operations in this page', true),
          offset: P('number', 'page offset', true),
          keep: P('number', 'files kept in place', true),
          planned_bytes: P('number', 'bytes proposed to move', true),
          skipped_groups: P('number', 'protected groups not touched', true),
          skipped_bytes: P('number', 'redundant bytes in those groups', true),
          revealed: P('boolean', 'whether paths are unmasked', true),
          items: {
            type: 'array',
            description: 'one object per operation',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                op_id: P('string', 'operation id', true),
                kind: P('string', 'operation kind', true),
                src: P('string', 'source path, masked unless revealed', true),
                dst: P('string', 'quarantine target, masked unless revealed', true),
                size: P('number', 'size in bytes', true),
                reason: P('string', 'why this operation exists', true),
                state: P('string', 'execution state once the plan has run: pending, copying, committed, source-removed, failed, skipped', true),
              },
            },
          },
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_plan_preview ok · plan #${value.plan_id} · ${value.status} · ${value.total} ops · ${fmtBytes(value.planned_bytes)}`
          : `af_plan_preview ok=false · ${value.error}`
        const lines = [
          head,
          kv({
            ok: value.ok,
            plan_id: value.plan_id,
            status: value.status,
            mode: value.mode,
            total: value.total,
            returned: value.returned,
            offset: value.offset,
            keep: value.keep,
            planned_bytes: value.planned_bytes,
            skipped_groups: value.skipped_groups,
            skipped_bytes: value.skipped_bytes,
            revealed: value.revealed,
          }),
          value.digest ? `digest=${value.digest}` : '',
        ]
        if (value.ok) {
          for (const item of value.items) {
            const state = item.state ? `\t[${item.state}]` : ''
            lines.push(`${item.op_id}\t${item.kind}\t${fmtBytes(item.size)}\t${item.src} -> ${item.dst}${state}`)
          }
          if (value.items.length === 0) lines.push('(no operations)')
          if (!value.revealed) lines.push('note: paths are masked')
        }
        if (value.error) lines.push(`error=${value.error}`)
        return text(lines.filter(Boolean).join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const reveal = args.reveal === true
      const base = {
        ok: false,
        plan_id: 0,
        status: '',
        mode: '',
        digest: '',
        total: 0,
        returned: 0,
        offset,
        keep: 0,
        planned_bytes: 0,
        skipped_groups: 0,
        skipped_bytes: 0,
        revealed: reveal,
        items: [],
        error: '',
      }
      let store
      try {
        store = await ensureStore(state)
        const plan = requirePlan(store, args.plan_id)
        // Execution states are only present once the plan has been attempted.
        const states = new Map(store.listPlanOps(plan.id).map((entry) => [entry.opId, entry.state]))
        const page = plan.ops.slice(offset, offset + limit)
        return {
          ...base,
          ok: true,
          plan_id: plan.id,
          status: plan.status,
          mode: plan.mode,
          digest: plan.digest,
          total: plan.ops.length,
          returned: page.length,
          keep: plan.keepCount,
          planned_bytes: plan.plannedBytes,
          skipped_groups: plan.skippedGroups,
          skipped_bytes: plan.skippedBytes,
          items: page.map((op) => ({
            op_id: op.opId,
            kind: op.kind,
            src: reveal ? op.srcPath : `#${op.fileId}`,
            dst: reveal ? op.dstPath : `#${op.fileId}`,
            size: op.size,
            reason: op.reason,
            state: states.get(op.opId) ?? '',
          })),
        }
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, error: `${info.code}: ${info.message}` }
      }
    },
  }))

  register(defineTool({
    name: 'af_plan_apply',
    description:
      'Request the user\'s approval for one stored plan and, only if the approval really comes back from the UI, '
      + 'mark it approved. Accepts nothing but a plan id: there is no argument that can assert approval, and the '
      + 'digest is re-verified before the request so an edited plan cannot ride on an older consent. This build '
      + 'does NOT move files yet — it reports the authorization result and stops.',
    parameters: {
      plan_id: P('number', 'plan to execute; required', true),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when the user approved and the plan moved to approved', true),
          plan_id: P('number', 'plan id', true),
          authorized: P('boolean', 'true only when the approval came back from the user-questions channel', true),
          executed: P('number', 'file operations performed by this call', true),
          executor: P('string', 'which executor handled the plan', true),
          digest: P('string', 'digest the approval was bound to', true),
          note: P('string', 'what happens next'),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => text([
        value.ok
          ? `af_plan_apply ok · plan #${value.plan_id} approved`
          : `af_plan_apply ok=false · ${value.error}`,
        kv({
          ok: value.ok,
          plan_id: value.plan_id,
          authorized: value.authorized,
          executed: value.executed,
          executor: value.executor,
        }),
        value.digest ? `digest=${value.digest}` : '',
        value.note ? `note: ${value.note}` : '',
        value.error ? `error=${value.error}` : '',
      ].filter(Boolean).join('\n')),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const base = {
        ok: false,
        plan_id: Number(args.plan_id) || 0,
        authorized: false,
        executed: 0,
        executor: 'none',
        digest: '',
        note: '',
        error: '',
      }
      let store
      try {
        store = await ensureStore(state)
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, error: `${info.code}: ${info.message}` }
      }
      let plan
      try {
        plan = requirePlan(store, args.plan_id)
        if (plan.ops.length === 0) {
          throw new AfError(CODE.PLAN_EMPTY, 'plan has no operations to approve')
        }
        if (plan.status !== 'proposed') {
          throw new AfError(CODE.PLAN_NOT_PROPOSED, `plan is ${plan.status}, not proposed`, { planId: plan.id })
        }
        assertPlanIntegrity(plan)
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, plan_id: plan?.id ?? base.plan_id, error: `${info.code}: ${info.message}` }
      }

      let decision
      try {
        decision = await requestPlanApproval(ctx, {
          planId: plan.id,
          digest: plan.digest,
          markdown: planText(plan),
          agent: exec.agent,
          signal: exec.signal,
        })
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, plan_id: plan.id, digest: plan.digest, error: `${info.code}: ${info.message}` }
      }

      if (!decision.approved) {
        store.rejectPlan(plan.id, `user did not approve (${decision.reason})`)
        return {
          ...base,
          plan_id: plan.id,
          digest: plan.digest,
          executor: 'none',
          note: 'nothing was executed',
          error: `${CODE.PLAN_REJECTED}: ${decision.reason}`,
        }
      }

      // Single-use, digest-bound transition: a replay or a second approval fails.
      const moved = store.approvePlan(plan.id, plan.digest, String(exec.callId ?? ''))
      if (!moved) {
        return {
          ...base,
          plan_id: plan.id,
          digest: plan.digest,
          authorized: true,
          note: 'plan already moved past proposed; nothing executed',
          error: `${CODE.PLAN_NOT_PROPOSED}: approval could not be recorded exactly once`,
        }
      }

      return {
        ...base,
        ok: true,
        plan_id: plan.id,
        digest: plan.digest,
        authorized: true,
        executed: 0,
        executor: 'not-implemented',
        note: 'authorization recorded; run af_plan_execute to perform the operations',
      }
    },
  }))

  register(defineTool({
    name: 'af_plan_execute',
    description:
      'Execute an already approved plan: for each operation re-prove the source (dev, ino, size, mtime, SHA-256), '
      + 'create the quarantine target with exclusive semantics, fsync and re-hash it, then remove the source. '
      + 'An existing target aborts that operation; a changed source aborts that operation; the source is only '
      + 'removed after the copy verifies. Every step is journalled, and an interrupted run stops at a state a human '
      + 'can inspect. Requires plan status approved.',
    parameters: {
      plan_id: P('number', 'approved plan to execute; required', true),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when every operation committed', true),
          plan_id: P('number', 'plan id', true),
          status: P('string', 'committed or needs-review', true),
          committed: P('number', 'operations whose source was removed after verification', true),
          skipped: P('number', 'operations not started because the run was cancelled', true),
          failed: P('number', 'operations that stopped without touching the source', true),
          bytes: P('number', 'bytes moved into quarantine', true),
          duration_ms: P('number', 'wall clock duration', true),
          quarantine_dir: P('string', 'quarantine root used', true),
          failures_text: P('string', 'one line per failed operation'),
          note: P('string', 'summary written to the plan'),
          error: P('string', 'error code and message when nothing ran'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_plan_execute ok · plan #${value.plan_id} committed · ${value.committed} files · ${fmtBytes(value.bytes)}`
          : `af_plan_execute ok=false · plan #${value.plan_id} · ${value.error || value.status}`
        return text([
          head,
          kv({
            ok: value.ok,
            plan_id: value.plan_id,
            status: value.status,
            committed: value.committed,
            skipped: value.skipped,
            failed: value.failed,
            bytes: value.bytes,
            duration_ms: value.duration_ms,
          }),
          `quarantine_dir=${value.quarantine_dir}`,
          value.note ? `note: ${value.note}` : '',
          value.failures_text ? `failures:\n${indentBlock(value.failures_text)}` : '',
          value.error ? `error=${value.error}` : '',
        ].filter(Boolean).join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const { config } = state
      const base = {
        ok: false,
        plan_id: Number(args.plan_id) || 0,
        status: '',
        committed: 0,
        skipped: 0,
        failed: 0,
        bytes: 0,
        duration_ms: 0,
        quarantine_dir: config.quarantineDir,
        failures_text: '',
        note: '',
        error: '',
      }
      if (!config.quarantineDir) {
        return { ...base, error: `${CODE.QUARANTINE_MISSING}: quarantineDir is not configured` }
      }
      if (state.executing) {
        return { ...base, error: `${CODE.BUSY}: another plan is being executed` }
      }

      let store
      let plan
      try {
        store = await ensureStore(state)
        plan = requirePlan(store, args.plan_id)
        if (plan.status !== 'approved') {
          throw new AfError(CODE.PLAN_NOT_PROPOSED, `plan is ${plan.status}; approve it first`, { planId: plan.id })
        }
        assertPlanIntegrity(plan)
        await assertWritableBase(config, config.quarantineDir)
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, plan_id: plan?.id ?? base.plan_id, error: `${info.code}: ${info.message}` }
      }

      state.executing = true
      const started = Date.now()
      try {
        const result = await executePlan(store, plan, {
          quarantineDir: config.quarantineDir,
          signal: exec.signal,
        })
        // A completed restore closes the loop: the forward plan is now known to
        // be undone, and its quarantine directory is empty by construction.
        if (result.status === 'committed' && plan.mode === 'restore' && plan.sourcePlanId) {
          const marked = store.markRestored(plan.sourcePlanId, `由恢复计划 #${plan.id} 归还`)
          if (marked) {
            await fsp.rmdir(path.join(config.quarantineDir, String(plan.sourcePlanId))).catch(() => {})
          }
        }
        return {
          ...base,
          ok: result.status === 'committed',
          plan_id: plan.id,
          status: result.status,
          committed: result.committed,
          skipped: result.skipped,
          failed: result.failed,
          bytes: result.bytes,
          duration_ms: Date.now() - started,
          failures_text: result.failures
            .slice(0, 20)
            .map((failure) => `${failure.opId}: ${failure.message}`)
            .join('\n'),
          note: result.note,
          error: result.status === 'committed' ? '' : `${CODE.IO}: some operations need review, see failures`,
        }
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, plan_id: plan.id, duration_ms: Date.now() - started, error: `${info.code}: ${info.message}` }
      } finally {
        state.executing = false
      }
    },
  }))

  register(defineTool({
    name: 'af_plan_list',
    description:
      'List stored plans with their status, digest prefix and operation counts. Read-only. A proposed or approved '
      + 'plan whose scan is no longer the latest is marked stale: it is not wrong, but every operation will be '
      + 're-validated against the world when it runs.',
    parameters: {
      limit: P('number', 'how many plans to list, default 20, max 100'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when the list was produced', true),
          total: P('number', 'plans returned', true),
          latest_scan_id: P('number', 'latest scan id, 0 when none', true),
          items: {
            type: 'array',
            description: 'one object per plan, newest first',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                plan_id: P('number', 'plan id', true),
                mode: P('string', 'dedupe or restore', true),
                status: P('string', 'proposed, approved, executing, committed, needs-review, rejected', true),
                ops: P('number', 'operation count', true),
                planned_bytes: P('number', 'bytes the plan proposes to move', true),
                scan_id: P('number', 'scan it was built from', true),
                source_plan_id: P('number', 'for a restore plan, the plan it undoes; 0 otherwise', true),
                restored_by: P('number', 'for a plan whose files were put back, the restore plan id; 0 otherwise', true),
                digest8: P('string', 'first 8 hex characters of the digest', true),
                created_at: P('number', 'epoch milliseconds', true),
                stale: P('boolean', 'true when a pending plan refers to an older scan', true),
                note: P('string', 'summary note, empty when none', true),
              },
            },
          },
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`af_plan_list ok=false · ${value.error}`)
        const lines = [
          `af_plan_list ok · ${value.total} plans · latest_scan_id=${value.latest_scan_id}`,
          kv({ ok: value.ok, total: value.total, latest_scan_id: value.latest_scan_id }),
          'id\tmode\tstatus\tops\tbytes\tdigest\tstale',
        ]
        for (const item of value.items) {
          const link = item.source_plan_id > 0
            ? ` undoes=#${item.source_plan_id}`
            : item.restored_by > 0 ? ` restored_by=#${item.restored_by}` : ''
          lines.push(`${item.plan_id}\t${item.mode}\t${item.status}\t${item.ops}\t${item.planned_bytes}\t${item.digest8}\t${item.stale}${link}`)
        }
        if (value.items.length === 0) lines.push('(no plans)')
        return text(lines.join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const limit = clampInt(args.limit, 20, 1, 100)
      let store
      try {
        store = await ensureStore(state)
        const latest = store.getScan()
        const latestId = latest ? latest.id : 0
        const plans = store.listPlans(limit)
        return {
          ok: true,
          total: plans.length,
          latest_scan_id: latestId,
          items: plans.map((plan) => ({
            plan_id: plan.id,
            mode: plan.mode,
            status: plan.status,
            ops: plan.opsCount,
            planned_bytes: plan.plannedBytes,
            scan_id: plan.scanId,
            source_plan_id: plan.sourcePlanId ?? 0,
            restored_by: plan.restoredBy ?? 0,
            digest8: plan.digest.slice(0, 8),
            created_at: plan.createdAt,
            stale: (plan.status === 'proposed' || plan.status === 'approved')
              && latestId > 0
              && plan.scanId !== latestId,
            note: plan.note ?? '',
          })),
          error: '',
        }
      } catch (err) {
        const info = errorInfo(err)
        return { ok: false, total: 0, latest_scan_id: 0, items: [], error: `${info.code}: ${info.message}` }
      }
    },
  }))

  register(defineTool({
    name: 'af_storage',
    description:
      'Report quarantine usage and free space: bytes held per plan, totals, and statfs on the quarantine volume. '
      + 'Read-only. Quarantined files are not deleted, so their bytes are NOT free space — this reports what is '
      + 'held, not what was reclaimed.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when the report was produced', true),
          quarantine_dir: P('string', 'quarantine root, absolute', true),
          exists: P('boolean', 'whether the quarantine root exists yet', true),
          plans: P('number', 'plan directories found', true),
          files: P('number', 'quarantined files', true),
          bytes: P('number', 'bytes held in quarantine', true),
          free_bytes: P('number', 'free space on the quarantine volume', true),
          total_bytes: P('number', 'total space on the quarantine volume', true),
          items_text: P('string', 'one line per plan directory'),
          note: P('string', 'what the numbers do and do not mean'),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`af_storage ok=false · ${value.error}`)
        return text([
          `af_storage ok · ${value.files} files / ${fmtBytes(value.bytes)} in quarantine · free ${fmtBytes(value.free_bytes)}`,
          kv({
            ok: value.ok,
            quarantine_dir: value.quarantine_dir,
            exists: value.exists,
            plans: value.plans,
            files: value.files,
            bytes: value.bytes,
            free_bytes: value.free_bytes,
            total_bytes: value.total_bytes,
          }),
          value.items_text,
          `note: ${value.note}`,
        ].filter(Boolean).join('\n'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      throwIfAborted(exec.signal)
      const { config } = state
      const base = {
        ok: false,
        quarantine_dir: config.quarantineDir,
        exists: false,
        plans: 0,
        files: 0,
        bytes: 0,
        free_bytes: 0,
        total_bytes: 0,
        items_text: '',
        note: '',
        error: '',
      }
      if (!config.quarantineDir) {
        return { ...base, error: `${CODE.QUARANTINE_MISSING}: quarantineDir is not configured` }
      }

      let statfs = null
      try {
        statfs = await fsp.statfs(config.quarantineDir)
      } catch {
        try {
          statfs = await fsp.statfs(config.dataDir)
        } catch {
          statfs = null
        }
      }

      const lines = []
      let plans = 0
      let files = 0
      let bytes = 0
      let exists = true
      try {
        const entries = await fsp.readdir(config.quarantineDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          plans++
          let planFiles = 0
          let planBytes = 0
          try {
            const children = await fsp.readdir(path.join(config.quarantineDir, entry.name), { withFileTypes: true })
            for (const child of children) {
              if (!child.isFile()) continue
              try {
                const stat = await fsp.lstat(path.join(config.quarantineDir, entry.name, child.name))
                planFiles++
                planBytes += Number(stat.size)
              } catch {
                /* a disappeared entry is simply not counted */
              }
            }
          } catch {
            /* an unreadable plan directory is still listed */
          }
          files += planFiles
          bytes += planBytes
          lines.push(`${entry.name}\t${planFiles} files\t${planBytes} bytes`)
        }
      } catch (error) {
        if (error?.code === 'ENOENT') {
          exists = false
          lines.push('(quarantine directory does not exist yet)')
        } else {
          const info = errorInfo(error)
          return { ...base, error: `${info.code}: ${info.message}` }
        }
      }

      return {
        ...base,
        ok: true,
        exists,
        plans,
        files,
        bytes,
        free_bytes: statfs ? Number(statfs.bavail) * Number(statfs.bsize) : 0,
        total_bytes: statfs ? Number(statfs.blocks) * Number(statfs.bsize) : 0,
        items_text: lines.join('\n'),
        note: '隔离区的文件没有被删除，所以这些字节不构成已释放空间；真正回收需要你自己确认后再清空。',
      }
    },
  }))

  register(defineTool({
    name: 'af_plan_restore',
    description:
      'Build a restore plan that moves quarantined files back to their original paths. It creates a new immutable '
      + 'plan and moves nothing: approve it with af_plan_apply and run it with af_plan_execute. Original paths that '
      + 'now hold a different file are skipped, never overwritten. The quarantined copy is re-hashed before it '
      + 'becomes the source of the restore.',
    parameters: {
      plan_id: P('number', 'the committed plan to undo; required', true),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: P('boolean', 'true when a restore plan with at least one operation was stored', true),
          source_plan_id: P('number', 'the plan being undone', true),
          plan_id: P('number', 'new restore plan id', true),
          digest: P('string', 'digest of the restore plan', true),
          ops: P('number', 'restore operations', true),
          skipped: P('number', 'entries skipped because the original path is occupied or the copy is gone', true),
          planned_bytes: P('number', 'bytes to move back', true),
          skipped_text: P('string', 'one line per skipped entry'),
          note: P('string', 'what to do next'),
          error: P('string', 'error code and message when ok is false'),
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `af_plan_restore ok · plan #${value.plan_id} restores plan #${value.source_plan_id} · ${value.ops} ops`
          : `af_plan_restore ok=false · ${value.error}`
        return text([
          head,
          kv({
            ok: value.ok,
            source_plan_id: value.source_plan_id,
            plan_id: value.plan_id,
            ops: value.ops,
            skipped: value.skipped,
            planned_bytes: value.planned_bytes,
          }),
          value.digest ? `digest=${value.digest}` : '',
          value.skipped_text ? `skipped:\n${indentBlock(value.skipped_text)}` : '',
          value.note ? `note: ${value.note}` : '',
          value.error ? `error=${value.error}` : '',
        ].filter(Boolean).join('\n'))
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const base = {
        ok: false,
        source_plan_id: Number(args.plan_id) || 0,
        plan_id: 0,
        digest: '',
        ops: 0,
        skipped: 0,
        planned_bytes: 0,
        skipped_text: '',
        note: '',
        error: '',
      }
      let store
      let source
      try {
        store = await ensureStore(state)
        source = requirePlan(store, args.plan_id)
        if (source.mode !== 'dedupe') {
          throw new AfError(CODE.PLAN_NOT_PROPOSED, `plan #${source.id} is a ${source.mode} plan, not dedupe`)
        }
        if (source.status !== 'committed' && source.status !== 'needs-review') {
          throw new AfError(CODE.PLAN_NOT_PROPOSED, `plan #${source.id} is ${source.status}; nothing to restore`)
        }
      } catch (err) {
        const info = errorInfo(err)
        return { ...base, error: `${info.code}: ${info.message}` }
      }

      const opsById = new Map(source.ops.map((op) => [op.opId, op]))
      const rows = store.listPlanOps(source.id)
      const entries = []
      const skippedLines = []
      for (const row of [...rows].reverse()) {
        throwIfAborted(exec.signal)
        if (row.state !== 'source-removed' && row.state !== 'committed') {
          skippedLines.push(`${row.opId}: state ${row.state}`)
          continue
        }
        const original = opsById.get(row.opId)
        if (!original) {
          skippedLines.push(`${row.opId}: operation not found in the stored plan`)
          continue
        }
        const quarantinePath = original.dstPath
        let stat
        try {
          stat = await fsp.lstat(quarantinePath)
        } catch {
          skippedLines.push(`${row.opId}: quarantined copy is missing`)
          continue
        }
        if (!stat.isFile()) {
          skippedLines.push(`${row.opId}: quarantined entry is not a file`)
          continue
        }
        let occupied = false
        try {
          await fsp.lstat(original.srcPath)
          occupied = true
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            skippedLines.push(`${row.opId}: cannot inspect original path (${String(error?.code ?? 'error')})`)
            continue
          }
        }
        if (occupied) {
          skippedLines.push(`${row.opId}: original path is occupied, refusing to overwrite`)
          continue
        }
        const digest = await sha256File(quarantinePath, { signal: exec.signal })
        entries.push({
          fileId: row.fileId,
          quarantinePath,
          originalPath: original.srcPath,
          size: Number(stat.size),
          dev: String(stat.dev),
          ino: String(stat.ino),
          mtimeMs: Math.trunc(Number(stat.mtimeMs)),
          hash: digest.sha256,
        })
      }

      if (entries.length === 0) {
        return {
          ...base,
          source_plan_id: source.id,
          skipped: skippedLines.length,
          skipped_text: skippedLines.join('\n'),
          error: `${CODE.PLAN_EMPTY}: nothing restorable in this plan`,
        }
      }

      const built = buildRestorePlan(entries)
      const planId = store.createPlan(source.scanId, 'restore', RESTORE_POLICY, source.id)
      const digest = planDigest(planId, 'restore', built.policy, built.ops)
      store.finalizePlan(planId, {
        digest,
        ops: built.ops,
        keepCount: 0,
        skippedGroups: 0,
        skippedBytes: 0,
        plannedBytes: built.plannedBytes,
      })
      return {
        ...base,
        ok: true,
        source_plan_id: source.id,
        plan_id: planId,
        digest,
        ops: built.ops.length,
        skipped: skippedLines.length,
        planned_bytes: built.plannedBytes,
        skipped_text: skippedLines.join('\n'),
        note: '计划已生成但未执行；用 af_plan_apply 审批，再用 af_plan_execute 执行。',
      }
    },
  }))

  return disposers
}

function emptyReport() {
  return {
    ok: false,
    scan_id: 0,
    status: '',
    started_at: 0,
    finished_at: 0,
    roots: '',
    files: 0,
    dirs: 0,
    bytes: 0,
    hashed: 0,
    errors: 0,
    truncated: false,
    elapsed_ms: 0,
    categories: '',
    duplicate_groups: 0,
    duplicate_files: 0,
    zero_byte: 0,
    conflicts: 0,
    error: '',
  }
}

function failScan(code, message, scanId = 0) {
  return {
    ok: false,
    scan_id: scanId,
    status: code === CODE.ABORTED ? 'cancelled' : 'failed',
    files: 0,
    dirs: 0,
    bytes: 0,
    hashed: 0,
    reused: 0,
    duplicate_groups: 0,
    duplicate_files: 0,
    zero_byte: 0,
    protected: 0,
    peak_rss_mb: 0,
    skipped: 0,
    errors: 0,
    truncated: false,
    elapsed_ms: 0,
    categories: '',
    note: '',
    error: `${code}: ${message}`,
  }
}

/**
 * Hash only same-size candidates: identical content requires identical size, so
 * unique sizes never pay for a full read.
 */
async function hashCandidates(store, scanId, targets, signal, onProgress) {
  const realByRoot = new Map(targets.map((target) => [target.input, target.real]))
  let hashed = 0
  let reused = 0
  let errors = 0
  for (const group of store.sizeGroups(scanId)) {
    const files = store.filesBySize(scanId, group.size)
    for (const file of files) {
      throwIfAborted(signal)
      const identityKnown = file.ino !== '' && file.ino !== '0'
      const cached = identityKnown ? store.hashCacheGet(file.dev, file.ino, file.size, file.mtimeMs) : null
      if (cached) {
        store.setFileHash(file.id, cached, 'reused')
        reused++
        continue
      }
      const rootReal = realByRoot.get(file.root)
      if (!rootReal) {
        errors++
        continue
      }
      try {
        const { sha256 } = await sha256File(path.join(rootReal, file.relPath), { signal })
        store.setFileHash(file.id, sha256, 'hashed')
        if (identityKnown) store.hashCachePut(file.dev, file.ino, file.size, file.mtimeMs, sha256)
        hashed++
      } catch (err) {
        if (err instanceof AfError && err.code === CODE.ABORTED) throw err
        errors++
        store.setFileHash(file.id, null, 'error')
      }
    }
  }
  onProgress({ errors })
  return { hashed, reused, errors }
}
