/**
 * Numbered-filename analysis.
 *
 * Only edge numbering is analysed: a `(n)` run at the very end of the name, or
 * at the end of the stem right before a recognised extension. Brackets and
 * digits in the middle of a name are left untouched, because they may be a
 * version, a year or part of the title.
 * @module af/naming
 */
import { extOf } from './exts.js'

/** ASCII or full-width parenthesis containing only digits, at end of string. */
const TRAILING_PAREN_NUMBER = /([（(])\s*(\d{1,6})\s*([）)])\s*$/

/**
 * Analyse one basename.
 *
 * @param {string} name basename only, never a full path
 * @returns {{
 *   name: string,
 *   ext: string,
 *   compound: string,
 *   extKnown: boolean,
 *   stem: string,
 *   number: string|null,
 *   numberForm: 'before-ext'|'after-ext'|'tail'|null,
 *   parenStyle: 'ascii'|'full'|null,
 *   spaceBeforeParen: boolean,
 *   baseName: string,
 *   canonicalName: string,
 *   keyBase: string,
 *   flags: string[]
 * }}
 */
export function analyzeName(name) {
  const out = {
    name,
    ext: '',
    compound: '',
    extKnown: false,
    stem: name,
    number: null,
    numberForm: null,
    parenStyle: null,
    spaceBeforeParen: false,
    baseName: name,
    canonicalName: name,
    keyBase: '',
    flags: [],
  }
  if (typeof name !== 'string' || name.length === 0) {
    out.keyBase = ''
    return out
  }
  out.keyBase = name.toLowerCase()

  const tail = TRAILING_PAREN_NUMBER.exec(name)
  if (tail) {
    const digits = tail[2]
    const openIndex = tail.index
    const before = name.slice(0, openIndex).replace(/\s+$/, '')
    const style = tail[1] === '（' ? 'full' : 'ascii'
    const spaced = /\s$/.test(name.slice(0, openIndex))

    if (before.length > 0) {
      const info = extOf(before)
      if (info.isKnown) {
        // `工具.apk（1）`: the number trails the extension.
        const suffixLength = (info.compound || info.ext).length + 1
        out.ext = info.ext
        out.compound = info.compound
        out.extKnown = true
        out.stem = before.slice(0, before.length - suffixLength)
        out.number = digits
        out.numberForm = 'after-ext'
        out.parenStyle = style
        out.spaceBeforeParen = spaced
        out.baseName = before
        out.canonicalName = `${out.stem} (${digits}).${info.compound || info.ext}`
        out.keyBase = out.baseName.toLowerCase()
        pushFlags(out)
        return out
      }
      // `备份(1)`: numbering on a name we cannot type.
      out.ext = info.ext
      out.extKnown = false
      out.stem = before
      out.number = digits
      out.numberForm = 'tail'
      out.parenStyle = style
      out.spaceBeforeParen = spaced
      out.baseName = before
      out.canonicalName = `${before} (${digits})`
      out.keyBase = before.toLowerCase()
      pushFlags(out)
      return out
    }
  }

  const info = extOf(name)
  out.ext = info.ext
  out.compound = info.compound
  out.extKnown = info.isKnown
  if (!info.isKnown) {
    out.stem = name
    out.keyBase = name.toLowerCase()
    return out
  }

  const suffixLength = (info.compound || info.ext).length + 1
  const stemRaw = name.slice(0, name.length - suffixLength)
  out.stem = stemRaw

  const beforeExt = TRAILING_PAREN_NUMBER.exec(stemRaw)
  if (beforeExt) {
    const digits = beforeExt[2]
    const style = beforeExt[1] === '（' ? 'full' : 'ascii'
    const spaced = /\s$/.test(stemRaw.slice(0, beforeExt.index))
    const stem = stemRaw.slice(0, beforeExt.index).replace(/\s+$/, '')
    if (stem.length > 0) {
      out.stem = stem
      out.number = digits
      out.numberForm = 'before-ext'
      out.parenStyle = style
      out.spaceBeforeParen = spaced
      out.baseName = `${stem}.${info.compound || info.ext}`
      out.canonicalName = `${stem} (${digits}).${info.compound || info.ext}`
      out.keyBase = out.baseName.toLowerCase()
      pushFlags(out)
      return out
    }
  }

  out.keyBase = name.toLowerCase()
  return out
}

function pushFlags(out) {
  const n = Number(out.number)
  if (Number.isFinite(n)) {
    if (n >= 1900 && n <= 2100) out.flags.push('number_looks_like_year')
    if (n === 0) out.flags.push('number_is_zero')
  }
  if (out.spaceBeforeParen) out.flags.push('space_before_paren')
  if (out.parenStyle === 'full') out.flags.push('fullwidth_parens')
  if (out.flags.length > 0) out.flags.push('needs_confirmation')
}

/**
 * Renaming hint for a *different-content* numbered twin.
 *
 * The number is moved in front of the extension so later sorting is stable and
 * the type stays recognisable. The caller must still check for a free name.
 */
export function suggestNormalizedName(name) {
  const info = analyzeName(name)
  if (info.number === null) return null
  if (info.canonicalName === name) return null
  return { from: name, to: info.canonicalName, numberForm: info.numberForm, flags: info.flags }
}
