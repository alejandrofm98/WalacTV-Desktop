import { useEffect, useRef, useState, useCallback } from 'react'

const INACTIVITY_TIMEOUT_MS = 3000

interface UsePlayerControlsOptions {
  onSeek?: (seconds: number) => void
  onTogglePlay?: () => void
  onVolumeUp?: () => void
  onVolumeDown?: () => void
  onMute?: () => void
  onFullscreen?: () => void
  onPip?: () => void
}

interface UsePlayerControlsReturn {
  controlsVisible: boolean
  show: () => void
}

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart'] as const

/**
 * Manages auto-hide behavior for player controls overlay.
 * Shows controls on user activity, hides after INACTIVITY_TIMEOUT_MS of inactivity.
 * Also binds keyboard shortcuts for common playback actions.
 */
export function usePlayerControls({
  onSeek,
  onTogglePlay,
  onVolumeUp,
  onVolumeDown,
  onMute,
  onFullscreen,
  onPip,
}: UsePlayerControlsOptions = {}): UsePlayerControlsReturn {
  const [controlsVisible, setControlsVisible] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    setControlsVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setControlsVisible(false)
    }, INACTIVITY_TIMEOUT_MS)
  }, [])

  // Reset inactivity timer on user activity
  useEffect(() => {
    const handleActivity = () => show()
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, handleActivity)
    }
    // Initial show
    show()

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, handleActivity)
      }
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [show])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          onTogglePlay?.()
          break
        case 'ArrowLeft':
          e.preventDefault()
          onSeek?.(-10)
          break
        case 'ArrowRight':
          e.preventDefault()
          onSeek?.(10)
          break
        case 'ArrowUp':
          e.preventDefault()
          onVolumeUp?.()
          break
        case 'ArrowDown':
          e.preventDefault()
          onVolumeDown?.()
          break
        case 'm':
        case 'M':
          e.preventDefault()
          onMute?.()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          onFullscreen?.()
          break
        case 'p':
        case 'P':
          e.preventDefault()
          onPip?.()
          break
        case 'Escape':
          e.preventDefault()
          // Fullscreen exit is handled by the browser natively,
          // the component handles closing via its own Escape handler
          break
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onTogglePlay, onSeek, onVolumeUp, onVolumeDown, onMute, onFullscreen, onPip])

  return { controlsVisible, show }
}
