import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeName } from '../lib/naming.js'
import { buildRules, classify } from '../lib/classify.js'

const { rules } = buildRules()

function categoryOf(name, size = 10, relDir = '.') {
  const naming = analyzeName(name)
  return classify(
    { name, size, relDir, ext: naming.ext, compound: naming.compound, extKnown: naming.extKnown },
    rules,
  )
}

test('case-insensitive extension match', () => {
  assert.equal(categoryOf('photo.JPG').category, 'image')
  assert.equal(categoryOf('PHOTO.JpEg').category, 'image')
})

test('counter after the extension does not break typing', () => {
  assert.equal(categoryOf('工具.apk（1）').category, 'installer')
  assert.equal(categoryOf('工具.apk(1)').category, 'installer')
  assert.equal(categoryOf('工具（2）.apk').category, 'installer')
})

test('compound archive extension wins', () => {
  assert.equal(categoryOf('backup.tar.gz').category, 'archive')
})

test('unknown and missing extensions fall to other', () => {
  assert.equal(categoryOf('notes.qqq').category, 'other')
  assert.equal(categoryOf('README').category, 'other')
})

test('apk is an installer, not an archive', () => {
  assert.equal(categoryOf('app.apk').category, 'installer')
  assert.equal(categoryOf('app.zip').category, 'archive')
})

test('user rules are appended and can override by earlier position', () => {
  const built = buildRules([
    { id: 'big-video', category: 'video', exts: ['mp4'], minSize: 10_000 },
  ])
  const naming = analyzeName('movie.MP4')
  const small = classify({ name: 'movie.MP4', size: 10, ext: naming.ext, extKnown: true }, built.rules)
  assert.equal(small.category, 'video')
})

test('conflicting evidence is recorded instead of auto-resolved', () => {
  const built = buildRules([
    { id: 'screenshot-rule', category: 'image', keywords: ['photo'] },
  ])
  // `.pdf` says document, keyword rule says image: first match wins, conflict flagged.
  const result = classify({ name: 'photo.pdf', size: 10, ext: 'pdf', extKnown: true }, built.rules)
  assert.equal(result.category, 'document')
  assert.equal(result.conflict, true)
  assert.equal(result.conflictCategory, 'image')
})

test('invalid user rules are dropped with a problem entry', () => {
  const built = buildRules([{ category: 'nope' }, 'not-an-object', { category: 'image', exts: 'png' }])
  assert.equal(built.rules.filter((rule) => rule.id.startsWith('user-')).length, 0)
  assert.equal(built.problems.length, 3)
})
