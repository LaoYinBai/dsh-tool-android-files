/**
 * Category rules: an ordered list, first hit wins, conflicts are recorded.
 * @module af/classify
 */
import { CATEGORIES, DEFAULT_CATEGORY_BY_EXT, extOf } from './exts.js'

/**
 * Built-in rules.
 *
 * Deliberately extension-only: a wrong keyword rule can silently relocate a
 * user's file, while a wrong extension rule is at least inspectable. Users can
 * add keyword/size/dir rules through plugin config.
 */
export const DEFAULT_RULES = Object.freeze([
  { id: 'installer-ext', category: 'installer', exts: ['apk', 'apks', 'xapk', 'aab', 'ipa', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage'] },
  { id: 'archive-ext', category: 'archive', compounds: ['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', 'tar.lz'], exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz', 'tbz2', 'txz', 'iso', 'cab', 'lz', 'lzma', 'z'] },
  { id: 'image-ext', category: 'image', exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'svg', 'dng', 'cr2', 'nef', 'arw', 'raf', 'orf', 'srw'] },
  { id: 'video-ext', category: 'video', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', '3g2', 'ts', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'rmvb'] },
  { id: 'audio-ext', category: 'audio', exts: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'amr', 'ape', 'aiff', 'aif', 'mid', 'midi'] },
  { id: 'document-ext', category: 'document', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'markdown', 'csv', 'tsv', 'rtf', 'odt', 'ods', 'odp', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'html', 'htm', 'xml', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'log', 'tex'] },
])

/**
 * Validate user-supplied rules and append them after the built-ins.
 *
 * Invalid rules are dropped with a reason instead of aborting the plugin: one
 * malformed config entry must not remove every tool from the session.
 */
export function buildRules(userRules) {
  const rules = DEFAULT_RULES.map((rule) => ({ ...rule }))
  const problems = []
  if (userRules === undefined || userRules === null) return { rules, problems }
  if (!Array.isArray(userRules)) {
    problems.push('rules must be an array')
    return { rules, problems }
  }
  userRules.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      problems.push(`rules[${index}] is not an object`)
      return
    }
    const category = raw.category
    if (!CATEGORIES.includes(category)) {
      problems.push(`rules[${index}].category is not one of ${CATEGORIES.join('/')}`)
      return
    }
    const rule = { id: typeof raw.id === 'string' && raw.id ? raw.id : `user-${index}`, category }
    for (const key of ['exts', 'compounds', 'keywords', 'dirIncludes']) {
      if (raw[key] === undefined) continue
      if (!Array.isArray(raw[key]) || raw[key].some((value) => typeof value !== 'string')) {
        problems.push(`rules[${index}].${key} must be an array of strings`)
        return
      }
      rule[key] = raw[key].map((value) => value.toLowerCase())
    }
    for (const key of ['minSize', 'maxSize']) {
      if (raw[key] === undefined) continue
      if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) {
        problems.push(`rules[${index}].${key} must be a non-negative number`)
        return
      }
      rule[key] = raw[key]
    }
    rules.push(rule)
  })
  return { rules, problems }
}

function ruleMatches(rule, subject) {
  if (rule.exts && !(subject.ext && rule.exts.includes(subject.ext))) return false
  if (rule.compounds && !(subject.compound && rule.compounds.includes(subject.compound))) return false
  if (rule.keywords && !rule.keywords.some((keyword) => subject.lowerName.includes(keyword))) return false
  if (rule.dirIncludes && !rule.dirIncludes.some((part) => subject.lowerDir.includes(part))) return false
  if (rule.minSize !== undefined && subject.size < rule.minSize) return false
  if (rule.maxSize !== undefined && subject.size > rule.maxSize) return false
  return true
}

/**
 * Classify one entry.
 *
 * The caller should pass the extension resolved by numbering analysis
 * (`analyzeName`), otherwise `工具.apk（1）` would be typed from an extension
 * that reads as `apk（1）`. When `ext` is absent this falls back to a plain
 * basename parse.
 *
 * @param {{name: string, size: number, relDir?: string, ext?: string, compound?: string, extKnown?: boolean}} entry
 * @param {Array<object>} rules ordered rules, built-ins first
 * @returns {{category: string, ruleId: string, conflict: boolean, conflictCategory: string|null, conflictRuleId: string|null}}
 */
export function classify(entry, rules) {
  const info = typeof entry.ext === 'string'
    ? { ext: entry.ext, compound: entry.compound ?? '', isKnown: entry.extKnown !== false && entry.ext !== '' }
    : extOf(entry.name)
  const subject = {
    ext: info.ext,
    compound: info.compound,
    extKnown: info.isKnown,
    lowerName: String(entry.name).toLowerCase(),
    lowerDir: String(entry.relDir ?? '').toLowerCase(),
    size: Number(entry.size) || 0,
  }
  let first = null
  let conflictCategory = null
  let conflictRuleId = null
  for (const rule of rules) {
    if (!ruleMatches(rule, subject)) continue
    if (first === null) {
      first = rule
      continue
    }
    if (rule.category !== first.category) {
      conflictCategory = rule.category
      conflictRuleId = rule.id
      break
    }
  }
  if (first === null) {
    const key = info.compound || info.ext
    return {
      category: info.isKnown ? DEFAULT_CATEGORY_BY_EXT[key] ?? 'other' : 'other',
      ruleId: info.isKnown ? 'fallback-ext' : 'fallback-none',
      conflict: false,
      conflictCategory: null,
      conflictRuleId: null,
    }
  }
  return {
    category: first.category,
    ruleId: first.id,
    conflict: conflictCategory !== null,
    conflictCategory,
    conflictRuleId,
  }
}
