import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  DEDUPE_POLICY,
  buildDedupePlan,
  canonicalPlan,
  chooseKeeper,
  planDigest,
  planText,
  assertPlanIntegrity,
} from '../lib/plan.js'
import { AfError, CODE } from '../lib/errors.js'
import { RESTORE_POLICY, buildRestorePlan, ARCHIVE_POLICY, archiveRelPath, buildArchivePlan } from '../lib/plan.js'

function member(id, name, extra = {}) {
  return {
    id,
    name,
    relPath: extra.relPath ?? name,
    root: '/storage/emulated/0/Download',
    size: extra.size ?? 100,
    dev: '65078',
    ino: String(1000 + id),
    mtimeMs: 1_700_000_000_000,
    hash: extra.hash ?? 'a'.repeat(64),
    number: extra.number ?? null,
    protection: extra.protection ?? '',
  }
}

test('keeper prefers a name without a download counter', () => {
  const keeper = chooseKeeper([
    member(1, 'a (1).mp4', { number: '1' }),
    member(2, 'a.mp4'),
    member(3, 'a (2).mp4', { number: '2' }),
  ])
  assert.equal(keeper.id, 2)
})

test('keeper falls back to the shortest path, then lexicographic order', () => {
  const keeper = chooseKeeper([
    member(1, 'x.mp4', { relPath: 'sub/dir/x.mp4' }),
    member(2, 'x.mp4', { relPath: 'x.mp4' }),
    member(3, 'x.mp4', { relPath: 'sub/x.mp4' }),
  ])
  assert.equal(keeper.relPath, 'x.mp4')

  const tie = chooseKeeper([
    member(1, 'b.mp4'),
    member(2, 'a.mp4'),
  ])
  assert.equal(tie.relPath, 'a.mp4')
})

test('a group with a protected member is skipped wholesale', () => {
  const result = buildDedupePlan({
    scanId: 1,
    planId: 7,
    quarantineDir: '/storage/emulated/0/DeepSeekHarness/quarantine',
    groups: [
      { size: 100, members: [member(1, 'a.1', { protection: 'split;family=a' }), member(2, 'a (1).1')] },
      { size: 50, members: [member(3, 'b.mp4', { size: 50 }), member(4, 'b (1).mp4', { number: '1', size: 50 })] },
    ],
  })
  assert.equal(result.ops.length, 1, 'only the unprotected group produces an operation')
  assert.equal(result.ops[0].fileId, 4)
  assert.equal(result.ops[0].keepFileId, 3)
  assert.equal(result.skippedGroups, 1)
  assert.equal(result.skippedBytes, 100)
  assert.equal(result.plannedBytes, 50)
  assert.equal(result.keepCount, 1)
})

test('quarantine targets are unique per file and stay under the quarantine root', () => {
  const result = buildDedupePlan({
    scanId: 1,
    planId: 9,
    quarantineDir: '/q',
    groups: [{ size: 10, members: [member(1, 'same.mp4'), member(2, 'same.mp4'), member(3, 'same.mp4')] }],
  })
  assert.equal(result.ops.length, 2)
  const targets = result.ops.map((op) => op.dstPath)
  assert.equal(new Set(targets).size, 2)
  const quarantineRoot = path.join('/q', '9')
  for (const target of targets) assert.ok(target.startsWith(quarantineRoot), target)
})

test('the digest is stable for identical input and changes with the plan', () => {
  const groups = [{ size: 10, members: [member(1, 'a.bin'), member(2, 'b.bin')] }]
  const first = buildDedupePlan({ scanId: 1, planId: 5, quarantineDir: '/q', groups })
  const again = buildDedupePlan({ scanId: 1, planId: 5, quarantineDir: '/q', groups })
  const digestA = planDigest(5, 'dedupe', DEDUPE_POLICY, first.ops)
  const digestB = planDigest(5, 'dedupe', DEDUPE_POLICY, again.ops)
  assert.equal(digestA, digestB)
  assert.equal(canonicalPlan(5, 'dedupe', DEDUPE_POLICY, first.ops), canonicalPlan(5, 'dedupe', DEDUPE_POLICY, again.ops))

  const other = planDigest(6, 'dedupe', DEDUPE_POLICY, first.ops)
  assert.notEqual(digestA, other, 'a different plan id must not share a digest')
})

test('tampering with stored ops invalidates the digest', () => {
  const groups = [{ size: 10, members: [member(1, 'a.bin'), member(2, 'b.bin')] }]
  const built = buildDedupePlan({ scanId: 1, planId: 5, quarantineDir: '/q', groups })
  const digest = planDigest(5, 'dedupe', DEDUPE_POLICY, built.ops)
  const plan = { id: 5, mode: 'dedupe', policy: DEDUPE_POLICY, digest, ops: built.ops }
  assert.equal(assertPlanIntegrity(plan), true)

  const tampered = { ...plan, ops: built.ops.map((op) => ({ ...op, dstPath: '/etc/passwd' })) }
  assert.throws(
    () => assertPlanIntegrity(tampered),
    (err) => err instanceof AfError && err.code === CODE.PLAN_DIGEST_MISMATCH,
  )
})

test('the markdown body carries the digest and every operation', () => {
  const groups = [{ size: 10, members: [member(1, 'a.bin'), member(2, 'b.bin')] }]
  const built = buildDedupePlan({ scanId: 1, planId: 5, quarantineDir: '/q', groups })
  const digest = planDigest(5, 'dedupe', DEDUPE_POLICY, built.ops)
  const markdown = planText({
    id: 5,
    mode: 'dedupe',
    scanId: 1,
    digest,
    ops: built.ops,
    keepCount: built.keepCount,
    plannedBytes: built.plannedBytes,
    skippedGroups: 0,
    skippedBytes: 0,
  })
  assert.ok(markdown.includes(digest), 'the card must show the digest the approval binds to')
  assert.ok(markdown.includes('b.bin'))
  assert.ok(markdown.includes('独占创建'))
  // The card previews only its first two content lines, so line 2 must carry the
  // decision-relevant numbers rather than the mode name.
  const preview = markdown.split('\n').filter((line) => line.trim() !== '')
  assert.ok(preview[1].includes('项操作'), preview[1])
  assert.ok(preview[1].includes('移动'), preview[1])
})

test('a restore plan mirrors the quarantined files and keeps its own digest', () => {
  const entries = [
    { fileId: 2, quarantinePath: '/q/3/2_a.mp4', originalPath: '/d/a (1).mp4', size: 10, dev: '1', ino: '2', mtimeMs: 5, hash: 'h2' },
    { fileId: 5, quarantinePath: '/q/3/5_b.mp4', originalPath: '/d/b.mp4', size: 20, dev: '1', ino: '5', mtimeMs: 6, hash: 'h5' },
  ]
  const built = buildRestorePlan(entries)
  assert.equal(built.ops.length, 2)
  assert.equal(built.ops[0].kind, 'restore')
  assert.equal(built.ops[0].srcPath, '/q/3/2_a.mp4')
  assert.equal(built.ops[0].dstPath, '/d/a (1).mp4')
  assert.equal(built.plannedBytes, 30)
  assert.deepEqual(built.policy, RESTORE_POLICY)

  const restoreDigest = planDigest(9, 'restore', built.policy, built.ops)
  const dedupeDigest = planDigest(9, 'dedupe', DEDUPE_POLICY, built.ops)
  assert.notEqual(restoreDigest, dedupeDigest, 'mode is part of the digest')
  assert.equal(planDigest(9, 'restore', built.policy, buildRestorePlan(entries).ops), restoreDigest)
})
test('archive paths group by category then modification month', () => {
  const ms = new Date(2026, 9, 18, 12).getTime()
  assert.equal(archiveRelPath('image', ms, 'a.jpg'), '图片/2026-10/a.jpg')
  assert.equal(archiveRelPath('installer', ms, 'x.apk'), '安装包/2026-10/x.apk')
  assert.equal(archiveRelPath('other', ms, 'no-extension'), '其他/2026-10/no-extension')

  const built = buildArchivePlan([{
    fileId: 1,
    root: '/r',
    srcPath: '/r/a.jpg',
    dstPath: '/r/图片/2026-10/a.jpg',
    size: 5,
    dev: '1',
    ino: '2',
    mtimeMs: ms,
    hash: null,
    category: 'image',
  }])
  assert.equal(built.ops.length, 1)
  assert.equal(built.ops[0].kind, 'move')
  assert.equal(built.ops[0].hash, null, 'archive ops carry no hash: it is computed at execution')
  assert.equal(built.plannedBytes, 5)
  assert.deepEqual(built.policy, ARCHIVE_POLICY)
  assert.notEqual(
    planDigest(3, 'archive', built.policy, built.ops),
    planDigest(3, 'dedupe', built.policy, built.ops),
    'mode is part of the digest',
  )
})