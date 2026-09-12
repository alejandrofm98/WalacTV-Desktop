import { useEffect, useRef, useCallback } from 'react'
import { saveWatchProgress, displayTitleOf } from '../api/client'
import type { WatchProgressUpsertBody } from '../api/client'
import type { PlayerItem } from './types'

const SAVE_INTERVAL_MS = 15000
const MIN_SAVE_GAP_MS = 5000

interface UsePlayerProgressOptions {
  item: PlayerItem | null
  getCurrentTime: () => number
  getDuration: () => number
  isPlaying: boolean
}

/**
 * Periodically persists watch progress to the API every 15 seconds
 * while content is playing. Saves immediately on unmount or pause.
 *
 * Mirrors the pattern from the old MPV-based Player.tsx but uses
 * the Shaka service's time methods instead of invoke() calls.
 */
export function usePlayerProgress({
  item,
  getCurrentTime,
  getDuration,
  isPlaying,
}: UsePlayerProgressOptions): void {
  const lastSaveRef = useRef(0)
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying

  // Refs vivas para evitar closures obsoletos al hacer zapping/cambiar de item.
  const itemRef = useRef(item)
  itemRef.current = item
  const getCurrentTimeRef = useRef(getCurrentTime)
  getCurrentTimeRef.current = getCurrentTime
  const getDurationRef = useRef(getDuration)
  getDurationRef.current = getDuration

  // Build the progress body from the current item and position
  const buildBody = useCallback((posMs: number, durMs: number): WatchProgressUpsertBody | null => {
    const cur = itemRef.current
    if (!cur || !cur.stableId) return null
    if (cur.kind !== 'MOVIE' && cur.kind !== 'SERIES') return null
    const rawDuration = durMs > 0 ? durMs : (cur.runtimeMinutes || 0) * 60000
    return {
      content_type: cur.kind === 'SERIES' ? 'series' : 'movie',
      position_ms: posMs,
      duration_ms: rawDuration > 0 ? rawDuration : 30 * 60_000,
      series_name: cur.seriesName ?? null,
      season_number: cur.seasonNumber ?? null,
      episode_number: cur.episodeNumber ?? null,
      title: displayTitleOf(cur),
      image_url: cur.imageUrl,
    }
  }, [])

  // Periodic save while playing
  useEffect(() => {
    if (!item || !item.stableId || !isPlaying) return

    const id = setInterval(() => {
      const posMs = Math.round(getCurrentTime() * 1000)
      if (posMs <= 0) return
      const durMs = Math.round(getDuration() * 1000)
      const body = buildBody(posMs, durMs)
      if (!body) return

      saveWatchProgress(item.stableId, body).catch(() => {})
      lastSaveRef.current = Date.now()
    }, SAVE_INTERVAL_MS)

    return () => clearInterval(id)
  }, [item?.stableId, isPlaying, getCurrentTime, getDuration, buildBody])

  // Save on pause (if enough time since last save)
  useEffect(() => {
    if (isPlaying) return
    if (!item || !item.stableId) return

    const now = Date.now()
    if (now - lastSaveRef.current < MIN_SAVE_GAP_MS) return

    const posMs = Math.round(getCurrentTime() * 1000)
    if (posMs <= 0) return
    const durMs = Math.round(getDuration() * 1000)
    const body = buildBody(posMs, durMs)
    if (!body) return

    saveWatchProgress(item.stableId, body).catch(() => {})
    lastSaveRef.current = now
  }, [isPlaying, item, getCurrentTime, getDuration, buildBody])

  // Save on unmount (cleanup)
  useEffect(() => {
    return () => {
      const cur = itemRef.current
      if (!cur || !cur.stableId) return
      const posMs = Math.round(getCurrentTimeRef.current() * 1000)
      if (posMs <= 0) return
      const durMs = Math.round(getDurationRef.current() * 1000)
      const body = buildBody(posMs, durMs)
      if (!body) return
      saveWatchProgress(cur.stableId, body).catch(() => {})
    }
  }, [buildBody])
}
