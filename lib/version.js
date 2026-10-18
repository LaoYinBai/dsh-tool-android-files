/**
 * The version of the package that is actually loaded.
 *
 * Read from `package.json` beside the installed module so a packed tarball, a
 * git checkout and a linked directory all report the same truth without a
 * hand-maintained constant.
 * @module af/version
 */
import { readFileSync } from 'node:fs'

function readVersion() {
  try {
    const url = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(url, 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export const PLUGIN_VERSION = readVersion()
export const PLUGIN_NAME = '@laoyinbai/dsh-tool-android-files'
