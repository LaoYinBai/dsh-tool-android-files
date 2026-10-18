/** Extension knowledge shared by naming analysis and classification. @module af/exts */

export const CATEGORIES = Object.freeze([
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'installer',
  'other',
])

const TABLE = {
  image: [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif',
    'tif', 'tiff', 'svg', 'dng', 'cr2', 'nef', 'arw', 'raf', 'orf', 'srw',
  ],
  video: [
    'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', '3g2',
    'ts', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'rmvb',
  ],
  audio: [
    'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'amr',
    'ape', 'aiff', 'aif', 'mid', 'midi',
  ],
  document: [
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md',
    'markdown', 'csv', 'tsv', 'rtf', 'odt', 'ods', 'odp', 'epub', 'mobi',
    'azw', 'azw3', 'fb2', 'html', 'htm', 'xml', 'json', 'jsonl', 'yaml',
    'yml', 'toml', 'ini', 'log', 'tex',
  ],
  archive: [
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'tgz', 'tbz2',
    'txz', 'iso', 'cab', 'lz', 'lzma', 'z',
  ],
  installer: [
    'apk', 'apks', 'xapk', 'aab', 'ipa', 'exe', 'msi', 'dmg', 'pkg', 'deb',
    'rpm', 'appimage',
  ],
}

/** Multi-dot suffixes that must win over their last component. */
export const COMPOUND_EXTS = Object.freeze([
  'tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', 'tar.lz',
])

/** lowercase extension (without dot) -> default category */
export const DEFAULT_CATEGORY_BY_EXT = (() => {
  /** @type {Record<string, string>} */
  const map = {}
  for (const category of CATEGORIES) {
    for (const ext of TABLE[category] ?? []) map[ext] = category
  }
  for (const compound of COMPOUND_EXTS) map[compound] = 'archive'
  return map
})()

/**
 * Inspect a basename for its extension.
 *
 * Returns the compound suffix when one matches, the plain suffix otherwise,
 * and whether either is a recognised type. A dotfile such as `.nomedia` has no
 * extension, and a trailing dot is not an extension either.
 */
export function extOf(name) {
  if (typeof name !== 'string' || name === '') {
    return { ext: '', compound: '', subject: '', isKnown: false, category: 'other' }
  }
  const lower = name.toLowerCase()
  for (const compound of COMPOUND_EXTS) {
    const suffix = '.' + compound
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      return {
        ext: compound.slice(compound.lastIndexOf('.') + 1),
        compound,
        subject: name.slice(0, name.length - suffix.length),
        isKnown: true,
        category: DEFAULT_CATEGORY_BY_EXT[compound] ?? 'other',
      }
    }
  }
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) {
    return { ext: '', compound: '', subject: name, isKnown: false, category: 'other' }
  }
  const raw = name.slice(dot + 1)
  // A slash can never appear in a basename, but guard against callers passing
  // path-like strings so the result is never silently reinterpreted.
  if (raw.includes('/') || raw.includes('\\')) {
    return { ext: '', compound: '', subject: name, isKnown: false, category: 'other' }
  }
  const ext = raw.toLowerCase()
  const category = DEFAULT_CATEGORY_BY_EXT[ext]
  return {
    ext,
    compound: '',
    subject: name.slice(0, dot),
    isKnown: category !== undefined,
    category: category ?? 'other',
  }
}
