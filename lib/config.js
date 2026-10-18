/**
 * Plugin configuration normalization.
 *
 * Deliberately hand-rolled instead of a Schemastery schema: this package must
 * load on a device where it cannot be debugged interactively, and a malformed
 * optional field should degrade one rule rather than prevent `apply()` from
 * running and remove every tool from the session.
 * @module af/config
 */
import path from 'node:path'
import os from 'node:os'

export const PLUGIN_ID = 'dsh-tool-android-files'
export const MAX_ENTRIES_CAP = 200_000
export const MAX_ENTRIES_DEFAULT = 5_000

/** Resolve the plugin data directory without depending on any peer package. */
export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured)
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    return path.join(path.resolve(dshHome), 'plugin-data', PLUGIN_ID)
  }
  return path.join(os.homedir(), '.dsh', 'plugin-data', PLUGIN_ID)
}

function normalizeDir(value, label, problems) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${label} must be a non-empty absolute path when set`)
    return ''
  }
  if (!path.isAbsolute(value)) {
    problems.push(`${label} must be absolute: ${value}`)
    return ''
  }
  return path.resolve(value)
}

function stringArray(value, label, problems) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array of strings`)
    return []
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      problems.push(`${label} contains a non-string entry`)
      continue
    }
    out.push(item)
  }
  return out
}

/**
 * @param {unknown} raw config object supplied by the Cordis patch
 */
export function normalizeConfig(raw) {
  const problems = []
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && config !== raw) problems.push('config must be an object')

  const roots = []
  const seen = new Set()
  for (const entry of stringArray(config.roots, 'roots', problems)) {
    if (!path.isAbsolute(entry)) {
      problems.push(`roots entry must be absolute: ${entry}`)
      continue
    }
    const resolved = path.resolve(entry)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    roots.push(resolved)
  }

  let maxEntries = MAX_ENTRIES_DEFAULT
  if (config.maxEntries !== undefined) {
    if (typeof config.maxEntries !== 'number' || !Number.isFinite(config.maxEntries) || config.maxEntries < 1) {
      problems.push('maxEntries must be a positive number')
    } else {
      maxEntries = Math.min(Math.floor(config.maxEntries), MAX_ENTRIES_CAP)
    }
  }

  let includeSubdirs = true
  if (config.includeSubdirs !== undefined) {
    if (typeof config.includeSubdirs !== 'boolean') problems.push('includeSubdirs must be a boolean')
    else includeSubdirs = config.includeSubdirs
  }

  if (config.enableWrite === true) {
    problems.push('enableWrite is reserved for M2; this build never writes user files and ignores it')
  }

  return {
    roots,
    dataDir: resolveDataDir(config.dataDir),
    maxEntries,
    includeSubdirs,
    excludeNames: stringArray(config.excludeNames, 'excludeNames', problems),
    excludeExts: stringArray(config.excludeExts, 'excludeExts', problems).map((ext) =>
      ext.replace(/^\./, '').toLowerCase(),
    ),
    excludePatterns: stringArray(config.excludePatterns, 'excludePatterns', problems),
    probeDir: normalizeDir(config.probeDir, 'probeDir', problems),
    quarantineDir: normalizeDir(config.quarantineDir, 'quarantineDir', problems),
    rules: Array.isArray(config.rules) ? config.rules : [],
    problems,
  }
}
