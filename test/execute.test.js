import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { openStore } from '../lib/db.js'
import { executePlan } from '../lib/execute.js'
import { DEDUPE_POLICY, buildDedupePlan, planDigest } from '../lib/plan.js'
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
