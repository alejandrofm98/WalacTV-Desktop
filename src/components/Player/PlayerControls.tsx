import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  Check,
  Languages,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Subtitles,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { playerService } from '../../player/PlayerService'
import { usePlayerStore } from '../../player/usePlayerStore'
import type { PlayerItem } from '../../player/types'
import { setVolume as persistVolume, setPreferredQuality } from '../../settings'
import styles from './PlayerControls.module.css'

export type PanelKind = 'audio' | 'subs' | 'quality' | null

const SEEK_STEP_SECONDS = 10

interface PlayerControlsProps {
  item: PlayerItem
  activePanel: PanelKind
  onPanelChange: (panel: PanelKind) => void
}

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

function languageName(code: string): string {
  if (!code) return 'Desconocido'
  try {
    const names = new Intl.DisplayNames(['es'], { type: 'language' })
    const name = names.of(code)
    if (name) return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    // Fall through to raw code
  }
  return code.toUpperCase()
}

/**
 * Seek row: progress bar with buffer indicator, drag-to-seek and time display.
 * Owns its own rAF loop (~10fps) so only this subtree re-renders on time ticks.
 */
function SeekRow() {
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [dragFraction, setDragFraction] = useState<number | null>(null)
  const [hoverFraction, setHoverFraction] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    let raf = 0
    let lastUpdate = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastUpdate < 100) return
      lastUpdate = now
      if (draggingRef.current) return
      const d = playerService.getDuration()
      setDuration(Number.isFinite(d) && d > 0 ? d : 0)
      setPosition(playerService.getCurrentTime())
      const video = playerService.getVideoElement()
      if (video && video.buffered.length > 0) {
        try {
          setBufferedEnd(video.buffered.end(video.buffered.length - 1))
        } catch {
          // Buffer access can throw while detaching; ignore
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const fractionFromClientX = useCallback((clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }, [])

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      draggingRef.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragFraction(fractionFromClientX(e.clientX))
    },
    [fractionFromClientX],
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const frac = fractionFromClientX(e.clientX)
      setHoverFraction(frac)
      if (draggingRef.current) setDragFraction(frac)
    },
    [fractionFromClientX],
  )

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      const frac = fractionFromClientX(e.clientX)
      setDragFraction(null)
      const d = playerService.getDuration()
      if (Number.isFinite(d) && d > 0) {
        playerService.seek(frac * d)
        setPosition(frac * d)
        setDuration(d)
      }
    },
    [fractionFromClientX],
  )

  const shownFraction =
    duration > 0 ? Math.min(1, dragFraction ?? position / duration) : 0
  const bufferedFraction = duration > 0 ? Math.min(1, bufferedEnd / duration) : 0
  const shownTime = dragFraction != null ? dragFraction * duration : position

  return (
    <div className={styles.seekRow}>
      <span className={styles.time}>{formatTime(shownTime)}</span>
      <div
        ref={trackRef}
        className={styles.progressTrack}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setHoverFraction(null)}
        role="slider"
        aria-label="Posición de reproducción"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shownTime)}
        aria-valuetext={`${formatTime(shownTime)} de ${formatTime(duration)}`}
      >
        <div
          className={styles.progressBuffered}
          style={{ transform: `scaleX(${bufferedFraction})` }}
        />
        <div
          className={styles.progressPlayed}
          style={{ transform: `scaleX(${shownFraction})` }}
        />
        <div
          className={styles.scrubber}
          style={{ left: `${shownFraction * 100}%` }}
        />
        {hoverFraction != null && duration > 0 && (
          <div
            className={styles.seekTooltip}
            style={{
              left: `clamp(30px, ${hoverFraction * 100}%, calc(100% - 30px))`,
            }}
          >
            {formatTime(hoverFraction * duration)}
          </div>
        )}
      </div>
      <span className={styles.time}>{formatTime(duration)}</span>
    </div>
  )
}

/**
 * Bottom chrome: seek bar, transport buttons, volume and track panels.
 */
export function PlayerControls({ item, activePanel, onPanelChange }: PlayerControlsProps) {
  const service = playerService
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const volume = usePlayerStore((s) => s.volume)
  const isMuted = usePlayerStore((s) => s.isMuted)
  const isFullscreen = usePlayerStore((s) => s.isFullscreen)
  const quality = usePlayerStore((s) => s.quality)

  const [tracksVersion, setTracksVersion] = useState(0)
  const rightClusterRef = useRef<HTMLDivElement | null>(null)

  const isLive = item.kind === 'CHANNEL' || item.kind === 'EVENT'
  const pipSupported =
    typeof document !== 'undefined' && !!document.pictureInPictureEnabled

  // Re-read track lists when Shaka signals track changes
  useEffect(() => {
    const handleTracksChanged = () => setTracksVersion((v) => v + 1)
    service.addEventListener('trackschanged', handleTracksChanged)
    return () => service.removeEventListener('trackschanged', handleTracksChanged)
  }, [service])

  const audioTracks = useMemo(
    () => service.getAudioTracks(),
    [service, tracksVersion],
  )
  const textTracks = useMemo(
    () => service.getTextTracks(),
    [service, tracksVersion],
  )
  const qualityHeights = useMemo(() => {
    const heights = new Set<number>()
    for (const t of service.getVariantTracks()) {
      if (t.height != null && t.height > 0) heights.add(t.height)
    }
    return [...heights].sort((a, b) => b - a)
  }, [service, tracksVersion])
  const activeVariantHeight = useMemo(() => {
    const active = service.getVariantTracks().find((t) => t.active)
    return active?.height ?? null
  }, [service, tracksVersion])

  // Close the open panel on outside click
  useEffect(() => {
    if (activePanel === null) return
    const onPointerDown = (e: PointerEvent) => {
      if (
        rightClusterRef.current &&
        !rightClusterRef.current.contains(e.target as Node)
      ) {
        onPanelChange(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [activePanel, onPanelChange])

  // Close the open panel on Escape. Capture phase + stopImmediatePropagation
  // so the player-level Escape (close player) does not also fire.
  useEffect(() => {
    if (activePanel === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        onPanelChange(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activePanel, onPanelChange])

  // 'K' toggles play/pause (Space and arrows are wired via usePlayerControls)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        service.togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [service])

  const skip = useCallback(
    (delta: number) => {
      service.seek(Math.max(0, service.getCurrentTime() + delta))
    },
    [service],
  )

  const effectiveVolume = isMuted ? 0 : volume

  const handleVolumeInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value)
      service.setVolume(v)
      if (v > 0 && isMuted) service.setMuted(false)
      persistVolume(v).catch(() => {})
    },
    [service, isMuted],
  )

  const toggleMute = useCallback(() => {
    service.setMuted(!isMuted)
  }, [service, isMuted])

  const togglePanel = useCallback(
    (panel: Exclude<PanelKind, null>) => {
      onPanelChange(activePanel === panel ? null : panel)
    },
    [activePanel, onPanelChange],
  )

  const VolumeIcon =
    effectiveVolume === 0 ? VolumeX : effectiveVolume < 0.5 ? Volume1 : Volume2

  const anyTextActive = textTracks.some((t) => t.active)

  return (
    <div className={styles.controls}>
      {isLive ? (
        <div className={styles.liveRow}>
          <span className={styles.liveDot} />
          <span className={styles.liveLabel}>En vivo</span>
        </div>
      ) : (
        <SeekRow />
      )}

      <div className={styles.buttonsRow}>
        {!isLive && (
          <button
            className={styles.controlBtn}
            onClick={() => skip(-SEEK_STEP_SECONDS)}
            aria-label={`Retroceder ${SEEK_STEP_SECONDS} segundos`}
          >
            <RotateCcw size={20} />
          </button>
        )}

        <button
          className={`${styles.controlBtn} ${styles.playBtn}`}
          onClick={() => service.togglePlay()}
          aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
        >
          {isPlaying ? (
            <Pause size={24} fill="currentColor" />
          ) : (
            <Play size={24} fill="currentColor" />
          )}
        </button>

        {!isLive && (
          <button
            className={styles.controlBtn}
            onClick={() => skip(SEEK_STEP_SECONDS)}
            aria-label={`Adelantar ${SEEK_STEP_SECONDS} segundos`}
          >
            <RotateCw size={20} />
          </button>
        )}

        <div className={styles.spacer} />

        <div className={styles.rightCluster} ref={rightClusterRef}>
          {audioTracks.length > 1 && (
            <button
              className={`${styles.controlBtn} ${activePanel === 'audio' ? styles.controlBtnActive : ''}`}
              onClick={() => togglePanel('audio')}
              aria-label="Idioma de audio"
              aria-expanded={activePanel === 'audio'}
            >
              <Languages size={20} />
            </button>
          )}

          {textTracks.length > 0 && (
            <button
              className={`${styles.controlBtn} ${activePanel === 'subs' ? styles.controlBtnActive : ''}`}
              onClick={() => togglePanel('subs')}
              aria-label="Subtítulos"
              aria-expanded={activePanel === 'subs'}
            >
              <Subtitles size={20} />
            </button>
          )}

          {qualityHeights.length > 0 && (
            <button
              className={`${styles.controlBtn} ${activePanel === 'quality' ? styles.controlBtnActive : ''}`}
              onClick={() => togglePanel('quality')}
              aria-label="Calidad de video"
              aria-expanded={activePanel === 'quality'}
            >
              <Settings size={20} />
            </button>
          )}

          {pipSupported && (
            <button
              className={styles.controlBtn}
              onClick={() => service.togglePip()}
              aria-label="Picture in picture"
            >
              <PictureInPicture2 size={20} />
            </button>
          )}

          <div className={styles.volumeGroup}>
            <button
              className={styles.controlBtn}
              onClick={toggleMute}
              aria-label={isMuted ? 'Activar sonido' : 'Silenciar'}
            >
              <VolumeIcon size={20} />
            </button>
            <input
              type="range"
              className={styles.volumeSlider}
              min={0}
              max={1}
              step={0.01}
              value={effectiveVolume}
              onChange={handleVolumeInput}
              aria-label="Volumen"
              style={
                { '--volume-pct': `${effectiveVolume * 100}%` } as CSSProperties
              }
            />
          </div>

          <button
            className={styles.controlBtn}
            onClick={() => service.toggleFullscreen()}
            aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          >
            {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>

          {activePanel !== null && (
            <div className={styles.panel} role="menu">
              {activePanel === 'audio' && (
                <>
                  <div className={styles.panelHeader}>Audio</div>
                  {audioTracks.map((t, i) => (
                    <button
                      key={`${t.language}-${t.label ?? ''}-${i}`}
                      className={`${styles.panelItem} ${t.active ? styles.panelItemActive : ''}`}
                      role="menuitem"
                      onClick={() => {
                        service.selectAudioTrack(t)
                        onPanelChange(null)
                      }}
                    >
                      <span>{t.label ?? languageName(t.language)}</span>
                      {t.active && <Check size={16} />}
                    </button>
                  ))}
                </>
              )}

              {activePanel === 'subs' && (
                <>
                  <div className={styles.panelHeader}>Subtítulos</div>
                  <button
                    className={`${styles.panelItem} ${!anyTextActive ? styles.panelItemActive : ''}`}
                    role="menuitem"
                    onClick={() => {
                      service.selectTextTrack(null)
                      onPanelChange(null)
                    }}
                  >
                    <span>Desactivados</span>
                    {!anyTextActive && <Check size={16} />}
                  </button>
                  {textTracks.map((t) => (
                    <button
                      key={t.id}
                      className={`${styles.panelItem} ${t.active ? styles.panelItemActive : ''}`}
                      role="menuitem"
                      onClick={() => {
                        service.selectTextTrack(t)
                        onPanelChange(null)
                      }}
                    >
                      <span>
                        {t.label ?? languageName(t.language)}
                        {t.forced ? ' · Forzados' : ''}
                      </span>
                      {t.active && <Check size={16} />}
                    </button>
                  ))}
                </>
              )}

              {activePanel === 'quality' && (
                <>
                  <div className={styles.panelHeader}>Calidad</div>
                  <button
                    className={`${styles.panelItem} ${quality === 'auto' ? styles.panelItemActive : ''}`}
                    role="menuitem"
                    onClick={() => {
                      service.setQuality('auto')
                      setPreferredQuality('auto').catch(() => {})
                      onPanelChange(null)
                    }}
                  >
                    <span>
                      Auto
                      {quality === 'auto' && activeVariantHeight != null && (
                        <span className={styles.panelItemHint}>
                          {activeVariantHeight}p
                        </span>
                      )}
                    </span>
                    {quality === 'auto' && <Check size={16} />}
                  </button>
                  {qualityHeights.map((h) => (
                    <button
                      key={h}
                      className={`${styles.panelItem} ${quality === h ? styles.panelItemActive : ''}`}
                      role="menuitem"
                      onClick={() => {
                        service.setQuality(h)
                        setPreferredQuality(h).catch(() => {})
                        onPanelChange(null)
                      }}
                    >
                      <span>{h}p</span>
                      {quality === h && <Check size={16} />}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
