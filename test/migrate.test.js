import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { openStore } from '../lib/db.js'

/**
 * A phone upgrading from 0.1.2 holds a v1 index. Rebuilding it would lose scan
 * history, so the migration must add the new column in place.
 */
test('a v1 index upgrades to the current schema without losing rows', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-migrate-'))
  const dbPath = path.join(dir, 'index.sqlite')
  try {
    const fresh = await openStore(dbPath)
    const scanId = fresh.startScan(['/x'])
    fresh.insertFiles(scanId, [{
      root: '/x',
      relPath: 'a.txt',
      name: 'a.txt',
      ext: 'txt',
      size: 3,
      mtimeMs: 1,
      dev: '1',
      ino: '2',
      category: 'document',
      ruleId: 'document-ext',
      conflict: false,
      conflictCategory: '',
      number: null,
      numberForm: null,
      baseName: 'a.txt',
      canonicalName: 'a.txt',
      flags: [],
      apkVerdict: '',
      protection: '',
      error: null,
    }])
    // Rewind the file to look like the previous released schema.
    fresh.raw.exec('ALTER TABLE files DROP COLUMN protection')
    fresh.raw.exec('PRAGMA user_version = 1')
    fresh.raw.close()

    const upgraded = await openStore(dbPath)
    try {
      const version = Number(upgraded.raw.prepare('PRAGMA user_version').get().user_version)
      assert.equal(version, 3)
      const columns = upgraded.raw.prepare('PRAGMA table_info(files)').all().map((row) => row.name)
      assert.ok(columns.includes('protection'))
      assert.ok(
        upgraded.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plans'").get(),
        'plans table must exist after migration',
      )
      assert.equal(upgraded.countFiles(scanId), 1, 'existing rows must survive')
      // The scan never finished, so opening the index must reconcile it.
      assert.equal(upgraded.getScan(scanId).status, 'interrupted')
    } finally {
      upgraded.raw.close()
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('protection values are stored and countable', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-protect-'))
  const dbPath = path.join(dir, 'index.sqlite')
  try {
    const store = await openStore(dbPath)
    const scanId = store.startScan(['/x'])
    const base = {
      root: '/x',
      ext: 'bin',
      size: 10,
      mtimeMs: 1,
      dev: '1',
      ino: '2',
      category: 'other',
      ruleId: 'fallback-none',
      conflict: false,
      conflictCategory: '',
      number: null,
      numberForm: null,
      baseName: 'x',
      canonicalName: 'x',
      flags: [],
      apkVerdict: '',
      error: null,
    }
    store.insertFiles(scanId, [
      { ...base, relPath: 'archive.001', name: 'archive.001', protection: 'split;family=archive' },
      { ...base, relPath: 'video.mp4.part', name: 'video.mp4.part', protection: 'partial' },
      { ...base, relPath: 'normal.txt', name: 'normal.txt', protection: '' },
    ])
    assert.equal(store.protectedCount(scanId), 2)
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
