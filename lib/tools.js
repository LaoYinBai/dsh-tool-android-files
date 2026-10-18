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

function requireScan(store, requested) {
  const scan = store.getScan(requested)
  if (!scan) {
    const hint = requested === undefined || requested === null ? 'no scan has been recorded yet' : `scan ${requested} does not exist`
    throw new AfError(CODE.SCAN_NOT_FOUND, hint)
  }
  return scan
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
          lines.push('id\tcategory\tsize\tmasked\tconflict\trel_path')
          for (const item of value.items) {
            lines.push(`${item.id}\t${item.category}\t${fmtBytes(item.size)}\t${item.masked}\t${item.conflict}\t${item.rel_path}`)
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
            zero_byte: value.zero_byte,
            revealed: value.revealed,
          }),
        ]
        if (value.ok) {
          for (const group of value.items) {
            lines.push(`#${group.group_id} ${fmtBytes(group.size)} × ${group.count}`)
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
      const base = { ok: true, scan_id: 0, groups: 0, returned: 0, offset, wasted_bytes: 0, zero_byte: 0, revealed: reveal, items: [], error: '' }
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
          zero_byte: duplicates.zeroByte,
          items: page.items.map((group) => ({
            group_id: group.groupId,
            size: group.size,
            count: group.count,
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
