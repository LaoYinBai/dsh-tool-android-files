/**
 * SQLite persistence for the file index.
 *
 * `node:sqlite` is the only SQLite available on the target device: there is no
 * compiler and no prebuilt native module, so `better-sqlite3` and friends are
 * not an option. WAL mode is used so a cancelled scan does not block readers.
 * @module af/db
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { AfError, CODE } from './errors.js'

export const SCHEMA_VERSION = 5

/**
 * Plans are immutable once written: `ops_json` and `digest` are never updated
 * after finalization, only `status`/`approved_at` move forward.
 */
const PLAN_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  digest TEXT NOT NULL DEFAULT '',
  policy_json TEXT NOT NULL,
  ops_json TEXT NOT NULL DEFAULT '[]',
  keep_count INTEGER NOT NULL DEFAULT 0,
  skipped_groups INTEGER NOT NULL DEFAULT 0,
  skipped_bytes INTEGER NOT NULL DEFAULT 0,
  planned_bytes INTEGER NOT NULL DEFAULT 0,
  approved_at INTEGER,
  approve_call_id TEXT,
  executed_at INTEGER,
  source_plan_id INTEGER,
  note TEXT
);
`

/**
 * Per-operation execution state and the append-only journal.
 *
 * A plan's `ops_json` is the immutable intent; these rows are the mutable record
 * of how far reality got. They are written before and after every filesystem
 * side effect, so a crash leaves a trail that can be reconciled instead of
 * guessed.
 */
const EXECUTION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS plan_ops (
  plan_id INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  src_path TEXT NOT NULL,
  dst_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, op_id)
);
CREATE TABLE IF NOT EXISTS execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_exec_log_plan ON execution_log(plan_id, id);
`

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  roots_json TEXT NOT NULL,
  files INTEGER NOT NULL DEFAULT 0,
  dirs INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  hashed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,
  root TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  dev TEXT NOT NULL DEFAULT '',
  ino TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  rule_id TEXT,
  conflict INTEGER NOT NULL DEFAULT 0,
  conflict_category TEXT,
  hash TEXT,
  hash_status TEXT NOT NULL DEFAULT 'none',
  number TEXT,
  number_form TEXT,
  base_name TEXT,
  canonical_name TEXT,
  flags TEXT,
  apk_verdict TEXT,
  protection TEXT NOT NULL DEFAULT '',
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_files_scan ON files(scan_id);
CREATE INDEX IF NOT EXISTS ix_files_size ON files(scan_id, size);
CREATE INDEX IF NOT EXISTS ix_files_hash ON files(scan_id, size, hash);
CREATE INDEX IF NOT EXISTS ix_files_cat ON files(scan_id, category);
CREATE TABLE IF NOT EXISTS hash_cache (
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  hash TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (dev, ino, size, mtime_ms)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;
${PLAN_TABLE_SQL}${EXECUTION_TABLE_SQL}
`

/**
 * Forward migrations, applied in order from the stored `user_version`.
 *
 * A phone already holding a v1 index must upgrade in place: the index is the
 * only record of previous scans, and rebuilding it would silently lose the
 * history a plan may refer to.
 */
const MIGRATIONS = [
  // v1 -> v2: multi-part and in-progress downloads become first-class.
  (db) => db.exec("ALTER TABLE files ADD COLUMN protection TEXT NOT NULL DEFAULT ''"),
  // v2 -> v3: immutable plans and their approval record.
  (db) => db.exec(PLAN_TABLE_SQL),
  // v3 -> v4: per-operation execution state and journal.
  (db) => {
    db.exec(EXECUTION_TABLE_SQL)
    // A v2 database created `plans` through the v3 migration, which may not have
    // carried `executed_at` yet; add it only when it is genuinely missing.
    const columns = db.prepare('PRAGMA table_info(plans)').all().map((row) => String(row.name))
    if (!columns.includes('executed_at')) db.exec('ALTER TABLE plans ADD COLUMN executed_at INTEGER')
  },
  // v4 -> v5: a restore plan remembers which plan it undoes.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(plans)').all().map((row) => String(row.name))
    if (!columns.includes('source_plan_id')) db.exec('ALTER TABLE plans ADD COLUMN source_plan_id INTEGER')
    backfillRestoreLinks(db)
  },
]

/**
 * Recover the forward plan a restore plan undid, for plans written before the
 * column existed.
 *
 * The evidence is already in the data: a restore operation's source lives at
 * `<quarantineDir>/<forwardPlanId>/<fileId>_<name>`, so the parent directory
 * name is the plan id. Once the link is known, a restore plan that already
 * committed marks its forward plan restored, which is what the older build could
 * not express.
 */
function backfillRestoreLinks(db) {
  const rows = db.prepare("SELECT id, ops_json FROM plans WHERE mode = 'restore' AND source_plan_id IS NULL").all()
  if (rows.length === 0) return
  const update = db.prepare('UPDATE plans SET source_plan_id = ? WHERE id = ?')
  for (const row of rows) {
    let ops
    try {
      ops = JSON.parse(row.ops_json ?? '[]')
    } catch {
      continue
    }
    const first = Array.isArray(ops) ? ops[0] : null
    if (!first || typeof first.srcPath !== 'string') continue
    const parent = path.basename(path.dirname(first.srcPath))
    if (!/^\d+$/.test(parent)) continue
    update.run(Number(parent), Number(row.id))
  }
  db.exec(`UPDATE plans SET status = 'restored'
    WHERE status IN ('committed','needs-review')
      AND id IN (SELECT source_plan_id FROM plans WHERE mode = 'restore' AND status = 'committed' AND source_plan_id IS NOT NULL)`)
}

function migrate(db) {  const row = db.prepare('PRAGMA user_version').get()
  const current = Number(row?.user_version ?? 0)
  if (current === 0) {
    db.exec(SCHEMA_SQL)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    return
  }
  if (current > SCHEMA_VERSION) {
    throw new AfError(CODE.DB, `index schema is newer than this plugin (${current} > ${SCHEMA_VERSION})`)
  }
  if (current < SCHEMA_VERSION) {
    for (let version = current; version < SCHEMA_VERSION; version++) {
      const step = MIGRATIONS[version - 1]
      if (typeof step === 'function') step(db)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }
}

/** Run `fn` inside one immediate transaction, rolling back on any throw. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* rollback of an already-closed transaction is not actionable */
    }
    throw err
  }
}

export async function openStore(dbPath) {
  await fsp.mkdir(path.dirname(dbPath), { recursive: true })
  let db
  try {
    db = new DatabaseSync(dbPath)
  } catch (err) {
    throw new AfError(CODE.DB, `cannot open index database: ${String(err?.message ?? err)}`, { dbPath })
  }
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db)

  const sqliteVersion = String(db.prepare('select sqlite_version() as v').get()?.v ?? '')
  const journalMode = String(db.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '')

  const stmt = {
    insertScan: db.prepare('INSERT INTO scans (started_at, status, roots_json) VALUES (?, ?, ?)'),
    finishScan: db.prepare(`UPDATE scans SET finished_at = ?, status = ?, files = ?, dirs = ?, bytes = ?,
      hashed = ?, skipped = ?, errors = ?, truncated = ?, elapsed_ms = ?, error = ? WHERE id = ?`),
    updateCounts: db.prepare('UPDATE scans SET files = ?, dirs = ?, bytes = ?, skipped = ?, errors = ? WHERE id = ?'),
    markScan: db.prepare('UPDATE scans SET status = ?, finished_at = ?, error = ? WHERE id = ?'),
    insertFile: db.prepare(`INSERT INTO files
      (scan_id, root, rel_path, name, ext, size, mtime_ms, dev, ino, category, rule_id, conflict,
       conflict_category, hash, hash_status, number, number_form, base_name, canonical_name, flags, apk_verdict,
       protection, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    setFileHash: db.prepare('UPDATE files SET hash = ?, hash_status = ? WHERE id = ?'),
    setApkVerdict: db.prepare('UPDATE files SET apk_verdict = ? WHERE id = ?'),
    getScan: db.prepare('SELECT * FROM scans WHERE id = ?'),
    latestScan: db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1'),
    sizeGroups: db.prepare(`SELECT size, COUNT(*) AS c FROM files
      WHERE scan_id = ? AND size > 0 AND error IS NULL GROUP BY size HAVING c > 1 ORDER BY size DESC`),
    filesBySize: db.prepare('SELECT * FROM files WHERE scan_id = ? AND size = ? AND error IS NULL ORDER BY id'),
    hashCacheGet: db.prepare('SELECT hash FROM hash_cache WHERE dev = ? AND ino = ? AND size = ? AND mtime_ms = ?'),
    hashCachePut: db.prepare(`INSERT OR REPLACE INTO hash_cache (dev, ino, size, mtime_ms, hash, computed_at)
      VALUES (?,?,?,?,?,?)`),
    duplicateGroupCount: db.prepare(`SELECT COUNT(*) AS c FROM (
      SELECT size, hash FROM files WHERE scan_id = ? AND hash IS NOT NULL AND size > 0
      GROUP BY size, hash HAVING COUNT(*) > 1)`),
    duplicateSummary: db.prepare(`SELECT size, COUNT(*) AS c,
        SUM(CASE WHEN protection <> '' THEN 1 ELSE 0 END) AS p
      FROM files WHERE scan_id = ? AND hash IS NOT NULL AND size > 0
      GROUP BY size, hash HAVING c > 1`),
    duplicateFileCount: db.prepare(`SELECT COUNT(*) AS c FROM files f
      WHERE f.scan_id = ? AND f.hash IS NOT NULL AND f.size > 0 AND EXISTS (
        SELECT 1 FROM files g WHERE g.scan_id = f.scan_id AND g.size = f.size AND g.hash = f.hash AND g.id <> f.id)`),
    zeroByte: db.prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ? AND size = 0'),
    categoryCounts: db.prepare('SELECT category, COUNT(*) AS c, SUM(size) AS b FROM files WHERE scan_id = ? GROUP BY category'),
    conflictCount: db.prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ? AND conflict = 1'),
    protectedCount: db.prepare("SELECT COUNT(*) AS c FROM files WHERE scan_id = ? AND protection <> ''"),
    countFiles: db.prepare('SELECT COUNT(*) AS c FROM files WHERE scan_id = ?'),
    sumBytes: db.prepare('SELECT COALESCE(SUM(size),0) AS b FROM files WHERE scan_id = ?'),
    reconcile: db.prepare(`UPDATE scans SET status = 'interrupted', finished_at = ?,
      error = COALESCE(error, 'engine restarted during scan') WHERE status = 'running'`),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)'),
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    insertPlan: db.prepare('INSERT INTO plans (scan_id, mode, status, created_at, policy_json, source_plan_id) VALUES (?, ?, ?, ?, ?, ?)'),
    finalizePlan: db.prepare(`UPDATE plans SET digest = ?, ops_json = ?, keep_count = ?, skipped_groups = ?,
      skipped_bytes = ?, planned_bytes = ? WHERE id = ? AND status = 'proposed'`),
    getPlan: db.prepare('SELECT * FROM plans WHERE id = ?'),
    listPlans: db.prepare('SELECT id, mode, status, created_at, digest, ops_json, keep_count, planned_bytes, skipped_groups, skipped_bytes, scan_id, source_plan_id, note FROM plans ORDER BY id DESC LIMIT ?'),
    markRestored: db.prepare("UPDATE plans SET status = 'restored', note = ? WHERE id = ? AND status IN ('committed','needs-review')"),
    latestPlan: db.prepare('SELECT * FROM plans ORDER BY id DESC LIMIT 1'),
    approvePlan: db.prepare(`UPDATE plans SET status = 'approved', approved_at = ?, approve_call_id = ?
      WHERE id = ? AND status = 'proposed' AND digest = ?`),
    rejectPlan: db.prepare("UPDATE plans SET status = 'rejected', note = ? WHERE id = ? AND status = 'proposed'"),
    beginExecution: db.prepare(`UPDATE plans SET status = 'executing', executed_at = ?
      WHERE id = ? AND status = 'approved'`),
    finishExecution: db.prepare('UPDATE plans SET status = ?, executed_at = ?, note = ? WHERE id = ?'),
    insertPlanOp: db.prepare(`INSERT OR REPLACE INTO plan_ops
      (plan_id, op_id, file_id, src_path, dst_path, size, state, error, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`),
    setPlanOpState: db.prepare('UPDATE plan_ops SET state = ?, error = ?, updated_at = ? WHERE plan_id = ? AND op_id = ?'),
    listPlanOps: db.prepare('SELECT * FROM plan_ops WHERE plan_id = ? ORDER BY op_id ASC'),
    insertLog: db.prepare('INSERT INTO execution_log (plan_id, op_id, at, event, detail) VALUES (?,?,?,?,?)'),
    listLog: db.prepare('SELECT * FROM execution_log WHERE plan_id = ? ORDER BY id DESC LIMIT ?'),
    reconcileExecuting: db.prepare(`UPDATE plans SET status = 'needs-review',
      note = 'interrupted while executing; nothing was resumed automatically' WHERE status = 'executing'`),
  }

  const brokenScans = transaction(db, () => Number(stmt.reconcile.run(Date.now()).changes ?? 0))
  if (brokenScans > 0) stmt.setMeta.run('last_reconcile_at', String(Date.now()))

  // A plan left in `executing` means the process died mid-flight. Never resume
  // it automatically: the per-op rows are the evidence a human needs.
  const interruptedPlans = transaction(db, () => Number(stmt.reconcileExecuting.run().changes ?? 0))
  if (interruptedPlans > 0) stmt.setMeta.run('last_plan_reconcile_at', String(Date.now()))

  function rowToFile(row) {
    return {
      id: Number(row.id),
      scanId: Number(row.scan_id),
      root: row.root,
      relPath: row.rel_path,
      name: row.name,
      ext: row.ext ?? '',
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      dev: String(row.dev ?? ''),
      ino: String(row.ino ?? ''),
      category: row.category,
      ruleId: row.rule_id ?? '',
      conflict: Number(row.conflict) === 1,
      conflictCategory: row.conflict_category ?? '',
      hash: row.hash ?? null,
      hashStatus: row.hash_status ?? 'none',
      number: row.number ?? null,
      numberForm: row.number_form ?? null,
      baseName: row.base_name ?? '',
      canonicalName: row.canonical_name ?? '',
      flags: row.flags ? safeJson(row.flags) : [],
      apkVerdict: row.apk_verdict ?? '',
      protection: row.protection ?? '',
      error: row.error ?? null,
    }
  }

  return {
    dbPath,
    sqliteVersion,
    journalMode,
    raw: db,

    startScan(rootsJson) {
      const info = stmt.insertScan.run(Date.now(), 'running', JSON.stringify(rootsJson))
      return Number(info.lastInsertRowid)
    },

    insertFiles(scanId, rows) {
      if (rows.length === 0) return
      transaction(db, () => {
        for (const row of rows) {
          stmt.insertFile.run(
            scanId,
            row.root,
            row.relPath,
            row.name,
            row.ext,
            row.size,
            row.mtimeMs,
            String(row.dev),
            String(row.ino),
            row.category,
            row.ruleId ?? '',
            row.conflict ? 1 : 0,
            row.conflictCategory ?? '',
            null,
            'none',
            row.number,
            row.numberForm,
            row.baseName,
            row.canonicalName,
            JSON.stringify(row.flags ?? []),
            row.apkVerdict ?? '',
            row.protection ?? '',
            row.error ?? null,
          )
        }
      })
    },

    updateScanCounts(scanId, counts) {
      stmt.updateCounts.run(counts.files, counts.dirs, counts.bytes, counts.skipped, counts.errors, scanId)
    },

    finishScan(scanId, summary) {
      stmt.finishScan.run(
        Date.now(),
        summary.status,
        summary.files,
        summary.dirs,
        summary.bytes,
        summary.hashed,
        summary.skipped,
        summary.errors,
        summary.truncated ? 1 : 0,
        summary.elapsedMs ?? null,
        summary.error ?? null,
        scanId,
      )
    },

    markScan(scanId, status, error) {
      stmt.markScan.run(status, Date.now(), error ?? null, scanId)
    },

    getScan(scanId) {
      const row = scanId === undefined || scanId === null ? stmt.latestScan.get() : stmt.getScan.get(scanId)
      return row ? scanRow(row) : null
    },

    sizeGroups(scanId) {
      return stmt.sizeGroups.all(scanId).map((row) => ({ size: Number(row.size), count: Number(row.c) }))
    },

    filesBySize(scanId, size) {
      return stmt.filesBySize.all(scanId, size).map(rowToFile)
    },

    hashCacheGet(dev, ino, size, mtimeMs) {
      const row = stmt.hashCacheGet.get(String(dev), String(ino), Number(size), Number(mtimeMs))
      return row ? String(row.hash) : null
    },

    hashCachePut(dev, ino, size, mtimeMs, hash) {
      stmt.hashCachePut.run(String(dev), String(ino), Number(size), Number(mtimeMs), hash, Date.now())
    },

    setFileHash(id, hash, status) {
      stmt.setFileHash.run(hash, status, id)
    },

    setApkVerdict(id, verdict) {
      stmt.setApkVerdict.run(verdict, id)
    },

    duplicateStats(scanId) {
      let groups = 0
      let files = 0
      let wasted = 0
      let protectedGroups = 0
      let protectedBytes = 0
      for (const row of stmt.duplicateSummary.all(scanId)) {
        const size = Number(row.size)
        const count = Number(row.c)
        const redundant = size * (count - 1)
        groups++
        files += count
        wasted += redundant
        if (Number(row.p ?? 0) > 0) {
          protectedGroups++
          protectedBytes += redundant
        }
      }
      return {
        groups,
        files,
        wasted,
        protectedGroups,
        protectedBytes,
        zeroByte: Number(stmt.zeroByte.get(scanId)?.c ?? 0),
      }
    },

    categoryCounts(scanId) {
      const out = {}
      for (const row of stmt.categoryCounts.all(scanId)) {
        out[String(row.category)] = { count: Number(row.c), bytes: Number(row.b ?? 0) }
      }
      return out
    },

    conflictCount(scanId) {
      return Number(stmt.conflictCount.get(scanId)?.c ?? 0)
    },

    protectedCount(scanId) {
      return Number(stmt.protectedCount.get(scanId)?.c ?? 0)
    },

    /** Files sitting directly in a scanned root, which archive mode operates on. */
    topLevelFiles(scanId) {
      return db
        .prepare("SELECT * FROM files WHERE scan_id = ? AND instr(rel_path, '/') = 0 AND protection = '' ORDER BY category ASC, rel_path ASC")
        .all(scanId)
        .map(rowToFile)
    },

    /** Files whose structural canonical name differs from their current name. */
    renameCandidates(scanId) {
      return db
        .prepare("SELECT * FROM files WHERE scan_id = ? AND protection = '' AND canonical_name <> '' AND canonical_name <> name ORDER BY rel_path ASC")
        .all(scanId)
        .map(rowToFile)
    },
    /** Every duplicate group with full member rows, ordered deterministically. */
    duplicateMemberGroups(scanId) {
      const rows = db
        .prepare(`SELECT * FROM files WHERE scan_id = ? AND hash IS NOT NULL AND size > 0
          ORDER BY size DESC, hash ASC, rel_path ASC`)
        .all(scanId)
      const groups = new Map()
      for (const row of rows) {
        const key = `${row.size}:${row.hash}`
        const bucket = groups.get(key)
        if (bucket) bucket.members.push(rowToFile(row))
        else groups.set(key, { size: Number(row.size), hash: String(row.hash), members: [rowToFile(row)] })
      }
      return [...groups.values()].filter((group) => group.members.length > 1)
    },

    createPlan(scanId, mode, policy, sourcePlanId) {
      const info = stmt.insertPlan.run(scanId, mode, 'proposed', Date.now(), JSON.stringify(policy), sourcePlanId ?? null)
      return Number(info.lastInsertRowid)
    },

    finalizePlan(planId, summary) {
      const info = stmt.finalizePlan.run(
        summary.digest,
        JSON.stringify(summary.ops),
        summary.keepCount,
        summary.skippedGroups,
        summary.skippedBytes,
        summary.plannedBytes,
        planId,
      )
      if (Number(info.changes ?? 0) !== 1) {
        throw new AfError(CODE.DB, 'plan finalization refused: plan is no longer proposed', { planId })
      }
    },

    /**
     * Record that a plan's files were put back by a restore plan.
     *
     * Only a plan that actually moved files forward can be restored, and the
     * transition is one-shot so a replayed restore cannot mark it twice.
     */
    markRestored(planId, note) {
      const info = stmt.markRestored.run(note ?? null, planId)
      return Number(info.changes ?? 0) === 1
    },

    listPlans(limit = 20) {
      const rows = stmt.listPlans.all(limit)
      const restoredBy = new Map()
      for (const row of rows) {
        if (row.source_plan_id === null || row.source_plan_id === undefined) continue
        if (String(row.status) !== 'committed') continue
        restoredBy.set(Number(row.source_plan_id), Number(row.id))
      }
      return rows.map((row) => ({
        id: Number(row.id),
        mode: String(row.mode),
        status: String(row.status),
        createdAt: Number(row.created_at),
        digest: String(row.digest ?? ''),
        scanId: Number(row.scan_id),
        sourcePlanId: row.source_plan_id === null || row.source_plan_id === undefined ? null : Number(row.source_plan_id),
        restoredBy: restoredBy.get(Number(row.id)) ?? null,
        opsCount: safeJson(row.ops_json, []).length,
        keepCount: Number(row.keep_count),
        plannedBytes: Number(row.planned_bytes),
        skippedGroups: Number(row.skipped_groups),
        skippedBytes: Number(row.skipped_bytes),
        note: row.note ?? null,
      }))
    },

    getPlan(planId) {
      const row = planId === undefined || planId === null ? stmt.latestPlan.get() : stmt.getPlan.get(planId)
      return row ? planRow(row) : null
    },

    /** Single-use, digest-bound transition from proposed to approved. */
    approvePlan(planId, digest, callId) {
      const info = stmt.approvePlan.run(Date.now(), callId, planId, digest)
      return Number(info.changes ?? 0) === 1
    },

    rejectPlan(planId, note) {
      stmt.rejectPlan.run(note ?? null, planId)
    },

    /** Single-use transition approved -> executing. */
    beginExecution(planId) {
      const info = stmt.beginExecution.run(Date.now(), planId)
      return Number(info.changes ?? 0) === 1
    },

    seedPlanOps(planId, ops) {
      transaction(db, () => {
        for (const op of ops) {
          stmt.insertPlanOp.run(
            planId,
            op.opId,
            Number(op.fileId),
            op.srcPath,
            op.dstPath,
            Number(op.size),
            'pending',
            null,
            Date.now(),
          )
        }
      })
    },

    setOpState(planId, opId, state, error) {
      stmt.setPlanOpState.run(state, error ?? null, Date.now(), planId, opId)
    },

    listPlanOps(planId) {
      return stmt.listPlanOps.all(planId).map((row) => ({
        planId: Number(row.plan_id),
        opId: String(row.op_id),
        fileId: Number(row.file_id),
        srcPath: String(row.src_path),
        dstPath: String(row.dst_path),
        size: Number(row.size),
        state: String(row.state),
        error: row.error ?? null,
        updatedAt: Number(row.updated_at),
      }))
    },

    logExec(planId, opId, event, detail) {
      stmt.insertLog.run(planId, opId, Date.now(), event, detail ?? null)
    },

    listExecLog(planId, limit = 50) {
      return stmt.listLog.all(planId, limit).map((row) => ({
        at: Number(row.at),
        opId: String(row.op_id),
        event: String(row.event),
        detail: row.detail ?? null,
      }))
    },

    finishExecution(planId, status, note) {
      stmt.finishExecution.run(status, Date.now(), note ?? null, planId)
    },

    countFiles(scanId) {
      return Number(stmt.countFiles.get(scanId)?.c ?? 0)
    },

    sumBytes(scanId) {
      return Number(stmt.sumBytes.get(scanId)?.b ?? 0)
    },

    listFiles(scanId, { category, limit, offset }) {
      const where = ['scan_id = ?']
      const params = [scanId]
      if (category) {
        where.push('category = ?')
        params.push(category)
      }
      const total = Number(
        db.prepare(`SELECT COUNT(*) AS c FROM files WHERE ${where.join(' AND ')}`).get(...params)?.c ?? 0,
      )
      const rows = db
        .prepare(`SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY size DESC, id ASC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset)
      return { total, items: rows.map(rowToFile) }
    },

    duplicateGroups(scanId, { limit, offset }) {
      const rows = db
        .prepare(`SELECT size, hash, COUNT(*) AS c,
            SUM(CASE WHEN protection <> '' THEN 1 ELSE 0 END) AS p
          FROM files
          WHERE scan_id = ? AND hash IS NOT NULL AND size > 0
          GROUP BY size, hash HAVING c > 1
          ORDER BY (size * (c - 1)) DESC, size DESC LIMIT ? OFFSET ?`)
        .all(scanId, limit, offset)
      const items = []
      let wasted = 0
      const totalRow = db
        .prepare(`SELECT COUNT(*) AS c FROM (
          SELECT size, hash FROM files WHERE scan_id = ? AND hash IS NOT NULL AND size > 0
          GROUP BY size, hash HAVING COUNT(*) > 1)`)
        .get(scanId)
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]
        const size = Number(row.size)
        const count = Number(row.c)
        wasted += size * (count - 1)
        const members = db
          .prepare(`SELECT id, name, rel_path, protection FROM files
            WHERE scan_id = ? AND size = ? AND hash = ? ORDER BY rel_path ASC`)
          .all(scanId, size, row.hash)
          .map((m) => ({
            id: Number(m.id),
            name: String(m.name),
            relPath: String(m.rel_path),
            protection: String(m.protection ?? ''),
          }))
        items.push({
          groupId: offset + index + 1,
          size,
          count,
          protected: Number(row.p ?? 0) > 0,
          members,
        })
      }
      return { total: Number(totalRow?.c ?? 0), wasted, items }
    },

    numberedFiles(scanId, { kind, limit, offset }) {
      const filters = {
        numbered: 'number IS NOT NULL',
        suspicious: "(conflict = 1 OR flags LIKE '%needs_confirmation%' OR (apk_verdict <> '' AND apk_verdict <> 'apk-structure-ok'))",
        all: '1 = 1',
      }
      const filter = filters[kind] ?? filters.all
      const total = Number(
        db.prepare(`SELECT COUNT(*) AS c FROM files WHERE scan_id = ? AND ${filter}`).get(scanId)?.c ?? 0,
      )
      const rows = db
        .prepare(`SELECT * FROM files WHERE scan_id = ? AND ${filter} ORDER BY rel_path ASC LIMIT ? OFFSET ?`)
        .all(scanId, limit, offset)
      return { total, items: rows.map(rowToFile) }
    },
  }
}

function scanRow(row) {
  return {
    id: Number(row.id),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    status: String(row.status),
    roots: safeJson(row.roots_json, []),
    files: Number(row.files),
    dirs: Number(row.dirs),
    bytes: Number(row.bytes),
    hashed: Number(row.hashed),
    skipped: Number(row.skipped),
    errors: Number(row.errors),
    truncated: Number(row.truncated) === 1,
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    error: row.error ?? null,
  }
}

function planRow(row) {
  return {
    id: Number(row.id),
    scanId: Number(row.scan_id),
    mode: String(row.mode),
    status: String(row.status),
    createdAt: Number(row.created_at),
    digest: String(row.digest ?? ''),
    policy: safeJson(row.policy_json, {}),
    ops: safeJson(row.ops_json, []),
    keepCount: Number(row.keep_count),
    skippedGroups: Number(row.skipped_groups),
    skippedBytes: Number(row.skipped_bytes),
    plannedBytes: Number(row.planned_bytes),
    approvedAt: row.approved_at === null ? null : Number(row.approved_at),
    approveCallId: row.approve_call_id ?? null,
    sourcePlanId: row.source_plan_id === null || row.source_plan_id === undefined
      ? null
      : Number(row.source_plan_id),
    note: row.note ?? null,
  }
}

function safeJson(text, fallback = []) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}
