import { useEffect, useRef, useState, useCallback } from 'react'
import { fetchIntroDbSegments } from '../api/client'
import type { IntroDbSegments } from '../api/client'
import type { PlayerItem } from './types'

type SegmentType = 'intro' | 'recap' | 'outro'

interface ActiveSegment {
  type: SegmentType
  endTime: number
}

interface UseIntroSkipOptions {
  item: PlayerItem | null
  getCurrentTime: () => number
  onSkip?: (seconds: number) => void
}

interface UseIntroSkipReturn {
  activeSegment: ActiveSegment | null
  dismiss: (type: string) => void
  skip: () => void
}

/**
 * Fetches IntroDB segments for the current episode and returns
 * active skip-able segments based on current playback position.
 *
 * Mirrors the old skip detection code from the MPV era,
 * now using an onSkip callback instead of invoke calls.
 */
export function useIntroSkip({
  item,
  getCurrentTime,
  onSkip,
}: UseIntroSkipOptions): UseIntroSkipReturn {
  const [segments, setSegments] = useState<IntroDbSegments | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const segmentsRef = useRef(segments)
  segmentsRef.current = segments
  const dismissedRef = useRef(dismissed)
  dismissedRef.current = dismissed

  // Only fetch for series episodes with imdbId
  const hasSegments =
    item?.kind === 'SERIES' &&
    item?.imdbId != null &&
    item?.seasonNumber != null &&
    item?.episodeNumber != null

  useEffect(() => {
    if (!hasSegments) {
      setSegments(null)
      setDismissed(new Set())
      return
    }

    let cancelled = false
    fetchIntroDbSegments(item.imdbId!, item.seasonNumber!, item.episodeNumber!)
      .then((s) => {
        if (!cancelled && s) setSegments(s)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [hasSegments, item?.imdbId, item?.seasonNumber, item?.episodeNumber])

  // Determine which segment is currently active based on position
  const activeSegment = ((): ActiveSegment | null => {
    if (!segments) return null
    const pos = getCurrentTime()

    for (const [type, seg] of [
      ['intro', segments.intro] as const,
      ['recap', segments.recap] as const,
    ]) {
      if (seg && pos < seg.endMs / 1000 && !dismissed.has(type)) {
        return { type, endTime: seg.endMs / 1000 }
      }
    }

    if (
      segments.outro &&
      pos >= segments.outro.startMs / 1000 &&
      !dismissed.has('outro')
    ) {
      return { type: 'outro', endTime: segments.outro.startMs / 1000 }
    }

    return null
  })()

  const dismiss = useCallback((type: string) => {
    setDismissed((prev) => new Set(prev).add(type))
  }, [])

  const skip = useCallback(() => {
    if (!activeSegment) return
    onSkip?.(activeSegment.endTime)
    dismiss(activeSegment.type)
  }, [activeSegment, onSkip, dismiss])

  return { activeSegment, dismiss, skip }
}
