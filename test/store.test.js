import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { openStore } from '../lib/db.js'

function row(name, size, extra = {}) {
  return {
    root: '/storage/emulated/0/Download',
    relPath: name,
    name,
    ext: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '',
    size,
    mtimeMs: 1_700_000_000_000,
    dev: 1,
    ino: size + 1,
    category: extra.category ?? 'document',
    ruleId: 'document-ext',
    conflict: false,
    conflictCategory: '',
    number: extra.number ?? null,
    numberForm: extra.numberForm ?? null,
    baseName: name,
    canonicalName: name,
    flags: extra.flags ?? [],
    apkVerdict: extra.apkVerdict ?? '',
    error: null,
  }
}

async function withStore(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-db-'))
  const dbPath = path.join(dir, 'index.sqlite')
  try {
    await fn(dbPath, dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('index persists scans, hashes and duplicate groups', async () => {
  await withStore(async (dbPath) => {
    const store = await openStore(dbPath)
    const scanId = store.startScan(['/storage/emulated/0/Download'])
    store.insertFiles(scanId, [
      row('a.txt', 12),
      row('b.txt', 12),
      row('c.bin', 12, { category: 'other' }),
      row('zero.txt', 0),
    ])
    store.updateScanCounts(scanId, { files: 4, dirs: 1, bytes: 36, skipped: 0, errors: 0 })
    store.setFileHash(1, 'a'.repeat(64), 'hashed')
    store.setFileHash(2, 'a'.repeat(64), 'hashed')
    store.setFileHash(3, 'b'.repeat(64), 'hashed')
    store.finishScan(scanId, {
      status: 'completed',
      files: 4,
      dirs: 1,
      bytes: 36,
      hashed: 3,
      skipped: 0,
      errors: 0,
      truncated: false,
      elapsedMs: 5,
    })

    const scan = store.getScan()
    assert.equal(scan.status, 'completed')
    assert.equal(scan.files, 4)

    const dup = store.duplicateStats(scanId)
    assert.equal(dup.groups, 1)
    assert.equal(dup.files, 2)
    assert.equal(dup.zeroByte, 1)

    const page = store.duplicateGroups(scanId, { limit: 10, offset: 0 })
    assert.equal(page.total, 1)
    assert.equal(page.items[0].members.length, 2)
    assert.equal(page.wasted, 12)

    const listed = store.listFiles(scanId, { limit: 2, offset: 0 })
    assert.equal(listed.total, 4)
    assert.equal(listed.items.length, 2)
    const filtered = store.listFiles(scanId, { category: 'other', limit: 10, offset: 0 })
    assert.equal(filtered.total, 1)

    store.raw.close()

    const reopened = await openStore(dbPath)
    const again = reopened.getScan(scanId)
    assert.equal(again.status, 'completed')
    assert.equal(reopened.countFiles(scanId), 4)
    reopened.raw.close()
  })
})

test('an unfinished scan is reconciled to interrupted on reopen', async () => {
  await withStore(async (dbPath) => {
    const first = await openStore(dbPath)
    const scanId = first.startScan(['/storage/emulated/0/Download'])
    first.insertFiles(scanId, [row('a.txt', 1)])
    first.raw.close()

    const second = await openStore(dbPath)
    const scan = second.getScan(scanId)
    assert.equal(scan.status, 'interrupted')
    assert.ok(String(scan.error).includes('engine restarted'))
    second.raw.close()
  })
})

test('numbered and suspicious filters work', async () => {
  await withStore(async (dbPath) => {
    const store = await openStore(dbPath)
    const scanId = store.startScan(['/x'])
    store.insertFiles(scanId, [
      row('工具.apk（1）', 100, { number: '1', numberForm: 'after-ext', apkVerdict: 'apk-structure-ok' }),
      row('工具（2）.apk', 100, { number: '2', numberForm: 'before-ext', apkVerdict: 'zip-without-manifest' }),
      row('plain.txt', 10),
    ])
    const numbered = store.numberedFiles(scanId, { kind: 'numbered', limit: 10, offset: 0 })
    assert.equal(numbered.total, 2)
    const suspicious = store.numberedFiles(scanId, { kind: 'suspicious', limit: 10, offset: 0 })
    assert.equal(suspicious.total, 1)
    assert.equal(suspicious.items[0].name, '工具（2）.apk')
    store.raw.close()
  })
})

test('hash cache round-trips', async () => {
  await withStore(async (dbPath) => {
    const store = await openStore(dbPath)
    store.hashCachePut(1, 42, 100, 1_700_000_000_000, 'c'.repeat(64))
    assert.equal(store.hashCacheGet(1, 42, 100, 1_700_000_000_000), 'c'.repeat(64))
    assert.equal(store.hashCacheGet(1, 42, 100, 1), null)
    store.raw.close()
  })
})
