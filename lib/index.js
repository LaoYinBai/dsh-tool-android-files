/**
 * @laoyinbai/dsh-tool-android-files
 *
 * Cordis plugin entry. Registers read-only file-indexing tools for DeepSeek
 * Harness on Android. No configuration schema is exported on purpose: a bad
 * optional field must not stop `apply()` from running and silently remove every
 * tool, so configuration is normalized in `lib/config.js` and reported through
 * `af_backend` instead.
 * @module @laoyinbai/dsh-tool-android-files
 */
import { normalizeConfig } from './config.js'
import { registerTools } from './tools.js'

export const name = 'tool-android-files'

/** The tool registry is the only service this plugin needs. */
export const inject = ['tools']

/**
 * @param {object} ctx Cordis context
 * @param {object} [config] the `config:` block of the patch entry
 */
export function apply(ctx, config) {
  const normalized = normalizeConfig(config)
  const state = {
    config: normalized,
    store: null,
    storePromise: null,
    scanning: false,
  }

  if (normalized.problems.length > 0) {
    const message = `android-files config problems: ${normalized.problems.join('; ')}`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }

  const disposers = registerTools(ctx, state)

  return () => {
    try {
      state.store?.raw?.close?.()
    } catch {
      /* closing an already-closed handle is not actionable */
    }
    state.store = null
    for (const dispose of disposers) {
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          /* a disposer that already ran must not block the rest */
        }
      }
    }
  }
}
