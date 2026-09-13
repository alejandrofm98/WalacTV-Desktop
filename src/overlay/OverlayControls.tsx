import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Maximize,
  Pause,
  Play,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { sendOverlayCtl, overlayTransport } from './useOverlayState'
import type { OverlayPlaybackState } from './useOverlayState'
import styles from './OverlayApp.module.css'

const INACTIVITY_TIMEOUT_MS = 3000

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

interface OverlayControlsProps {
  state: OverlayPlaybackState
}

/**
 * Controles HTML sobre el video nativo (ventana overlay, Windows wid).
 * Espejo del estado via eventos; acciones por invoke directo (transporte)
 * o overlay://ctl (nivel app). Auto-oculta a los 3s de inactividad.
 */
export function OverlayControls({ state }: OverlayControlsProps) {
  const { item, isPlaying, isBuffering, time, duration, estFps, volume, muted } = state
  const isLive = item?.kind === 'CHANNEL' || item?.kind === 'EVENT'
  const [visible, setVisible] = useState(true)
  const [dragFraction, setDragFraction] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)

  const show = useCallback(() => {
    setVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setVisible(false), INACTIVITY_TIMEOUT_MS)
  }, [])

  // Forzados visibles mientras carga o esta en pausa.
  useEffect(() => {
    if (!isPlaying || isBuffering) {
      show()
    }
  }, [isPlaying, isBuffering, show])

  useEffect(() => {
    const events = ['mousemove', 'keydown', 'click', 'wheel'] as const
    for (const evt of events) window.addEventListener(evt, show)
    show()
    return () => {
      for (const evt of events) window.removeEventListener(evt, show)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [show])

  // Teclado espejo de usePlayerControls (estilo TV en directo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault()
          overlayTransport.setPaused(isPlaying)
          break
        case 'ArrowLeft':
          e.preventDefault()
          if (isLive) overlayTransport.setVolume(volume - 0.1)
          else overlayTransport.seekAbs(Math.max(0, time - 10))
          break
        case 'ArrowRight':
          e.preventDefault()
          if (isLive) overlayTransport.setVolume(volume + 0.1)
          else overlayTransport.seekAbs(time + 10)
          break
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault()
          if (isLive) sendOverlayCtl({ action: 'zap', dir: -1 })
          else overlayTransport.setVolume(volume + 0.1)
          break
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault()
          if (isLive) sendOverlayCtl({ action: 'zap', dir: 1 })
          else overlayTransport.setVolume(volume - 0.1)
          break
        case 'm':
        case 'M':
          e.preventDefault()
          overlayTransport.setMuted(!muted)
          break
        case 'f':
        case 'F':
          e.preventDefault()
          sendOverlayCtl({ action: 'fullscreen' })
          break
        case 'Escape':
          e.preventDefault()
          sendOverlayCtl({ action: 'escape' })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPlaying, isLive, volume, muted, time])

  const fractionFromClientX = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }, [])

  const onSeekDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragFraction(fractionFromClientX(e.clientX))
    },
    [fractionFromClientX],
  )

  const onSeekMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragFraction != null) setDragFraction(fractionFromClientX(e.clientX))
    },
    [dragFraction, fractionFromClientX],
  )

  const onSeekUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragFraction == null) return
      const frac = fractionFromClientX(e.clientX)
      setDragFraction(null)
      if (duration > 0) overlayTransport.seekAbs(frac * duration)
    },
    [dragFraction, duration, fractionFromClientX],
  )

  const shownFraction = duration > 0 ? Math.min(1, dragFraction ?? time / duration) : 0
  const shownTime = dragFraction != null ? dragFraction * duration : time

  const onVolumeInput = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    overlayTransport.setVolume(v)
    if (v > 0 && muted) overlayTransport.setMuted(false)
  }, [muted])

  const effectiveVolume = muted ? 0 : volume
  const VolIcon = effectiveVolume === 0 ? VolumeX : effectiveVolume < 0.5 ? Volume1 : Volume2

  return (
    <div
      className={`${styles.root} ${visible ? '' : styles.hidden}`}
      onDoubleClick={() => sendOverlayCtl({ action: 'fullscreen' })}
    >
      <div className={styles.topBar}>
        <div className={styles.titles}>
          <div className={styles.title}>{item?.title ?? ''}</div>
          {item?.subtitle ? <div className={styles.subtitle}>{item.subtitle}</div> : null}
        </div>
        <button
          className={styles.closeBtn}
          onClick={() => sendOverlayCtl({ action: 'close' })}
          aria-label="Cerrar reproductor"
          title="Cerrar (Esc)"
        >
          <X size={20} />
        </button>
      </div>

      {estFps > 0 && (
        <div className={styles.chip}>{Math.round(estFps)} fps</div>
      )}

      {isBuffering && (
        <div className={styles.center}>
          <div className={styles.spinner} />
        </div>
      )}

      <div className={styles.bottom}>
        {isLive ? (
          <div className={styles.liveRow}>
            <span className={styles.liveDot} />
            <span className={styles.liveLabel}>En vivo</span>
            {item?.label ? <span className={styles.sourceLabel}>· {item.label}</span> : null}
          </div>
        ) : (
          <div className={styles.seekRow}>
            <span className={styles.time}>{formatTime(shownTime)}</span>
            <div
              ref={trackRef}
              className={styles.track}
              onPointerDown={onSeekDown}
              onPointerMove={onSeekMove}
              onPointerUp={onSeekUp}
              role="slider"
              aria-label="Posicion de reproduccion"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(shownTime)}
            >
              <div className={styles.played} style={{ transform: `scaleX(${shownFraction})` }} />
              <div className={styles.scrubber} style={{ left: `${shownFraction * 100}%` }} />
            </div>
            <span className={styles.time}>{formatTime(duration)}</span>
          </div>
        )}

        <div className={styles.row}>
          <button
            className={`${styles.btn} ${styles.playBtn}`}
            onClick={() => overlayTransport.setPaused(isPlaying)}
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            title={isPlaying ? 'Pausar' : 'Reproducir'}
          >
            {isPlaying ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </button>

          {isLive && (
            <>
              <button
                className={styles.btn}
                onClick={() => sendOverlayCtl({ action: 'zap', dir: -1 })}
                aria-label="Canal anterior"
                title="Canal anterior"
              >
                <ChevronUp size={20} />
              </button>
              <button
                className={styles.btn}
                onClick={() => sendOverlayCtl({ action: 'zap', dir: 1 })}
                aria-label="Canal siguiente"
                title="Canal siguiente"
              >
                <ChevronDown size={20} />
              </button>
            </>
          )}

          <div className={styles.spacer} />

          <button
            className={styles.btn}
            onClick={() => overlayTransport.setMuted(!muted)}
            aria-label={muted ? 'Activar sonido' : 'Silenciar'}
            title={muted ? 'Activar sonido' : 'Silenciar (M)'}
          >
            <VolIcon size={20} />
          </button>
          <input
            type="range"
            className={styles.volSlider}
            min={0}
            max={1}
            step={0.01}
            value={effectiveVolume}
            onChange={onVolumeInput}
            aria-label="Volumen"
          />

          <button
            className={styles.btn}
            onClick={() => sendOverlayCtl({ action: 'fullscreen' })}
            aria-label="Pantalla completa"
            title="Pantalla completa (F)"
          >
            <Maximize size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
