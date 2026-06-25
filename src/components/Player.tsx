import { useEffect, useState, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../store/useAppStore'
import { getMpvUrl, saveWatchProgress, fetchIntroDbSegments } from '../api/client'
import type { IntroDbSegments } from '../api/client'
import styles from './Player.module.css'

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

export function Player() {
  const { playerItem: item, playerStreamIndex, playerStartPosition, closePlayer } = useAppStore()
  const [error, setError] = useState<string | null>(null)
  const [spawned, setSpawned] = useState(false)
  const [socketPath, setSocketPath] = useState<string | null>(null)
  const [segments, setSegments] = useState<IntroDbSegments | null>(null)
  const [currentPosition, setCurrentPosition] = useState<number>(0)
  const [skipHidden, setSkipHidden] = useState<Set<string>>(new Set())

  const invokedRef = useRef(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const skipHiddenRef = useRef(skipHidden)
  skipHiddenRef.current = skipHidden

  const stream = item?.streamOptions?.[playerStreamIndex]

  useEffect(() => {
    if (item && (item.kind === 'MOVIE' || item.kind === 'SERIES') && item.stableId) {
      saveWatchProgress(item.stableId, {
        position_ms: 0,
        duration_ms: (item.runtimeMinutes || 0) * 60000,
      }).catch(() => {})
    }
  }, [item?.stableId, item?.kind])

  useEffect(() => {
    if (invokedRef.current) return
    invokedRef.current = true

    if (!stream?.rawUrl) {
      setError('No hay stream disponible para este contenido.')
      return
    }

    const hasSegments =
      item?.imdbId && item?.seasonNumber != null && item?.episodeNumber != null
    if (hasSegments) {
      fetchIntroDbSegments(item.imdbId!, item.seasonNumber!, item.episodeNumber!)
        .then((s) => {
          if (s) setSegments(s)
        })
        .catch(() => {})
    }

    const url = getMpvUrl(stream.rawUrl)
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      invoke<string>('open_in_mpv', {
        url,
        startSeconds: playerStartPosition > 0 ? Math.floor(playerStartPosition / 1000) : undefined,
      })
        .then((sp) => {
          setSocketPath(sp)
          setSpawned(true)
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
  }, [stream?.rawUrl])

  const hideSkip = useCallback((key: string) => {
    setSkipHidden((prev) => new Set(prev).add(key))
  }, [])

  useEffect(() => {
    if (!socketPath || !spawned) return
    intervalRef.current = setInterval(async () => {
      try {
        const pos = await invoke<number>('mpv_get_position', { socketPath })
        setCurrentPosition(pos * 1000)
      } catch {
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
      }
    }, 500)
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [socketPath, spawned])

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
      ) : (
        <div className={styles.errorOverlay}>
          {spawned ? (
            <>
              <div>Reproduciendo en mpv...</div>
              <div style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>{item.tmdbTitle ?? item.title}</div>
              <div style={{ fontSize: 12, opacity: 0.5, marginTop: 12 }}>Presiona Escape para cerrar</div>
            </>
          ) : (
            <>
              <div>Abriendo en mpv...</div>
              <div style={{ fontSize: 14, opacity: 0.7, marginTop: 8 }}>{item.tmdbTitle ?? item.title}</div>
            </>
          )}
          {renderSkipButtons()}
        </div>
      )}
    </div>
  )
}
