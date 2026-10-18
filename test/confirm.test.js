import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { APPROVE_LABEL, QUESTION_ID, requestPlanApproval } from '../lib/confirm.js'
import { openStore } from '../lib/db.js'
import { AfError, CODE } from '../lib/errors.js'
import { DEDUPE_POLICY, planDigest } from '../lib/plan.js'

function ctxWith(ask) {
  return { get: (name) => (name === 'userQuestions' ? { ask } : undefined) }
}

const baseInput = { planId: 1, digest: 'd'.repeat(64), markdown: '# plan' }

test('only an exact approve selection counts as approval', async () => {
  const approved = await requestPlanApproval(
    ctxWith(async () => ({ answers: [{ id: QUESTION_ID, selected: [APPROVE_LABEL] }] })),
    baseInput,
  )
  assert.deepEqual(approved, { approved: true, reason: 'approved' })

  const other = await requestPlanApproval(
    ctxWith(async () => ({ answers: [{ id: QUESTION_ID, selected: ['Request changes'] }] })),
    baseInput,
  )
  assert.equal(other.approved, false)

  const extra = await requestPlanApproval(
    ctxWith(async () => ({ answers: [{ id: QUESTION_ID, selected: [APPROVE_LABEL, 'Request changes'] }] })),
    baseInput,
  )
  assert.equal(extra.approved, false, 'selecting both options is not an approval')

  const freeText = await requestPlanApproval(
    ctxWith(async () => ({ answers: [{ id: QUESTION_ID, selected: [APPROVE_LABEL], custom: 'do it' }] })),
    baseInput,
  )
  assert.equal(freeText.approved, false, 'a free-text answer outranks the label')
})

test('a cancelled question is not an approval', async () => {
  const cancelled = await requestPlanApproval(
    ctxWith(async () => {
      const error = new Error('user cancelled')
      error.code = 'ASK_CANCELLED'
      throw error
    }),
    baseInput,
  )
  assert.deepEqual(cancelled, { approved: false, reason: 'cancelled' })
})

test('without the user-questions service the plan cannot be approved', async () => {
  await assert.rejects(
    () => requestPlanApproval({ get: () => undefined }, baseInput),
    (err) => err instanceof AfError && err.code === CODE.APPROVAL_UNAVAILABLE,
  )
})

test('approval is single-use and digest-bound', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'af-plan-'))
  const dbPath = path.join(dir, 'index.sqlite')
  try {
    const store = await openStore(dbPath)
    const scanId = store.startScan(['/x'])
    const planId = store.createPlan(scanId, 'dedupe', DEDUPE_POLICY)
    const ops = [{
      opId: 'op-0001',
      kind: 'quarantine',
      fileId: 2,
      keepFileId: 1,
      srcPath: '/x/b.mp4',
      dstPath: '/q/1/2_b.mp4',
      size: 10,
      dev: '1',
      ino: '2',
      mtimeMs: 3,
      hash: 'h',
      reason: 'dup',
    }]
    const digest = planDigest(planId, 'dedupe', DEDUPE_POLICY, ops)
    store.finalizePlan(planId, { digest, ops, keepCount: 1, skippedGroups: 0, skippedBytes: 0, plannedBytes: 10 })

    const stored = store.getPlan(planId)
    assert.equal(stored.status, 'proposed')
    assert.equal(stored.digest, digest)
    assert.equal(stored.ops.length, 1)

    assert.equal(store.approvePlan(planId, 'wrong-digest', 'call-1'), false, 'a wrong digest must not approve')
    assert.equal(store.approvePlan(planId, digest, 'call-1'), true)
    assert.equal(store.approvePlan(planId, digest, 'call-2'), false, 'a replay must not approve again')
    assert.equal(store.getPlan(planId).status, 'approved')
    store.raw.close()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
