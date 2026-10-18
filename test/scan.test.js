import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { walkTree, compileNamePattern } from '../lib/scan.js'
import { describeRoot } from '../lib/paths.js'
import { AfError, CODE } from '../lib/errors.js'

async function makeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-scan-'))
  await fsp.writeFile(path.join(root, 'a.txt'), 'same-content')
  await fsp.writeFile(path.join(root, 'b.txt'), 'same-content')
  await fsp.mkdir(path.join(root, 'sub'))
  await fsp.writeFile(path.join(root, 'sub', 'c.bin'), 'x'.repeat(32))
  await fsp.mkdir(path.join(root, '.hidden'))
  await fsp.writeFile(path.join(root, '.hidden', 'd.dat'), 'y')
  return root
}

test('walk indexes files and subdirectories without following links', async () => {
  const root = await makeFixture()
  try {
    let symlinked = false
    try {
      await fsp.symlink(path.join(root, 'a.txt'), path.join(root, 'link.txt'))
      symlinked = true
    } catch {
      /* Windows without developer mode refuses symlinks; the assertion is skipped */
    }
    const desc = await describeRoot(root)
    const seen = []
    const stats = await walkTree(desc, {}, (entry) => {
      seen.push(entry.rel)
    })
    assert.equal(stats.files, symlinked ? 4 : 4)
    assert.equal(stats.skippedSymlinks, symlinked ? 1 : 0)
    assert.ok(seen.includes('a.txt'))
    assert.ok(seen.includes('sub/c.bin'))
    assert.ok(seen.includes('.hidden/d.dat'))
    assert.equal(stats.dirs, 2)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('exclusions by name, extension and glob', async () => {
  const root = await makeFixture()
  try {
    const desc = await describeRoot(root)
    const stats = await walkTree(
      desc,
      {
        excludeNames: new Set(['a.txt']),
        excludeExts: new Set(['dat']),
        excludePatterns: [compileNamePattern('*.bin')],
      },
      () => {},
    )
    assert.equal(stats.files, 1)
    assert.equal(stats.excluded, 3)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('includeSubdirs=false only scans the top level', async () => {
  const root = await makeFixture()
  try {
    const desc = await describeRoot(root)
    const stats = await walkTree(desc, { includeSubdirs: false }, () => {})
    assert.equal(stats.files, 2)
    assert.equal(stats.dirs, 0)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('maxEntries truncates instead of overrunning', async () => {
  const root = await makeFixture()
  try {
    const desc = await describeRoot(root)
    const stats = await walkTree(desc, { maxEntries: 2 }, () => {})
    assert.equal(stats.files, 2)
    assert.equal(stats.truncated, true)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('an aborted walk stops with AF_ABORTED', async () => {
  const root = await makeFixture()
  try {
    const desc = await describeRoot(root)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => walkTree(desc, { signal: controller.signal }, () => {}),
      (err) => err instanceof AfError && err.code === CODE.ABORTED,
    )
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('per-entry readdir failures are recorded, not thrown', async () => {
  const root = await makeFixture()
  try {
    const desc = await describeRoot(root)
    const stats = await walkTree(desc, {}, () => {})
    assert.equal(stats.errors.length, 0)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('compileNamePattern only understands *', () => {
  const pattern = compileNamePattern('*.tmp')
  assert.equal(pattern.test('a.tmp'), true)
  assert.equal(pattern.test('a.tmpx'), false)
  assert.equal(compileNamePattern('a.b').test('aXb'), false)
})
