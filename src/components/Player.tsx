import { useEffect, useState, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '../store/useAppStore'
import { getMpvUrl, saveWatchProgress } from '../api/client'
import styles from './Player.module.css'

// ponytail: mpv handles everything — HLS, MKV, MP4, hardware accel, subtitles, OSD
// No <video>, no hls.js, no custom controls needed

type Platform = 'windows' | 'linux' | 'macos' | 'unknown'

function detectPlatform(): Platform {
  const p = (navigator.platform || '').toLowerCase()
  if (p.startsWith('win')) return 'windows'
  if (p.startsWith('mac')) return 'macos'
  if (p.startsWith('linux')) return 'linux'
  const ua = (navigator.userAgent || '').toLowerCase()
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('mac')) return 'macos'
  if (ua.includes('linux')) return 'linux'
  return 'unknown'
}

function mpvInstallMessage(): string {
  switch (detectPlatform()) {
    case 'linux':
      return [
        'mpv no esta instalado. Instalalo con tu gestor de paquetes:',
        '',
        '  Ubuntu/Debian:  sudo apt install mpv',
        '  Fedora:         sudo dnf install mpv',
        '  Arch:           sudo pacman -S mpv',
        '',
        'O descargalo desde https://mpv.io/installation/',
      ].join('\n')
    case 'macos':
      return [
        'mpv no esta instalado. Instalalo con:',
        '',
        '  brew install mpv',
        '',
        'O descargalo desde https://mpv.io/installation/',
      ].join('\n')
    default:
      return [
        'mpv no esta instalado.',
        '',
        'WalacTV incluye una copia de mpv para Windows, pero no se encontro.',
        'Reinstala WalacTV o descarga mpv desde:',
        'https://mpv.io/installation/',
        '',
        'Asegurate de anadir mpv al PATH o colocar mpv.exe en el directorio de instalacion.',
      ].join('\n')
  }
}

export function Player() {
  const { playerItem: item, playerStreamIndex, playerStartPosition, closePlayer } = useAppStore()
  const [error, setError] = useState<string | null>(null)
  const [spawned, setSpawned] = useState(false)
  const invokedRef = useRef(false)

  const stream = item?.streamOptions?.[playerStreamIndex]

  // ponytail: save start-only progress — real tracking needs mpv IPC
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
    const url = getMpvUrl(stream.rawUrl)

    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      invoke('open_in_mpv', { url, startSeconds: playerStartPosition > 0 ? Math.floor(playerStartPosition / 1000) : undefined })
        .then(() => setSpawned(true))
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); closePlayer() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!item) return null

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
        </div>
      )}
    </div>
  )
}
