import { useEffect, useCallback, useRef, useState } from 'react'
import { PlayerService, playerService } from './PlayerService'
import { usePlayerStore } from './usePlayerStore'
import type { PlayerState, PlayerError } from './types'

interface UsePlayerReturn {
  service: PlayerService
  state: PlayerState
  error: PlayerError | null
}

/**
 * Main hook that connects the PlayerService singleton with React.
 * Provides reactive state and error while the component is mounted.
 * Subscribes to service events and syncs with usePlayerStore.
 */
export function usePlayer(): UsePlayerReturn {
  const error = usePlayerStore((s) => s.error)
  const [state, setState] = useState<PlayerState>('idle')
  const listenerAttached = useRef(false)

  useEffect(() => {
    const svc = playerService

    const onState = (e: Event) => {
      setState((e as CustomEvent).detail as PlayerState)
    }
    const onError = (e: Event) => {
      const err = (e as CustomEvent).detail as PlayerError
      if (err.kind !== 'unknown' || err.message !== 'Load interrupted') {
        console.error('[usePlayer] error:', err)
      }
    }

    svc.addEventListener('state', onState)
    svc.addEventListener('error', onError)
    listenerAttached.current = true

    return () => {
      svc.removeEventListener('state', onState)
      svc.removeEventListener('error', onError)
    }
  }, [])

  return {
    service: playerService,
    state,
    error,
  }
}

/**
 * Convenience hook to access the service singleton directly.
 */
export function usePlayerService(): PlayerService {
  return playerService
}
