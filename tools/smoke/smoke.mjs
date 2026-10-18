/**
 * End-to-end smoke test against the real DSH toolkit.
 *
 * Registers every tool through the actual `defineTool` compiler taken from the
 * installed DSH build, then drives a full scan over a throwaway fixture. This is
 * the closest to a load test that is possible without the Android device: it
 * proves the schemas compile, the tools execute, SQLite persists, duplicate
 * detection works, and the masking/boundary refusals behave.
 *
 * Prerequisites are documented in ./README.md. Run from the repository root:
 *   node tools/smoke/smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { buildZip } from './zip-fixture.mjs'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'af-e2e-'))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-home-'))
process.env.DSH_HOME = home

const seed = {
  '工具.apk': 'placeholder',
  '工具.apk（1）': 'placeholder',
  '工具.apk（2）': 'placeholder',
  'photo.JPG': 'JPEG-DATA',
  'photo (1).jpg': 'JPEG-DATA',
  'notes.txt': 'hello',
  'empty.txt': '',
  'sub/big.bin': 'x'.repeat(4096),
  'sub/big (1).bin': 'x'.repeat(4096),
  'sub/big (2).bin': 'y'.repeat(4096),
}
for (const [name, content] of Object.entries(seed)) {
  const target = path.join(fixture, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
// Two identical, structurally valid APKs (a duplicate pair) and one different one.
const apkBytes = buildZip([['AndroidManifest.xml', 'bin'], ['classes.dex', 'dex']])
const apkOther = buildZip([['AndroidManifest.xml', 'bin'], ['classes.dex', 'different']])
fs.writeFileSync(path.join(fixture, '工具.apk'), apkBytes)
fs.writeFileSync(path.join(fixture, '工具.apk（1）'), apkBytes)
fs.writeFileSync(path.join(fixture, '工具.apk（2）'), apkOther)

const { apply } = await import('../../lib/index.js')
const definitions = []
const ctx = {
  tools: {
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
  },
  logger: { warn: (message) => console.warn('[warn]', message) },
}

const dispose = apply(ctx, { roots: [fixture], maxEntries: 1000 })
assert.equal(definitions.length, 6, 'six tools must register')
assert.deepEqual(
  definitions.map((definition) => definition.name),
  ['af_backend', 'af_scan', 'af_scan_report', 'af_files', 'af_duplicates', 'af_names'],
)

const exec = () => ({
  callId: 'smoke',
  rootCallId: 'smoke',
  name: '',
  arguments: {},
  signal: new AbortController().signal,
})
const byName = (name) => definitions.find((definition) => definition.name === name)

// The registry validates every returned value against the compiled output
// schema; a stray field there breaks the whole call on device, so check it here.
// The model only ever sees the rendered text, so the render must carry every
// field the model has to reason about.
const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
const rendered = new Map()
function call(name, args = {}) {
  const definition = byName(name)
  return definition.execute(args, exec()).then((value) => {
    const violations = validateJsonSchemaValue(definition.output.schema, value, '')
    assert.deepEqual(violations, [], `${name} output violates its schema: ${violations.join('; ')}`)
    const body = definition.output.render(args, value).map((block) => block.text).join('\n')
    assert.match(body, new RegExp(`ok=${value.ok}`), `${name} render must expose ok=`)
    rendered.set(name, body)
    return value
  })
}

const backend = await call('af_backend')
assert.equal(backend.ok, true, `af_backend failed: ${backend.error}`)
for (const field of ['ok=', 'roots_configured=', 'roots_ready=', 'db_writable=', 'sqlite=', 'journal_mode=']) {
  assert.ok(rendered.get('af_backend').includes(field), `af_backend render is missing ${field}`)
}
console.log(rendered.get('af_backend'))

const scan = await call('af_scan')
assert.equal(scan.ok, true, `af_scan failed: ${scan.error}`)
console.log('af_scan:', JSON.stringify(scan))
assert.equal(scan.files, 10)
assert.ok(scan.duplicate_groups >= 2)

const report = await call('af_scan_report')
assert.equal(report.ok, true)
console.log('af_scan_report:', report.categories, '| dup groups', report.duplicate_groups, '| zero', report.zero_byte)

const masked = await call('af_files', { limit: 3 })
assert.equal(masked.revealed, false)
assert.ok(masked.items.every((item) => item.masked === true && item.rel_path.startsWith('#')))
console.log('--- af_files (masked) render ---')
console.log(rendered.get('af_files'))

const revealed = await call('af_files', { limit: 3, reveal: true })
assert.ok(revealed.items.every((item) => item.masked === false))

const duplicates = await call('af_duplicates', { reveal: true })
assert.ok(duplicates.groups >= 2, 'expected at least two duplicate groups')
console.log('af_duplicates groups:', duplicates.groups)
for (const group of duplicates.items) {
  console.log(` ${group.group_id} ${group.size}B x${group.count}:`, group.members.map((m) => m.rel_path).join(' | '))
}

const names = await call('af_names', { kind: 'numbered', limit: 20 })
assert.ok(names.items.some((item) => item.apk_verdict === 'apk-structure-ok'))
assert.ok(names.items.some((item) => item.name === '工具.apk（1）' && item.canonical_name === '工具 (1).apk'))
console.log('af_names:', names.total)
for (const item of names.items) {
  console.log(` ${item.id} ${item.name} -> ${item.canonical_name} [${item.number_form}] apk:${item.apk_verdict || '-'} {${item.flags}}`)
}

// A path outside the configured root is refused, never silently allowed.
const outside = await call('af_scan', { root: path.join(os.tmpdir(), 'somewhere-else') })
assert.equal(outside.ok, false)
assert.ok(outside.error.startsWith('AF_ROOT_NOT_ALLOWED'), outside.error)

// Android/data is refused by policy.
const denied = await call('af_scan', { root: '/storage/emulated/0/Android/data' })
assert.equal(denied.ok, false)
console.log('boundary refusals OK:', outside.error, '|', denied.error)

dispose()
fs.rmSync(fixture, { recursive: true, force: true })
fs.rmSync(home, { recursive: true, force: true })
console.log('SMOKE OK')
