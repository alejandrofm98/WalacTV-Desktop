import { usePlayerStore } from './usePlayerStore'
import type { PlayerStore } from './usePlayerStore'

/**
 * Granular selectors for usePlayerStore.
 * Each selector extracts a single value to prevent unnecessary re-renders.
 */

export function usePlayerItemId(): PlayerStore['currentItemId'] {
  return usePlayerStore((s) => s.currentItemId)
}

export function usePlayerIsPlaying(): PlayerStore['isPlaying'] {
  return usePlayerStore((s) => s.isPlaying)
}

export function usePlayerIsBuffering(): PlayerStore['isBuffering'] {
  return usePlayerStore((s) => s.isBuffering)
}

export function usePlayerVolume(): PlayerStore['volume'] {
  return usePlayerStore((s) => s.volume)
}

export function usePlayerIsMuted(): PlayerStore['isMuted'] {
  return usePlayerStore((s) => s.isMuted)
}

export function usePlayerIsFullscreen(): PlayerStore['isFullscreen'] {
  return usePlayerStore((s) => s.isFullscreen)
}

export function usePlayerIsPip(): PlayerStore['isPip'] {
  return usePlayerStore((s) => s.isPip)
}

export function usePlayerError(): PlayerStore['error'] {
  return usePlayerStore((s) => s.error)
}

export function usePlayerStreamLabel(): PlayerStore['streamLabel'] {
  return usePlayerStore((s) => s.streamLabel)
}

export function usePlayerIsOpening(): PlayerStore['isOpening'] {
  return usePlayerStore((s) => s.isOpening)
}

export function usePlayerQuality(): PlayerStore['quality'] {
  return usePlayerStore((s) => s.quality)
}
