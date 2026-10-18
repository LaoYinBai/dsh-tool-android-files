import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  assertNotDenied,
  assertRootIdentity,
  describeRoot,
  isSameOrInside,
  matchedDenyEntry,
  relativeInside,
} from '../lib/paths.js'
import { AfError, CODE } from '../lib/errors.js'

test('containment never uses string prefixes', () => {
  assert.equal(isSameOrInside('/a/b', '/a/b'), true)
  assert.equal(isSameOrInside('/a/b', '/a/b/c'), true)
  assert.equal(isSameOrInside('/a/b', '/a/bc'), false)
  assert.equal(isSameOrInside('/a/b', '/a'), false)
})

test('relativeInside returns null outside the root', () => {
  assert.equal(relativeInside('/a/b', '/a/b/c'), 'c')
  assert.equal(relativeInside('/a/b', '/a/b'), '.')
  assert.equal(relativeInside('/a/b', '/a/bc'), null)
})

test('Android hard boundaries are refused', () => {
  assert.ok(matchedDenyEntry('/storage/emulated/0/Android/data/com.example'))
  assert.ok(matchedDenyEntry('/storage/emulated/0/Android/obb'))
  assert.equal(matchedDenyEntry('/storage/emulated/0/Android/media'), null)
  assert.equal(matchedDenyEntry('/storage/emulated/0/Download'), null)
  assert.throws(
    () => assertNotDenied('/storage/emulated/0/Android/data/x', 'test'),
    (err) => err instanceof AfError && err.code === CODE.PATH_DENIED,
  )
})

test('describeRoot captures a stable identity and resolves links', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-root-'))
  try {
    const desc = await describeRoot(dir)
    assert.equal(desc.isLink, false)
    assert.ok(desc.real.length > 0)
    assert.equal(await assertRootIdentity(desc), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('describeRoot rejects missing paths and files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-root-'))
  const file = path.join(dir, 'a.txt')
  await fsp.writeFile(file, 'x')
  try {
    await assert.rejects(
      () => describeRoot(path.join(dir, 'missing')),
      (err) => err instanceof AfError && err.code === CODE.ROOT_MISSING,
    )
    await assert.rejects(
      () => describeRoot(file),
      (err) => err instanceof AfError && err.code === CODE.ROOT_NOT_DIR,
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('assertRootIdentity detects a replaced directory', async () => {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-swap-'))
  const target = path.join(parent, 'root')
  await fsp.mkdir(target)
  try {
    const desc = await describeRoot(target)
    await fsp.rm(target, { recursive: true })
    await fsp.mkdir(target)
    if (!desc.identityKnown) return
    await assert.rejects(
      () => assertRootIdentity(desc),
      (err) => err instanceof AfError && err.code === CODE.ROOT_CHANGED,
    )
  } finally {
    await fsp.rm(parent, { recursive: true, force: true })
  }
})
