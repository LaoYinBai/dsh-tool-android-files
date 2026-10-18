/**
 * Files that must never be moved, renamed or isolated on their own.
 *
 * Found on a real device: an 80 MB duplicate group whose four members all ended
 * in `.1`, plus `.part` and `.downloading` files. Treating any of those as a
 * redundant copy could destroy a half-finished download or one volume of a
 * split archive, so this module only ever *protects* — it never authorises an
 * action.
 * @module af/protect
 */

/** Extensions that mark an in-progress download. */
const PARTIAL_EXTS = new Set(['part', 'partial', 'downloading', 'crdownload', 'tmp', 'temp', 'aria2'])

/** SQLite side files: removing or moving one corrupts the database next to it. */
const TRANSIENT_EXTS = new Set(['db-journal', 'db-wal', 'db-shm', 'journal', 'lock'])

/**
 * `.1`, `.001`, `.z01`, `.r00` and friends: one volume of a multi-part set.
 * Capped at three digits so `movie.2024` is not mistaken for a family.
 */
const SPLIT_SUFFIX = /^(.*)\.(\d{1,3}|[rz]\d{2})$/i

/**
 * Classify one basename.
 *
 * @param {string} name basename only
 * @returns {{tags: string[], family: string|null, member: string|null, reason: string}}
 */
export function classifyProtection(name) {
  const out = { tags: [], family: null, member: null, reason: '' }
  if (typeof name !== 'string' || name === '') return out

  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''

  if (PARTIAL_EXTS.has(ext)) {
    out.tags.push('partial')
    out.reason = `in-progress download extension .${ext}`
    return out
  }
  if (TRANSIENT_EXTS.has(ext)) {
    out.tags.push('transient')
    out.reason = `transient side file .${ext}`
    return out
  }

  const split = SPLIT_SUFFIX.exec(name)
  if (split && split[1].length > 0) {
    out.tags.push('split')
    out.family = split[1]
    out.member = split[2]
    out.reason = `volume ${split[2]} of the multi-part set "${split[1]}"`
  }
  return out
}

/** True when a file must be excluded from every automatic action. */
export function isProtected(name) {
  return classifyProtection(name).tags.length > 0
}

/** Serialize protection tags for storage in one text column. */
export function encodeProtection(info) {
  const parts = [...info.tags]
  if (info.family) parts.push(`family=${info.family}`)
  return parts.join(';')
}
