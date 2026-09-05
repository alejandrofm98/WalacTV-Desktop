import { create } from 'zustand'
import type { PlayerError, PlayerQuality, TorrentOverlayInfo, TorrentStats } from './types'

interface PlayerState {
  currentItemId: string | null
  isPlaying: boolean
  isBuffering: boolean
  volume: number
  isMuted: boolean
  isFullscreen: boolean
  isPip: boolean
  error: PlayerError | null
  streamLabel: string | null
  isOpening: boolean
  quality: PlayerQuality
  torrentInfo: TorrentOverlayInfo | null
  torrentStats: TorrentStats | null
}

interface PlayerActions {
  setCurrentItem: (id: string | null) => void
  setPlaying: (v: boolean) => void
  setBuffering: (v: boolean) => void
  setVolume: (v: number) => void
  setMuted: (v: boolean) => void
  setFullscreen: (v: boolean) => void
  setPip: (v: boolean) => void
  setError: (e: PlayerError | null) => void
  clearError: () => void
  setStreamLabel: (label: string | null) => void
  setOpening: (v: boolean) => void
  setQuality: (q: PlayerQuality) => void
  setTorrentInfo: (info: TorrentOverlayInfo | null) => void
  setTorrentStats: (stats: TorrentStats | null) => void
  reset: () => void
}

export type PlayerStore = PlayerState & PlayerActions

const initial: PlayerState = {
  currentItemId: null,
  isPlaying: false,
  isBuffering: false,
  volume: 1,
  isMuted: false,
  isFullscreen: false,
  isPip: false,
  error: null,
  streamLabel: null,
  isOpening: false,
  quality: 'auto',
  torrentInfo: null,
  torrentStats: null,
}

export const usePlayerStore = create<PlayerStore>()((set) => ({
  ...initial,

  setCurrentItem: (currentItemId) => set({ currentItemId }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setBuffering: (isBuffering) => set({ isBuffering }),
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
  setMuted: (isMuted) => set({ isMuted }),
  setFullscreen: (isFullscreen) => set({ isFullscreen }),
  setPip: (isPip) => set({ isPip }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  setStreamLabel: (streamLabel) => set({ streamLabel }),
  setOpening: (isOpening) => set({ isOpening }),
  setQuality: (quality) => set({ quality }),
  setTorrentInfo: (torrentInfo) => set({ torrentInfo }),
  setTorrentStats: (torrentStats) => set({ torrentStats }),
  reset: () => set({ ...initial }),
}))

// ── Granular selectors ───────────────────────────────────────────────
export const selectCurrentItemId = (s: PlayerStore) => s.currentItemId
export const selectIsPlaying = (s: PlayerStore) => s.isPlaying
export const selectIsBuffering = (s: PlayerStore) => s.isBuffering
export const selectVolume = (s: PlayerStore) => s.volume
export const selectIsMuted = (s: PlayerStore) => s.isMuted
export const selectIsFullscreen = (s: PlayerStore) => s.isFullscreen
export const selectIsPip = (s: PlayerStore) => s.isPip
export const selectError = (s: PlayerStore) => s.error
export const selectStreamLabel = (s: PlayerStore) => s.streamLabel
export const selectIsOpening = (s: PlayerStore) => s.isOpening
export const selectQuality = (s: PlayerStore) => s.quality
export const selectTorrentInfo = (s: PlayerStore) => s.torrentInfo
export const selectTorrentStats = (s: PlayerStore) => s.torrentStats
