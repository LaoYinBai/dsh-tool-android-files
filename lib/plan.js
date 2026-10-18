/**
 * Deterministic plan construction.
 *
 * A plan is the only thing a user ever approves, so it must be reproducible:
 * the same index and the same policy must yield byte-identical operations and
 * therefore the same digest. Every op carries the identity it was built from
 * (`dev`, `ino`, `mtime`, hash) so execution can re-prove the world has not
 * moved underneath it.
 * @module af/plan
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AfError, CODE } from './errors.js'

export const PLAN_MODES = ['dedupe']

/** Policy is part of the digest: changing it invalidates old approvals. */
export const DEDUPE_POLICY = Object.freeze({
  keep: 'no-counter-then-shortest-path-then-lexicographic',
  require: 'size-and-sha256-equal',
  protected: 'skip-whole-group',
  zeroByte: 'never-grouped',
})

/**
 * Pick the member to keep.
 *
 * Order: a name without a download counter first (it is the canonical one), then
 * the shorter relative path, then lexicographic order so the result never
 * depends on directory read order.
 */
export function chooseKeeper(members) {
  return [...members].sort((left, right) => {
    const leftCounter = left.number === null || left.number === undefined ? 0 : 1
    const rightCounter = right.number === null || right.number === undefined ? 0 : 1
    if (leftCounter !== rightCounter) return leftCounter - rightCounter
    if (left.relPath.length !== right.relPath.length) return left.relPath.length - right.relPath.length
    if (left.relPath < right.relPath) return -1
    if (left.relPath > right.relPath) return 1
    return left.id - right.id
  })[0]
}

/** Filesystem-safe fragment of a basename, for the quarantine target. */
function safeName(name) {
  return String(name).replace(/[/\\\u0000]/g, '_').slice(0, 180)
}

/**
 * Build every operation for one dedupe plan.
 *
 * @param {{groups: Array<{size: number, members: object[]}>, scanId: number, planId: number, quarantineDir: string}} input
 */
export function buildDedupePlan(input) {
  const { groups, planId, quarantineDir } = input
  const ops = []
  let keepCount = 0
  let skippedGroups = 0
  let skippedBytes = 0
  let plannedBytes = 0
  const skippedReasons = []

  for (const group of groups) {
    const members = group.members
    if (members.length < 2) continue
    const redundant = group.size * (members.length - 1)
    const protectedMember = members.find((member) => String(member.protection ?? '') !== '')
    if (protectedMember) {
      skippedGroups++
      skippedBytes += redundant
      skippedReasons.push({
        size: group.size,
        members: members.length,
        bytes: redundant,
        reason: `member ${protectedMember.id} is protected (${protectedMember.protection})`,
      })
      continue
    }
    const keeper = chooseKeeper(members)
    keepCount++
    for (const member of members) {
      if (member.id === keeper.id) continue
      const op = {
        opId: `op-${String(ops.length + 1).padStart(4, '0')}`,
        kind: 'quarantine',
        groupKey: `${group.size}:${member.hash.slice(0, 12)}`,
        fileId: member.id,
        keepFileId: keeper.id,
        srcPath: path.join(member.root, member.relPath),
        dstPath: path.join(quarantineDir, String(planId), `${member.id}_${safeName(member.name)}`),
        size: member.size,
        dev: String(member.dev),
        ino: String(member.ino),
        mtimeMs: member.mtimeMs,
        hash: member.hash,
        reason: `与文件 ${keeper.id} 字节完全相同`,
      }
      plannedBytes += member.size
      ops.push(op)
    }
  }

  return {
    ops,
    keepCount,
    skippedGroups,
    skippedBytes,
    plannedBytes,
    skippedReasons,
    policy: DEDUPE_POLICY,
  }
}

/**
 * Stable serialization used for the digest.
 *
 * Keys are written in a fixed order and ops keep their construction order, so a
 * re-serialization of the same plan always produces the same bytes.
 */
export function canonicalPlan(planId, mode, policy, ops) {
  return JSON.stringify({
    planId,
    mode,
    policy,
    ops: ops.map((op) => ({
      opId: op.opId,
      kind: op.kind,
      fileId: op.fileId,
      keepFileId: op.keepFileId,
      srcPath: op.srcPath,
      dstPath: op.dstPath,
      size: op.size,
      dev: op.dev,
      ino: op.ino,
      mtimeMs: op.mtimeMs,
      hash: op.hash,
    })),
  })
}

export function planDigest(planId, mode, policy, ops) {
  return createHash('sha256').update(canonicalPlan(planId, mode, policy, ops)).digest('hex')
}

/** Assert a stored plan still matches its digest and its ops were not edited. */
export function assertPlanIntegrity(plan) {
  const recomputed = planDigest(plan.id, plan.mode, plan.policy, plan.ops)
  if (recomputed !== plan.digest) {
    throw new AfError(CODE.PLAN_DIGEST_MISMATCH, 'stored plan no longer matches its digest', {
      planId: plan.id,
      expected: plan.digest,
      actual: recomputed,
    })
  }
  return true
}

/** Compact byte size for the card headline. */
function humanBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index++
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`
}

/** Thousands separators so raw numbers stay readable in plain text. */
function group(value) {
  return String(Math.trunc(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Plain-text plan body for the approval card's "view full text" panel.
 *
 * That panel renders the string verbatim -- it is not a Markdown renderer -- so
 * this deliberately contains no Markdown syntax: no headings, no emphasis, no
 * backticks. Structure comes from separator rules and indented blocks, which
 * read correctly in a preformatted pane.
 *
 * The collapsed card previews only its first two lines, so line 2 carries the
 * numbers a person needs before clicking.
 */
export function planText(plan, options = {}) {
  const rule = '─'.repeat(30)
  const restore = plan.mode === 'restore'
  const moved = restore
    ? `${plan.ops.length} 项操作 · 从隔离区恢复 ${humanBytes(plan.plannedBytes)} 到原路径`
    : `${plan.ops.length} 项操作 · 移动 ${humanBytes(plan.plannedBytes)} 到隔离区`
  const skipped = plan.skippedGroups > 0
    ? ` · 跳过 ${plan.skippedGroups} 组受保护（${humanBytes(plan.skippedBytes)}）`
    : ''
  const lines = []
  lines.push(`${restore ? '文件恢复计划' : '文件整理计划'} #${plan.id}`)
  lines.push(`${moved}${skipped}`)
  lines.push(rule)
  lines.push('')
  lines.push(`模式      ${plan.mode}`)
  lines.push(`扫描      #${plan.scanId}`)
  lines.push(restore ? '目标      原路径，已存在则跳过' : `保留      ${plan.keepCount} 个文件原地不动`)
  lines.push(`${restore ? '恢复原位' : '移入隔离'}  ${plan.ops.length} 个文件 / ${group(plan.plannedBytes)} 字节`)
  if (plan.skippedGroups > 0) {
    lines.push(`跳过      ${plan.skippedGroups} 组受保护 / ${group(plan.skippedBytes)} 字节`)
  }
  lines.push(`摘要      ${plan.digest}`)
  lines.push('')
  const limit = options.limit ?? 40
  const shown = Math.min(limit, plan.ops.length)
  lines.push(`操作明细（${shown}/${plan.ops.length}）`)
  lines.push(rule)
  plan.ops.slice(0, shown).forEach((op, index) => {
    const base = op.srcPath.split('/').pop()
    lines.push(`${index + 1}/${plan.ops.length}  ${base}`)
    lines.push(`      位置  ${op.srcPath}`)
    lines.push(`      隔离  ${op.dstPath}`)
    lines.push(`      大小  ${group(op.size)} 字节`)
    lines.push(`      原因  ${op.reason}`)
    lines.push('')
  })
  if (plan.ops.length > shown) {
    lines.push(`… 其余 ${plan.ops.length - shown} 项用 af_plan_preview 分页查看`)
    lines.push('')
  }
  lines.push('执行前逐项复核')
  lines.push(rule)
  lines.push('dev + ino + 大小 + 修改时间 + SHA-256，任一变化即跳过该项。')
  lines.push('目标采用独占创建，已存在则失败，绝不覆盖。')
  lines.push('取消时停止新操作，已完成的项保留记录。')
  lines.push('')
  lines.push('隔离区文件不会被删除；恢复需要新的计划与授权。')
  return lines.join('\n')
}

/** Policy for undoing a committed plan. Part of the digest, like every policy. */
export const RESTORE_POLICY = Object.freeze({
  require: 'quarantine-file-hash-matches-record',
  target: 'never-overwrite',
  order: 'reverse-of-the-source-plan',
})

/**
 * Build the operations that undo a committed plan.
 *
 * Each entry is produced by the caller after it has stat-ed and hashed the
 * quarantine file, so the executor can re-prove it exactly like a forward
 * operation: source = the quarantined copy, destination = the original path.
 *
 * @param {Array<{fileId: number, quarantinePath: string, originalPath: string,
 *   size: number, dev: string, ino: string, mtimeMs: number, hash: string}>} entries
 */
export function buildRestorePlan(entries) {
  const ops = entries.map((entry, index) => ({
    opId: `rs-${String(index + 1).padStart(4, '0')}`,
    kind: 'restore',
    groupKey: '',
    fileId: Number(entry.fileId),
    keepFileId: 0,
    srcPath: entry.quarantinePath,
    dstPath: entry.originalPath,
    size: Number(entry.size),
    dev: String(entry.dev),
    ino: String(entry.ino),
    mtimeMs: Math.trunc(Number(entry.mtimeMs)),
    hash: String(entry.hash),
    reason: `恢复 ${entry.fileId} 号文件到原位置`,
  }))
  return {
    ops,
    keepCount: 0,
    skippedGroups: 0,
    skippedBytes: 0,
    plannedBytes: ops.reduce((sum, op) => sum + op.size, 0),
    policy: RESTORE_POLICY,
  }
}
/** Policy for archiving by category and month. Part of the digest. */
export const ARCHIVE_POLICY = Object.freeze({
  layout: 'category/YYYY-MM',
  scope: 'root-level-only',
  conflict: 'free-number-before-extension',
  protected: 'skip',
  existingTargetFolder: 'create',
})

/** Folder names stay Chinese so the tree reads naturally in a file manager. */
export const CATEGORY_FOLDER = Object.freeze({
  image: '图片',
  video: '视频',
  audio: '音频',
  document: '文档',
  archive: '压缩包',
  installer: '安装包',
  other: '其他',
})

/** `YYYY-MM` in local time. This is the modification month, never "created". */
export function monthBucket(mtimeMs) {
  const date = new Date(Number(mtimeMs))
  if (Number.isNaN(date.getTime())) return '1970-01'
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${date.getFullYear()}-${month}`
}

/**
 * Relative destination for one file: `<category>/<YYYY-MM>/<name>`.
 *
 * The category is a fixed Chinese folder name, so the tree is predictable and a
 * second run recognises its own output as already archived.
 */
export function archiveRelPath(category, mtimeMs, name) {
  const folder = CATEGORY_FOLDER[category] ?? CATEGORY_FOLDER.other
  return `${folder}/${monthBucket(mtimeMs)}/${name}`
}

/**
 * Turn resolved archive entries into operations.
 *
 * Every op is a plain move: source is the file at the root, destination is the
 * categorised path. The executor does not care which mode produced it, which is
 * why archive reuses the whole verified-copy path instead of growing a second
 * one.
 *
 * @param {Array<{fileId: number, root: string, srcPath: string, dstPath: string,
 *   size: number, dev: string, ino: string, mtimeMs: number, hash: string|null,
 *   category: string}>} entries
 */
export function buildArchivePlan(entries) {
  const ops = entries.map((entry, index) => ({
    opId: `ar-${String(index + 1).padStart(4, '0')}`,
    kind: 'move',
    groupKey: entry.category,
    fileId: Number(entry.fileId),
    keepFileId: 0,
    srcPath: entry.srcPath,
    dstPath: entry.dstPath,
    size: Number(entry.size),
    dev: String(entry.dev),
    ino: String(entry.ino),
    mtimeMs: Math.trunc(Number(entry.mtimeMs)),
    hash: entry.hash ?? null,
    reason: `归入 ${entry.dstPath.slice(entry.root.length + 1).split('/').slice(0, 2).join('/')}`,
  }))
  return {
    ops,
    keepCount: 0,
    skippedGroups: 0,
    skippedBytes: 0,
    plannedBytes: ops.reduce((sum, op) => sum + op.size, 0),
    policy: ARCHIVE_POLICY,
  }
}
/** Policy for normalising names whose counter sits after the extension. */
export const RENAME_POLICY = Object.freeze({
  rule: 'move-counter-before-extension',
  scope: 'explicit-canonical-name-only',
  conflict: 'free-number-before-extension',
  protected: 'skip',
})

/**
 * Build a rename plan.
 *
 * Only names whose canonical form differs structurally are proposed; a name that
 * is already canonical is never touched, so respacing a user's file is not part
 * of this operation.
 */
export function buildRenamePlan(entries) {
  const ops = entries.map((entry, index) => ({
    opId: `rn-${String(index + 1).padStart(4, '0')}`,
    kind: 'rename',
    groupKey: '',
    fileId: Number(entry.fileId),
    keepFileId: 0,
    srcPath: entry.srcPath,
    dstPath: entry.dstPath,
    size: Number(entry.size),
    dev: String(entry.dev),
    ino: String(entry.ino),
    mtimeMs: Math.trunc(Number(entry.mtimeMs)),
    hash: null,
    reason: `规范为 ${path.basename(entry.dstPath)}`,
  }))
  return {
    ops,
    keepCount: 0,
    skippedGroups: 0,
    skippedBytes: 0,
    plannedBytes: ops.reduce((sum, op) => sum + op.size, 0),
    policy: RENAME_POLICY,
  }
}