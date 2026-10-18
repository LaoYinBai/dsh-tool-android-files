import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { openStore } from '../lib/db.js'
import { executePlan, spaceVerdict, SPACE_MARGIN_BYTES } from '../lib/execute.js'
import { DEDUPE_POLICY, RESTORE_POLICY, buildDedupePlan, buildRestorePlan, planDigest } from '../lib/plan.js'
import { sha256File } from '../lib/hash.js'

async function memberFor(id, absPath, root) {
  const stat = await fsp.lstat(absPath)
  const digest = await sha256File(absPath)
  return {
    id,
    name: path.basename(absPath),
    relPath: path.relative(root, absPath).split(path.sep).join('/'),
    root,
    size: Number(stat.size),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeMs: Math.trunc(Number(stat.mtimeMs)),
    hash: digest.sha256,
    number: null,
    protection: '',
  }
}

/** Build an approved plan row over real files and return it with its store. */
async function approvedPlan(dir, members, options = {}) {
  const root = options.root ?? path.join(dir, 'Download')
  const quarantineDir = options.quarantineDir ?? path.join(dir, 'quarantine')
  const dbPath = path.join(dir, 'index.sqlite')
  const store = await openStore(dbPath)
  const scanId = store.startScan([root])
  const planId = store.createPlan(scanId, 'dedupe', DEDUPE_POLICY)
  const built = buildDedupePlan({
    groups: [{ size: members[0].size, members }],
    scanId,
    planId,
    quarantineDir,
  })
  const digest = planDigest(planId, 'dedupe', DEDUPE_POLICY, built.ops)
  store.finalizePlan(planId, {
    digest,
    ops: built.ops,
    keepCount: built.keepCount,
    skippedGroups: built.skippedGroups,
    skippedBytes: built.skippedBytes,
    plannedBytes: built.plannedBytes,
  })
  const approved = store.approvePlan(planId, digest, 'test-call')
  assert.equal(approved, true, 'plan must approve once')
  return { store, plan: store.getPlan(planId), quarantineDir, root }
}

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-exec-'))
  const root = path.join(dir, 'Download')
  await fsp.mkdir(root, { recursive: true })
  return { dir, root, quarantineDir: path.join(dir, 'quarantine') }
}

test('a verified copy is quarantined and the source removed', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const payload = Buffer.from('identical payload for dedupe')
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    await fsp.writeFile(a, payload)
    await fsp.writeFile(b, payload)
    const members = [await memberFor(1, a, root), await memberFor(2, b, root)]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })

    const result = await executePlan(store, plan, { quarantineDir })
    assert.equal(result.status, 'committed')
    assert.equal(result.committed, 1)
    assert.equal(result.failed, 0)
    assert.equal(await fsp.readFile(path.join(quarantineDir, String(plan.id), '2_b.mp4'), 'utf8'), payload.toString())
    await assert.rejects(() => fsp.lstat(b), /ENOENT/, 'the source copy must be gone')
    assert.ok(await fsp.lstat(a), 'the kept file must stay')

    const ops = store.listPlanOps(plan.id)
    assert.equal(ops.length, 1)
    assert.equal(ops[0].state, 'source-removed')
    assert.equal(store.getPlan(plan.id).status, 'committed')
    assert.ok(store.listExecLog(plan.id).some((entry) => entry.event === 'verified'))
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})

test('an existing quarantine target is never overwritten', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const payload = Buffer.from('payload-b')
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    await fsp.writeFile(a, payload)
    await fsp.writeFile(b, payload)
    const members = [await memberFor(1, a, root), await memberFor(2, b, root)]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })

    const target = path.join(quarantineDir, String(plan.id), '2_b.mp4')
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, 'pre-existing')

    const result = await executePlan(store, plan, { quarantineDir })
    assert.equal(result.failed, 1)
    assert.equal(result.status, 'needs-review')
    assert.equal(await fsp.readFile(target, 'utf8'), 'pre-existing', 'the existing file is untouched')
    // The operation must fail before the source is touched: both copies stay.
    assert.equal(await fsp.readFile(b, 'utf8'), 'payload-b', 'the source is kept when the target exists')
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})

test('a source that changed after the plan is skipped and kept', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    await fsp.writeFile(a, 'original')
    await fsp.writeFile(b, 'original')
    const members = [await memberFor(1, a, root), await memberFor(2, b, root)]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })

    await fsp.writeFile(b, 'changed after the plan')
    const result = await executePlan(store, plan, { quarantineDir })
    assert.equal(result.failed, 1)
    assert.equal(await fsp.readFile(b, 'utf8'), 'changed after the plan', 'the changed source is kept')
    assert.ok(await fsp.lstat(a))
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})

test('cancellation moves nothing and leaves the plan for review', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    await fsp.writeFile(a, 'zzz')
    await fsp.writeFile(b, 'zzz')
    const members = [await memberFor(1, a, root), await memberFor(2, b, root)]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })

    const controller = new AbortController()
    controller.abort()
    const result = await executePlan(store, plan, { quarantineDir, signal: controller.signal })
    assert.equal(result.committed, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.status, 'needs-review')
    assert.ok(await fsp.lstat(b), 'nothing may be removed when cancelled')
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})

test('a plan that is not approved cannot execute', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    await fsp.writeFile(a, 'same')
    await fsp.writeFile(b, 'same')
    const members = [await memberFor(1, a, root), await memberFor(2, b, root)]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })
    const proposed = { ...plan, status: 'proposed' }
    await assert.rejects(() => executePlan(store, proposed, { quarantineDir }), /not approved/)
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})

test('a restore plan reports the reverse direction and leaves no empty directory', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const payload = Buffer.from('round trip payload')
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    await fsp.writeFile(a, payload)
    await fsp.writeFile(b, payload)
    const members = [await memberFor(1, a, root), await memberFor(2, b, root)]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })
    const forward = await executePlan(store, plan, { quarantineDir })
    assert.equal(forward.note, '1 个文件已移入隔离区')

    const stored = store.getPlan(plan.id)
    const entries = []
    for (const op of stored.ops) {
      const copy = await memberFor(op.fileId, op.dstPath, path.dirname(op.dstPath))
      entries.push({
        fileId: op.fileId,
        quarantinePath: op.dstPath,
        originalPath: op.srcPath,
        size: copy.size,
        dev: copy.dev,
        ino: copy.ino,
        mtimeMs: copy.mtimeMs,
        hash: copy.hash,
      })
    }
    const restoreId = store.createPlan(stored.scanId, 'restore', RESTORE_POLICY, stored.id)
    const built = buildRestorePlan(entries)
    const digest = planDigest(restoreId, 'restore', built.policy, built.ops)
    store.finalizePlan(restoreId, {
      digest,
      ops: built.ops,
      keepCount: 0,
      skippedGroups: 0,
      skippedBytes: 0,
      plannedBytes: built.plannedBytes,
    })
    assert.equal(store.approvePlan(restoreId, digest, 'test-call'), true)

    const restored = await executePlan(store, store.getPlan(restoreId), { quarantineDir })
    assert.equal(restored.status, 'committed')
    assert.equal(restored.note, '1 个文件已恢复到原路径')
    assert.equal(await fsp.readFile(b, 'utf8'), payload.toString(), 'the file is back in place')
    await assert.rejects(() => fsp.lstat(path.join(quarantineDir, String(restoreId))), /ENOENT/)

    assert.equal(store.markRestored(stored.id, 'test'), true)
    assert.equal(store.markRestored(stored.id, 'test'), false, 'restoring is recorded once')
    const listed = store.listPlans(10)
    const forwardRow = listed.find((row) => row.id === stored.id)
    assert.equal(forwardRow.status, 'restored')
    assert.equal(forwardRow.restoredBy, restoreId)
    assert.equal(listed.find((row) => row.id === restoreId).sourcePlanId, stored.id)
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})
test('the space verdict refuses a run that cannot fit and allows one that does', () => {
  assert.equal(spaceVerdict({ freeBytes: 10_000, neededBytes: 100, marginBytes: 0 }).ok, true)
  const refused = spaceVerdict({ freeBytes: 10_000, neededBytes: 10_100, marginBytes: 0 })
  assert.equal(refused.ok, false)
  assert.equal(refused.shortfall, 100)
  assert.equal(spaceVerdict({ freeBytes: 100, neededBytes: 100, marginBytes: 0 }).ok, true)

  // The default margin is conservative on purpose: a 100 byte plan still wants
  // the headroom, so it fits only when the volume really has it.
  assert.equal(spaceVerdict({ freeBytes: 60 * 1024 * 1024, neededBytes: 100 }).ok, false)
  assert.equal(spaceVerdict({ freeBytes: 1024 * 1024 * 1024, neededBytes: 100 }).ok, true)
  assert.ok(SPACE_MARGIN_BYTES >= 1024 * 1024)

  // Unknown free space must not block: the per-operation checks still apply.
  assert.equal(spaceVerdict({ freeBytes: null, neededBytes: 10 }).ok, true)
  assert.equal(spaceVerdict({ freeBytes: 0, neededBytes: 10 }).ok, true)
})
test('a partially executed plan can be rolled back with a restore plan', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const payload = Buffer.from('partial failure payload')
    const a = path.join(root, 'a.bin')
    const b = path.join(root, 'b.bin')
    const c = path.join(root, 'c.bin')
    for (const file of [a, b, c]) await fsp.writeFile(file, payload)
    const members = [
      await memberFor(1, a, root),
      await memberFor(2, b, root),
      await memberFor(3, c, root),
    ]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })

    // Block the first operation so the run ends in needs-review with one file moved.
    const firstTarget = store.getPlan(plan.id).ops[0].dstPath
    await fsp.mkdir(path.dirname(firstTarget), { recursive: true })
    await fsp.writeFile(firstTarget, 'occupied')

    const forward = await executePlan(store, plan, { quarantineDir })
    assert.equal(forward.status, 'needs-review')
    assert.equal(forward.failed, 1)
    assert.equal(forward.committed, 1)

    // Restore only what actually moved; the failed operation has nothing to undo.
    const stored = store.getPlan(plan.id)
    const opsById = new Map(stored.ops.map((op) => [op.opId, op]))
    const entries = []
    for (const row of store.listPlanOps(plan.id)) {
      if (row.state !== 'source-removed') continue
      const original = opsById.get(row.opId)
      const copy = await memberFor(row.fileId, original.dstPath, path.dirname(original.dstPath))
      entries.push({
        fileId: row.fileId,
        quarantinePath: original.dstPath,
        originalPath: original.srcPath,
        size: copy.size,
        dev: copy.dev,
        ino: copy.ino,
        mtimeMs: copy.mtimeMs,
        hash: copy.hash,
      })
    }
    assert.equal(entries.length, 1, 'only the committed operation is restorable')

    const restoreId = store.createPlan(stored.scanId, 'restore', RESTORE_POLICY, stored.id)
    const built = buildRestorePlan(entries)
    const digest = planDigest(restoreId, 'restore', built.policy, built.ops)
    store.finalizePlan(restoreId, {
      digest,
      ops: built.ops,
      keepCount: 0,
      skippedGroups: 0,
      skippedBytes: 0,
      plannedBytes: built.plannedBytes,
    })
    assert.equal(store.approvePlan(restoreId, digest, 'test-call'), true)
    const restored = await executePlan(store, store.getPlan(restoreId), { quarantineDir })
    assert.equal(restored.status, 'committed')
    assert.equal(restored.committed, 1)

    // Every file is back, and the blocked target is still exactly what we wrote.
    for (const file of [a, b, c]) assert.ok(await fsp.lstat(file), `${file} must exist again`)
    assert.equal(await fsp.readFile(firstTarget, 'utf8'), 'occupied', 'the blocker is never touched')
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})
test('a move keeps the source modification time', async () => {
  const { dir, root, quarantineDir } = await fixture()
  try {
    const payload = Buffer.from('timestamp payload')
    const a = path.join(root, 'a.mp4')
    const b = path.join(root, 'b.mp4')
    await fsp.writeFile(a, payload)
    await fsp.writeFile(b, payload)
    const past = new Date('2026-03-05T10:00:00Z')
    await fsp.utimes(a, past, past)
    await fsp.utimes(b, past, past)

    const members = [await memberFor(1, a, root), await memberFor(2, b, root)]
    const { store, plan } = await approvedPlan(dir, members, { root, quarantineDir })
    const result = await executePlan(store, plan, { quarantineDir })
    assert.equal(result.status, 'committed')

    const moved = path.join(quarantineDir, String(plan.id), '2_b.mp4')
    const movedStat = await fsp.lstat(moved)
    assert.equal(
      Math.trunc(Number(movedStat.mtimeMs)),
      Math.trunc(past.getTime()),
      'the quarantined copy must keep the original modification time',
    )
    const log = store.listExecLog(plan.id)
    assert.ok(log.some((entry) => entry.event === 'times-preserved'), 'preservation is journalled')
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }).catch(() => {})
  }
})