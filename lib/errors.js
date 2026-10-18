/** Stable error codes and the plugin's single error type. @module af/errors */

export const CODE = Object.freeze({
  CONFIG: 'AF_CONFIG',
  ROOT_NOT_ALLOWED: 'AF_ROOT_NOT_ALLOWED',
  ROOT_MISSING: 'AF_ROOT_MISSING',
  ROOT_NOT_DIR: 'AF_ROOT_NOT_DIR',
  ROOT_CHANGED: 'AF_ROOT_CHANGED',
  PATH_DENIED: 'AF_PATH_DENIED',
  PATH_OUTSIDE: 'AF_PATH_OUTSIDE',
  NO_SCAN: 'AF_NO_SCAN',
  SCAN_NOT_FOUND: 'AF_SCAN_NOT_FOUND',
  BUSY: 'AF_BUSY',
  ABORTED: 'AF_ABORTED',
  LIMIT: 'AF_LIMIT_INVALID',
  DB: 'AF_DB',
  IO: 'AF_IO',
  UNSUPPORTED: 'AF_UNSUPPORTED',
})

export class AfError extends Error {
  /**
   * @param {string} code one of {@link CODE}
   * @param {string} message human readable, never contains file contents
   * @param {object} [extra] structured details merged onto the error
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'AfError'
    this.code = code
    this.details = extra
  }
}

/** Normalize any thrown value into a flat, log-safe shape. */
export function errorInfo(err) {
  if (err instanceof AfError) {
    return { code: err.code, message: err.message, details: err.details }
  }
  const code = typeof err?.code === 'string' ? err.code : undefined
  return { code: code ?? CODE.IO, message: String(err?.message ?? err), details: {} }
}

/** Abort-aware assertion used before every filesystem side step. */
export function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw new AfError(CODE.ABORTED, 'operation cancelled by caller')
  }
}
