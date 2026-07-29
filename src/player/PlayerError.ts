import type { PlayerError } from './types'

/**
 * Map an mpv/Tauri error to our PlayerError taxonomy.
 */
export function classifyMpvError(error: unknown): PlayerError {
  const message = String(error ?? 'Unknown error')

  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>

    if (e.code === 401 || e.code === 403) {
      return {
        kind: 'auth',
        message: message || 'Authentication failed',
        recoverable: false,
        originalError: error,
      }
    }

    if (e.code === 404) {
      return {
        kind: 'not_found',
        message: message || 'Content not found',
        recoverable: true,
        originalError: error,
      }
    }

    // Network-related HTTP errors
    if (typeof e.code === 'number' && e.code >= 100 && e.code < 600) {
      return {
        kind: 'network',
        message: message || `HTTP error ${e.code}`,
        recoverable: true,
        originalError: error,
      }
    }
  }

  // Check for Wayland/platform unsupported (before general unknown)
  const lower = message.toLowerCase()
  if (lower.includes('wayland') || lower.includes('gdk_backend')) {
    return {
      kind: 'platform_unsupported',
      message,
      recoverable: false,
      originalError: error,
    }
  }

  // Check for libmpv dependency missing (shared library not found)
  if (
    lower.includes('libmpv') ||
    lower.includes('library not found') ||
    lower.includes('shared object') ||
    lower.includes('cannot open shared object') ||
    lower.includes('no se pudo cargar libmpv') ||
    lower.includes('dependency_missing') ||
    lower.includes('mpv error')
  ) {
    return {
      kind: 'dependency_missing',
      message,
      // Recoverable on Linux (auto-install is available), not on other platforms
      recoverable: true,
      originalError: error,
    }
  }

  // Check for codec/format indicators in the error message
  if (
    lower.includes('codec') ||
    lower.includes('not supported') ||
    lower.includes('unsupported') ||
    lower.includes('format')
  ) {
    return {
      kind: 'codec',
      message,
      recoverable: false,
      originalError: error,
    }
  }

  return {
    kind: 'unknown',
    message,
    recoverable: false,
    originalError: error,
  }
}

// ── Helper predicates ────────────────────────────────────────────────

export function isAuthError(error: PlayerError): boolean {
  return error.kind === 'auth'
}

export function isRecoverable(error: PlayerError): boolean {
  return error.recoverable
}

export function isContentNotFound(error: PlayerError): boolean {
  return error.kind === 'not_found'
}
