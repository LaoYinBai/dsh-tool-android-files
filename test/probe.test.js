import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { runProbe } from '../lib/probe.js'

async function withBase(fn) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-probe-'))
  try {
    await fn(base)
  } finally {
    await fsp.rm(base, { recursive: true, force: true })
  }
}

test('probe reports every check and cleans up after itself', async () => {
  await withBase(async (base) => {
    const report = await runProbe(base)
    const ids = report.checks.map((check) => check.id)
    for (const expected of [
      'mkdir_recursive',
      'write_read',
      'exclusive_create',
      'exclusive_copy',
      'hardlink',
      'rename_overwrite',
      'rename_cross_dir',
      'fsync_file',
      'fsync_dir',
      'mtime_resolution',
      'statfs',
      'unlink',
    ]) {
      assert.ok(ids.includes(expected), `missing check ${expected}`)
    }
    assert.equal(report.cleanupOk, true, `leftovers: ${report.leftovers.join(', ')}`)
    const remaining = await fsp.readdir(base)
    assert.deepEqual(remaining, [], 'probe directory must be empty afterwards')
  })
})

test('exclusive create is detected on this backend', async () => {
  await withBase(async (base) => {
    const report = await runProbe(base)
    const check = report.checks.find((entry) => entry.id === 'exclusive_create')
    assert.ok(check, 'exclusive_create must be recorded')
    // Node honours O_EXCL on every supported platform; if this ever fails the
    // M2 write path must not use open('wx') as its no-clobber primitive.
    assert.equal(report.exclusiveCreate, true, check.detail)
  })
})

test('rename overwrite semantics are measured, not assumed', async () => {
  await withBase(async (base) => {
    const report = await runProbe(base)
    assert.equal(typeof report.renameOverwrites, 'boolean', 'renameOverwrites must be a boolean')
    const check = report.checks.find((entry) => entry.id === 'rename_overwrite')
    assert.ok(check.detail.length > 0)
  })
})

test('the probe never leaves files behind when it has to create a nested tree', async () => {
  await withBase(async (base) => {
    const first = await runProbe(base)
    const second = await runProbe(base)
    assert.equal(first.cleanupOk, true)
    assert.equal(second.cleanupOk, true)
    assert.deepEqual(await fsp.readdir(base), [])
  })
})
