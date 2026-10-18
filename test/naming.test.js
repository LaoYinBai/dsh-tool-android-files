import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeName, suggestNormalizedName } from '../lib/naming.js'

test('plain name has no numbering', () => {
  const info = analyzeName('应用.apk')
  assert.equal(info.number, null)
  assert.equal(info.ext, 'apk')
  assert.equal(info.extKnown, true)
  assert.equal(info.canonicalName, '应用.apk')
})

test('ascii counter before extension', () => {
  const info = analyzeName('应用(1).apk')
  assert.equal(info.number, '1')
  assert.equal(info.numberForm, 'before-ext')
  assert.equal(info.parenStyle, 'ascii')
  assert.equal(info.baseName, '应用.apk')
  // The counter already sits on the correct side of the extension, so no
  // rename is proposed: respacing the user's own filename is not a fix.
  assert.equal(info.canonicalName, '应用(1).apk')
  assert.ok(!info.flags.includes('needs_confirmation'))
})

test('a real numbered download is not flagged for confirmation', () => {
  // Observed on device: `cnmd(1).mp3`, `oop练习题(1).pdf`. These are ordinary
  // names; only ambiguity about what the number means deserves a flag.
  const plain = analyzeName('cnmd(1).mp3')
  assert.equal(plain.number, '1')
  assert.equal(plain.canonicalName, 'cnmd(1).mp3')
  assert.deepEqual(plain.flags, [])

  const spaced = analyzeName('app-debug (1).apk')
  assert.equal(spaced.number, '1')
  assert.equal(spaced.canonicalName, 'app-debug (1).apk')
  assert.ok(!spaced.flags.includes('needs_confirmation'))
  assert.ok(spaced.flags.includes('space_before_paren'))
})

test('fullwidth counter before extension', () => {
  const info = analyzeName('应用（1）.apk')
  assert.equal(info.number, '1')
  assert.equal(info.numberForm, 'before-ext')
  assert.equal(info.parenStyle, 'full')
  assert.equal(info.baseName, '应用.apk')
  assert.ok(info.flags.includes('fullwidth_parens'))
})

test('counter after the extension is detected', () => {
  const ascii = analyzeName('应用.apk(1)')
  assert.equal(ascii.number, '1')
  assert.equal(ascii.numberForm, 'after-ext')
  assert.equal(ascii.ext, 'apk')
  assert.equal(ascii.baseName, '应用.apk')
  assert.equal(ascii.canonicalName, '应用 (1).apk')

  const full = analyzeName('应用.apk（1）')
  assert.equal(full.number, '1')
  assert.equal(full.numberForm, 'after-ext')
  assert.equal(full.canonicalName, '应用 (1).apk')
})

test('space between name and counter is accepted', () => {
  const info = analyzeName('应用.apk (2)')
  assert.equal(info.number, '2')
  assert.equal(info.numberForm, 'after-ext')
  assert.equal(info.spaceBeforeParen, true)
  assert.ok(info.flags.includes('space_before_paren'))
  assert.equal(info.canonicalName, '应用 (2).apk')
})

test('numbers in the middle of a name are untouched', () => {
  const info = analyzeName('2024.05.06 会议 记录 v2.pdf')
  assert.equal(info.number, null)
  assert.equal(info.canonicalName, info.name)
  assert.equal(info.ext, 'pdf')
})

test('year-like counters are flagged, not assumed to be copies', () => {
  const info = analyzeName('报告(2024).pdf')
  assert.equal(info.number, '2024')
  assert.ok(info.flags.includes('number_looks_like_year'))
  assert.ok(info.flags.includes('needs_confirmation'))
})

test('counter on an untyped name stays a tail counter', () => {
  const info = analyzeName('备份 (3)')
  assert.equal(info.number, '3')
  assert.equal(info.numberForm, 'tail')
  assert.equal(info.baseName, '备份')
  assert.equal(info.canonicalName, '备份 (3)')
})

test('compound extensions survive numbering', () => {
  const info = analyzeName('存档.tar.gz（4）')
  assert.equal(info.number, '4')
  assert.equal(info.compound, 'tar.gz')
  assert.equal(info.ext, 'gz')
  assert.equal(info.baseName, '存档.tar.gz')
  assert.equal(info.canonicalName, '存档 (4).tar.gz')
})

test('multi-dot stem keeps its dots', () => {
  const info = analyzeName('project.notes.txt(2)')
  assert.equal(info.number, '2')
  assert.equal(info.baseName, 'project.notes.txt')
  assert.equal(info.canonicalName, 'project.notes (2).txt')
})

test('dotfiles have no extension', () => {
  const info = analyzeName('.nomedia')
  assert.equal(info.ext, '')
  assert.equal(info.extKnown, false)
  assert.equal(info.canonicalName, '.nomedia')
})

test('suggestNormalizedName only fires when the name changes', () => {
  assert.equal(suggestNormalizedName('应用.apk'), null)
  const suggestion = suggestNormalizedName('应用.apk（1）')
  assert.deepEqual(suggestion.from, '应用.apk（1）')
  assert.equal(suggestion.to, '应用 (1).apk')
})
