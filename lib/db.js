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

export const SCHEMA_VERSION = 2

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
]

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get()
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
    duplicatesBySize: db.prepare(`SELECT COUNT(*) AS c FROM (
      SELECT size FROM files WHERE scan_id = ? AND hash IS NOT NULL AND size > 0
      GROUP BY size, hash HAVING COUNT(*) > 1)`),
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
  }

  const brokenScans = transaction(db, () => Number(stmt.reconcile.run(Date.now()).changes ?? 0))
  if (brokenScans > 0) stmt.setMeta.run('last_reconcile_at', String(Date.now()))

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
      return {
        groups: Number(stmt.duplicateGroupCount.get(scanId)?.c ?? 0),
        files: Number(stmt.duplicateFileCount.get(scanId)?.c ?? 0),
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
        .prepare(`SELECT size, hash, COUNT(*) AS c FROM files
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
          .prepare('SELECT id, name, rel_path FROM files WHERE scan_id = ? AND size = ? AND hash = ? ORDER BY rel_path ASC')
          .all(scanId, size, row.hash)
          .map((m) => ({ id: Number(m.id), name: String(m.name), relPath: String(m.rel_path) }))
        items.push({ groupId: offset + index + 1, size, count, members })
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

function safeJson(text, fallback = []) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}
