import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyProtection, encodeProtection, isProtected } from '../lib/protect.js'

test('in-progress downloads are protected', () => {
  for (const name of ['movie.mp4.part', 'iso.downloading', 'x.crdownload', 'a.tmp', 'b.aria2']) {
    const info = classifyProtection(name)
    assert.ok(info.tags.includes('partial'), `${name} should be partial`)
    assert.equal(isProtected(name), true)
  }
})

test('SQLite side files are protected', () => {
  for (const name of ['notes.db-journal', 'notes.db-wal', 'notes.db-shm', 'app.lock']) {
    assert.ok(classifyProtection(name).tags.includes('transient'), name)
  }
})

test('multi-part volume suffixes are recognised as a family', () => {
  for (const name of ['archive.1', 'archive.001', 'archive.002', 'pack.z01', 'pack.r00', 'video.5']) {
    const info = classifyProtection(name)
    assert.ok(info.tags.includes('split'), `${name} should be a split member`)
    assert.ok(info.family, `${name} should report a family`)
    assert.ok(info.member, `${name} should report a member index`)
  }
  assert.equal(classifyProtection('archive.001').family, 'archive')
  assert.equal(classifyProtection('archive.001').member, '001')
})

test('ordinary files are not protected', () => {
  for (const name of ['工具.apk', 'photo (1).jpg', 'app-debug (2).apk', '报告.pdf', 'no-extension']) {
    assert.equal(isProtected(name), false, `${name} must stay actionable`)
    assert.deepEqual(classifyProtection(name).tags, [])
  }
})

test('a four-digit year is not mistaken for a volume index', () => {
  // `movie.2024` is a naming choice, not part 2024 of a split set.
  const info = classifyProtection('movie.2024')
  assert.equal(info.tags.includes('split'), false)
  assert.equal(info.family, null)
})

test('encodeProtection round-trips the family for storage', () => {
  const info = classifyProtection('archive.001')
  const encoded = encodeProtection(info)
  assert.ok(encoded.includes('split'))
  assert.ok(encoded.includes('family=archive'))
  assert.equal(encodeProtection(classifyProtection('a.txt')), '')
})
