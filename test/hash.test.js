import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { sha256File } from '../lib/hash.js'
import { AfError, CODE } from '../lib/errors.js'

async function withTempFile(buffer, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-hash-'))
  const file = path.join(dir, 'sample.bin')
  await fsp.writeFile(file, buffer)
  try {
    await fn(file)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('hashes match the crypto digest', async () => {
  const buffer = Buffer.from('abc')
  await withTempFile(buffer, async (file) => {
    const result = await sha256File(file)
    assert.equal(result.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(result.bytes, 3)
  })
})

test('large input is hashed in chunks without changing the digest', async () => {
  const buffer = randomBytes(1024 * 1024)
  const expected = createHash('sha256').update(buffer).digest('hex')
  await withTempFile(buffer, async (file) => {
    const result = await sha256File(file, { highWaterMark: 64 * 1024 })
    assert.equal(result.sha256, expected)
    assert.equal(result.bytes, buffer.length)
  })
})

test('an aborted hash rejects with AF_ABORTED', async () => {
  const buffer = randomBytes(4 * 1024 * 1024)
  await withTempFile(buffer, async (file) => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => sha256File(file, { signal: controller.signal }),
      (err) => err instanceof AfError && err.code === CODE.ABORTED,
    )
  })
})
