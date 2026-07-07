import { useEffect, useState, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../store/useAppStore'
import { getMpvUrl, saveWatchProgress, fetchIntroDbSegments } from '../api/client'
import type { IntroDbSegments, WatchProgressUpsertBody } from '../api/client'
import styles from './Player.module.css'

const HEALTH_CHECK_INTERVAL_MS = 500
const HEALTH_CHECK_TIMEOUT_MS = 3000

function mpvInstallMessage(): string {
  const p = (navigator.platform || navigator.userAgent || '').toLowerCase()
  const isWin = p.includes('win')
  const isMac = p.includes('mac')
  if (isMac) {
    return [
      'mpv no esta instalado. Instalalo con:',
      '',
      '  brew install mpv',
      '',
      'O descargalo desde https://mpv.io/installation/',
    ].join('\n')
  }
  if (isWin) {
    return [
      'mpv no esta instalado.',
      '',
      'WalacTV incluye una copia de mpv para Windows, pero no se encontro.',
      'Reinstala WalacTV o descarga mpv desde:',
      'https://mpv.io/installation/',
    ].join('\n')
  }
  return [
    'mpv no esta instalado. Instalalo con tu gestor de paquetes:',
    '',
    '  sudo apt install mpv   (Debian/Ubuntu)',
    '  sudo dnf install mpv   (Fedora)',
    '  sudo pacman -S mpv     (Arch)',
  ].join('\n')
}

function buildProgressBody(item: NonNullable<ReturnType<typeof useAppStore.getState>['playerItem']>, posMs: number, currentDurationMs: number): WatchProgressUpsertBody {
  return {
    content_type: item.kind === 'SERIES' ? 'series' : 'movie',
    position_ms: posMs,
    duration_ms: currentDurationMs > 0 ? currentDurationMs : (item.runtimeMinutes || 0) * 60000,
    series_name: item.seriesName ?? null,
    season_number: item.seasonNumber ?? null,
    episode_number: item.episodeNumber ?? null,
    title: item.tmdbTitle ?? item.title,
    image_url: item.imageUrl,
  }
}

export function Player() {
  const { playerItem: item, playerStreamIndex, playerStartPosition, closePlayer, closePlayerReason, playerErrorLog, setClosePlayerReason, setPlayerErrorLog } = useAppStore()
  const [error, setError] = useState<string | null>(null)
  const [spawned, setSpawned] = useState(false)
  const [socketPath, setSocketPath] = useState<string | null>(null)
  const [segments, setSegments] = useState<IntroDbSegments | null>(null)
  const [currentPosition, setCurrentPosition] = useState<number>(0)
  const [currentDurationMs, setCurrentDurationMs] = useState<number>(0)
  const [skipHidden, setSkipHidden] = useState<Set<string>>(new Set())
  const [streamAttempt, setStreamAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)

  const invokedRef = useRef(false)
  const healthCheckRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const positionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const skipHiddenRef = useRef(skipHidden)
  skipHiddenRef.current = skipHidden
  const positionRef = useRef(0)
  positionRef.current = currentPosition
  const currentDurationMsRef = useRef(0)
  currentDurationMsRef.current = currentDurationMs
  const itemRef = useRef(item)
  itemRef.current = item
  const streamAttemptRef = useRef(streamAttempt)
  streamAttemptRef.current = streamAttempt
  const socketPathRef = useRef(socketPath)
  socketPathRef.current = socketPath
  const spawnedRef = useRef(spawned)
  spawnedRef.current = spawned

  const streamOptions = item?.streamOptions ?? []
  const stream = streamOptions[playerStreamIndex + streamAttempt]

  // Persist on open with the resume point (or 0 for fresh).
  useEffect(() => {
    if (item && (item.kind === 'MOVIE' || item.kind === 'SERIES') && item.stableId) {
      saveWatchProgress(item.stableId, buildProgressBody(item, playerStartPosition, 0)).catch(() => {})
    }
  }, [item?.stableId, item?.kind])

  // Persist final position when the player is closed/unmounted.
  useEffect(() => {
    return () => {
      const cur = itemRef.current
      if (!cur || !cur.stableId) return
      const p = positionRef.current
      if (p <= 0) return
      saveWatchProgress(cur.stableId, buildProgressBody(cur, p, currentDurationMsRef.current)).catch(() => {})
    }
  }, [])

  // Periodic persistence every 15s while mpv is running.
  useEffect(() => {
    if (!socketPath || !spawned) return
    const id = setInterval(() => {
      const p = positionRef.current
      if (p <= 0) return
      const cur = itemRef.current
      if (!cur || !cur.stableId) return
      saveWatchProgress(cur.stableId, buildProgressBody(cur, p, currentDurationMsRef.current)).catch(() => {})
    }, 15000)
    return () => clearInterval(id)
  }, [socketPath, spawned])

  // Health check: after spawning mpv, verify it's alive within HEALTH_CHECK_TIMEOUT_MS.
  // If mpv died (404, crash), try next stream option.
  const startHealthCheck = useCallback((sp: string, attemptIdx: number) => {
    if (healthCheckRef.current) clearInterval(healthCheckRef.current)

    let polls = 0
    const maxPolls = Math.ceil(HEALTH_CHECK_TIMEOUT_MS / HEALTH_CHECK_INTERVAL_MS)

    healthCheckRef.current = setInterval(async () => {
      polls++
      try {
        await invoke<boolean>('mpv_is_alive', { socketPath: sp })
        // mpv is alive — health check passed
        if (healthCheckRef.current) {
          clearInterval(healthCheckRef.current)
          healthCheckRef.current = null
        }
        // Start normal position tracking
        setSpawned(true)
        setRetrying(false)
      } catch {
        if (polls >= maxPolls) {
          // mpv has been unresponsive for HEALTH_CHECK_TIMEOUT_MS — assume dead
          if (healthCheckRef.current) {
            clearInterval(healthCheckRef.current)
            healthCheckRef.current = null
          }
          const maxAttempts = streamOptions.length
          const nextAttempt = attemptIdx + 1
          if (nextAttempt < maxAttempts) {
            setRetrying(true)
            setStreamAttempt(nextAttempt)
            invokedRef.current = false
          } else {
            setError(`No se pudo reproducir el contenido.\nTodas las ${maxAttempts} opciones de stream fallaron.`)
          }
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS)
  }, [streamOptions.length])

  // Spawn mpv and run health check
  useEffect(() => {
    if (invokedRef.current) return
    if (!stream?.rawUrl) {
      setError('No hay stream disponible para este contenido.')
      return
    }

    // Fetch intro/outro skip segments (non-blocking)
    const hasSegments =
      item?.imdbId && item?.seasonNumber != null && item?.episodeNumber != null
    if (hasSegments && streamAttempt === 0) {
      fetchIntroDbSegments(item.imdbId!, item.seasonNumber!, item.episodeNumber!)
        .then((s) => { if (s) setSegments(s) })
        .catch(() => {})
    }

    invokedRef.current = true

    const url = getMpvUrl(stream.rawUrl)
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      invoke<string>('open_in_mpv', {
        url,
        startSeconds: playerStartPosition > 0 ? Math.floor(playerStartPosition / 1000) : undefined,
      })
        .then((sp) => {
          setSocketPath(sp)
          startHealthCheck(sp, streamAttemptRef.current)
        })
        .catch((e) => {
          const msg = String(e)
          if (msg === 'MPV_NO_BINARY') {
            setError(mpvInstallMessage())
          } else {
            setError(msg)
          }
        })
    } else {
      navigator.clipboard.writeText(url).catch(() => {})
      setError(`mpv no disponible en dev. URL copiada al portapapeles.\n\nmpv "${url}"`)
    }
  }, [stream?.rawUrl, streamAttempt])

  // Position tracking: after health check passes, poll mpv_is_running every 1s.
  // If mpv died with no prior position → error. If it had position → normal close.
  useEffect(() => {
    if (!socketPath || !spawned) return
    positionIntervalRef.current = setInterval(async () => {
      try {
        const running = await invoke<boolean>('mpv_is_running')
        if (!running) {
          clearInterval(positionIntervalRef.current!)
          positionIntervalRef.current = null
          if (positionRef.current <= 0) {
            const log = await invoke<string>('mpv_get_log').catch(() => '')
            setClosePlayerReason('error')
            setPlayerErrorLog(log || 'MPV se cerro inesperadamente.')
          } else {
            const cur = itemRef.current
            if (cur && cur.stableId && positionRef.current > 0) {
              await saveWatchProgress(cur.stableId, buildProgressBody(cur, positionRef.current, currentDurationMsRef.current)).catch(() => {})
            }
            closePlayer()
          }
          return
        }
        try {
          const pos = await invoke<number>('mpv_get_position', { socketPath })
          setCurrentPosition(pos * 1000)
          const dur = await invoke<number>('mpv_get_duration', { socketPath }).catch(() => 0)
          if (dur > 0) setCurrentDurationMs(dur * 1000)
        } catch {
          // position unavailable (buffering) — mpv is still alive, ignore
        }
      } catch {
        clearInterval(positionIntervalRef.current!)
        positionIntervalRef.current = null
        closePlayer()
      }
    }, 1000)
    return () => {
      if (positionIntervalRef.current) {
        clearInterval(positionIntervalRef.current)
        positionIntervalRef.current = null
      }
    }
  }, [socketPath, spawned])

  // Cleanup health check on unmount
  useEffect(() => {
    return () => {
      if (healthCheckRef.current) {
        clearInterval(healthCheckRef.current)
        healthCheckRef.current = null
      }
      if (positionIntervalRef.current) {
        clearInterval(positionIntervalRef.current)
        positionIntervalRef.current = null
      }
    }
  }, [])

  const hideSkip = useCallback((key: string) => {
    setSkipHidden((prev) => new Set(prev).add(key))
  }, [])

  const handleRetryPostSpawnError = useCallback(() => {
    setClosePlayerReason(null)
    setPlayerErrorLog(null)
    setStreamAttempt(0)
    invokedRef.current = false
    setSpawned(false)
    setSocketPath(null)
    setCurrentPosition(0)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); closePlayer() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!item) return null

  const skipBtn = (label: string, seekSecs: number, key: string) => {
    if (skipHidden.has(key)) return null
    return (
      <button
        className={styles.skipBtn}
        onClick={() => {
          invoke('mpv_seek', { socketPath, positionSecs: seekSecs }).catch(() => {})
          hideSkip(key)
        }}
      >
        {label}
      </button>
    )
  }

  const renderSkipButtons = () => {
    if (!segments || !socketPath || !spawned) return null
    const pos = currentPosition
    const buttons: React.ReactNode[] = []

    const segs: [string, number, string][] = []

    if (segments.intro && pos < segments.intro.endMs) {
      segs.push(['Saltar intro', segments.intro.endMs / 1000, 'intro'])
    }
    if (segments.recap && pos < segments.recap.endMs) {
      segs.push(['Saltar recapitulacion', segments.recap.endMs / 1000, 'recap'])
    }
    if (segments.outro && pos >= segments.outro.startMs) {
      segs.push(['Saltar creditos', segments.outro.startMs / 1000, 'outro'])
    }

    for (const [label, secs, key] of segs) {
      const btn = skipBtn(label, secs, key)
      if (btn) buttons.push(btn)
    }

    if (buttons.length === 0) return null
    return <div className={styles.skipContainer}>{buttons}</div>
  }

  return (
    <div className={styles.overlay} onClick={closePlayer}>
      {error ? (
        <div className={styles.errorOverlay}>
          <div style={{ whiteSpace: 'pre-wrap', textAlign: 'center', maxWidth: 600 }}>{error}</div>
          <button onClick={closePlayer} style={{ marginTop: 16, padding: '8px 24px', fontSize: 16 }}>
            Cerrar
          </button>
        </div>
      ) : closePlayerReason === 'error' ? (
        <div className={styles.errorOverlay}>
          <div style={{ textAlign: 'center', maxWidth: 600 }}>
            {playerErrorLog ? 'No se pudo reproducir este stream.' : 'El stream se interrumpio.'}
          </div>
          {playerErrorLog && (
            <div style={{ maxHeight: 200, overflow: 'auto', textAlign: 'left', fontSize: 11, opacity: 0.7, marginTop: 8, padding: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 4, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
              {playerErrorLog}
            </div>
          )}
          <div style={{ marginTop: 16, display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button onClick={closePlayer} style={{ padding: '8px 24px', fontSize: 16 }}>
              Cerrar
            </button>
            <button onClick={handleRetryPostSpawnError} style={{ padding: '8px 24px', fontSize: 16 }}>
              Reintentar
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.errorOverlay}>
          {retrying ? (
            <>
              <div>Reintentando con otra calidad...</div>
              <div style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>{item.tmdbTitle ?? item.title}</div>
              <div style={{ fontSize: 12, opacity: 0.5, marginTop: 12 }}>
                Opcion {streamAttempt + 1} de {streamOptions.length}
              </div>
            </>
          ) : spawned ? (
            <>
              <div>Reproduciendo en mpv...</div>
              <div style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>{item.tmdbTitle ?? item.title}</div>
              <div style={{ fontSize: 12, opacity: 0.5, marginTop: 12 }}>Presiona Escape para cerrar</div>
            </>
          ) : (
            <>
              <div>Abriendo en mpv...</div>
              <div style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>{item.tmdbTitle ?? item.title}</div>
              {streamAttempt > 0 && (
                <div style={{ fontSize: 12, opacity: 0.5, marginTop: 12 }}>
                  Probando opcion {streamAttempt + 1} de {streamOptions.length}
                </div>
              )}
            </>
          )}
          {renderSkipButtons()}
        </div>
      )}
    </div>
  )
}
