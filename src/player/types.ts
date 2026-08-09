import type { CatalogItem, StreamOption as ApiStreamOption } from '../api/types'

// ── Re-export existing types ─────────────────────────────────────────
export type PlayerItem = CatalogItem
export type { ApiStreamOption as StreamOption }

// ── Player state machine ─────────────────────────────────────────────
export type PlayerState = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error'

// ── Quality ──────────────────────────────────────────────────────────
export type PlayerQuality = 'auto' | number

// ── Error ────────────────────────────────────────────────────────────
export interface PlayerError {
  kind: 'auth' | 'codec' | 'not_found' | 'network' | 'unknown' | 'unsupported_format' | 'dependency_missing' | 'platform_unsupported'
  message: string
  code?: number
  recoverable: boolean
  originalError?: unknown
  url?: string
}

// ── libmpv track types (mirror Shaka shapes for consumer compat) ────
export interface AudioTrack {
  id: number
  language: string
  label: string
  active: boolean
  roles: string[]
  external?: boolean
  externalFilename?: string
  ffIndex?: number
}

export interface SubTrack {
  id: number
  language: string
  label: string
  active: boolean
  forced: boolean
}

export interface VariantTrack {
  id: number
  height: number
  width: number
  bandwidth: number
  active: boolean
  label: string
}

// ── libmpv Tauri event types ─────────────────────────────────────────
export interface MpvTimeUpdate {
  type: 'time-update'
  position: number
  duration: number
}

export interface MpvStateChange {
  type: 'state-change'
  pause: boolean
  buffering: boolean
}

export interface MpvTracksChanged {
  type: 'tracks-changed'
}

export interface MpvEndFile {
  type: 'end-file'
  reason?: string
}

export interface MpvFileLoaded {
  type: 'file-loaded'
}

export interface MpvPlaybackRestart {
  type: 'playback-restart'
}

export interface MpvErrorEvent {
  type: 'error'
  code: number
  message: string
}

export type MpvEvent = MpvTimeUpdate | MpvStateChange | MpvTracksChanged | MpvEndFile | MpvFileLoaded | MpvPlaybackRestart | MpvErrorEvent
