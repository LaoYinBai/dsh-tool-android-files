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
  'video.mp4.part': 'partial-download',
  'iso.1': 'volume-one',
  'iso.2': 'volume-two',
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
  // Test double for the host's answerer chain: the plan gate must be exercised.
  get(name) {
    if (name !== 'userQuestions') return undefined
    return { ask: async () => ({ answers: [{ id: 'af-plan-review', selected: ['Approve plan'] }] }) }
  },
}

const dispose = apply(ctx, { roots: [fixture], maxEntries: 1000, quarantineDir: path.join(fixture, '.quarantine'), probeDir: '' })
assert.equal(definitions.length, 11, 'eleven tools must register')
assert.deepEqual(
  definitions.map((definition) => definition.name),
  ['af_backend', 'af_probe_write', 'af_scan', 'af_scan_report', 'af_files', 'af_duplicates', 'af_names', 'af_plan_create', 'af_plan_preview', 'af_plan_apply', 'af_plan_execute'],
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
for (const field of ['ok=', 'plugin_version=', 'roots_configured=', 'roots_ready=', 'db_writable=', 'sqlite=', 'journal_mode=']) {
  assert.ok(rendered.get('af_backend').includes(field), `af_backend render is missing ${field}`)
}
console.log(rendered.get('af_backend'))

const probe = await call('af_probe_write')
assert.equal(probe.ok, true, `af_probe_write failed: ${probe.error}`)
assert.equal(probe.cleanup_ok, true, `probe left files behind: ${probe.checks_text}`)
assert.ok(probe.checks_text.includes('exclusive_create'), 'probe must report exclusive_create')
assert.equal(probe.shared_ran, false, 'no probeDir is configured in this fixture')
console.log('--- af_probe_write render ---')
console.log(rendered.get('af_probe_write'))

const scan = await call('af_scan')
assert.equal(scan.ok, true, `af_scan failed: ${scan.error}`)
console.log('af_scan:', JSON.stringify(scan))
assert.equal(scan.files, 13)
assert.ok(scan.duplicate_groups >= 2)
assert.equal(scan.protected, 3, 'expected three protected files')

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
await call('af_files', { limit: 20 })
assert.ok(!rendered.get('af_files').includes('family=iso'), 'masked output must not leak the split family name')
assert.ok(rendered.get('af_files').includes('family=#'), 'masked output keeps an opaque family token for grouping')

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

const plan = await call('af_plan_create', {})
assert.equal(plan.ok, true, `af_plan_create failed: ${plan.error}`)
assert.ok(plan.ops >= 3, `expected at least three operations, got ${plan.ops}`)
assert.equal(plan.digest.length, 64)
console.log('--- af_plan_create render ---')
console.log(rendered.get('af_plan_create'))

const preview = await call('af_plan_preview', { plan_id: plan.plan_id, limit: 20 })
assert.equal(preview.ok, true)
assert.equal(preview.total, plan.ops)
assert.equal(preview.status, 'proposed')
assert.ok(preview.items.every((item) => item.src.startsWith('#')), 'preview must mask paths by default')

const applied = await call('af_plan_apply', { plan_id: plan.plan_id })
assert.equal(applied.ok, true, `af_plan_apply failed: ${applied.error}`)
assert.equal(applied.authorized, true)
assert.equal(applied.executed, 0)
console.log(rendered.get('af_plan_apply'))

const replay = await call('af_plan_apply', { plan_id: plan.plan_id })
assert.equal(replay.ok, false, 'a second approval must be refused')
assert.ok(replay.error.startsWith('AF_PLAN_NOT_PROPOSED'), replay.error)

const executed = await call('af_plan_execute', { plan_id: plan.plan_id })
assert.equal(executed.ok, true, `af_plan_execute failed: ${executed.error}`)
assert.equal(executed.committed, plan.ops, 'every operation must commit')
assert.equal(executed.failed, 0)
assert.equal(executed.status, 'committed')
console.log('--- af_plan_execute render ---')
console.log(rendered.get('af_plan_execute'))

// The keeper stays, the quarantined twin is gone from the tree but present in quarantine.
assert.equal(fs.existsSync(path.join(fixture, '工具.apk')), true, 'the keeper must stay')
assert.equal(fs.existsSync(path.join(fixture, '工具.apk（1）')), false, 'the duplicate must leave the tree')
const quarantined = path.join(fixture, '.quarantine', String(plan.plan_id))
const quarantinedFiles = fs.readdirSync(quarantined)
assert.equal(quarantinedFiles.length, plan.ops, 'every operation must leave exactly one file in quarantine')
const replayed = await call('af_plan_execute', { plan_id: plan.plan_id })
assert.equal(replayed.ok, false, 'a committed plan must not execute twice')
assert.ok(replayed.error.startsWith('AF_PLAN_NOT_PROPOSED'), replayed.error)

dispose()
fs.rmSync(fixture, { recursive: true, force: true })
fs.rmSync(home, { recursive: true, force: true })
console.log('SMOKE OK')
