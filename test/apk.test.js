import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { inspectZipStructure } from '../lib/apk.js'

/** Build a stored (uncompressed) ZIP. CRCs are left zero: the parser never reads them. */
function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const dataBuf = Buffer.from(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, dataBuf)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(dataBuf.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)

    offset += 30 + nameBuf.length + dataBuf.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

async function withFile(buffer, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-apk-'))
  const file = path.join(dir, 'sample.apk')
  await fsp.writeFile(file, buffer)
  try {
    await fn(file, buffer.length)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

test('a zip that lists AndroidManifest.xml passes the structure check', async () => {
  const zip = buildZip([
    ['AndroidManifest.xml', 'binary'],
    ['classes.dex', 'dex'],
  ])
  await withFile(zip, async (file, size) => {
    const result = await inspectZipStructure(file, size)
    assert.equal(result.isZip, true)
    assert.equal(result.hasManifest, true)
    assert.equal(result.hasDex, true)
    assert.equal(result.verdict, 'apk-structure-ok')
    assert.equal(result.entries, 2)
  })
})

test('a zip without a manifest is not reported as an apk', async () => {
  const zip = buildZip([['readme.txt', 'hello']])
  await withFile(zip, async (file, size) => {
    const result = await inspectZipStructure(file, size)
    assert.equal(result.isZip, true)
    assert.equal(result.hasManifest, false)
    assert.equal(result.verdict, 'zip-without-manifest')
  })
})

test('a renamed text file is not a zip', async () => {
  await withFile(Buffer.from('not a zip at all, just text'), async (file, size) => {
    const result = await inspectZipStructure(file, size)
    assert.equal(result.isZip, false)
    assert.equal(result.verdict, 'not-zip')
  })
})

test('tiny files are rejected without reading', async () => {
  await withFile(Buffer.from('abc'), async (file, size) => {
    const result = await inspectZipStructure(file, size)
    assert.equal(result.verdict, 'too-small')
  })
})
