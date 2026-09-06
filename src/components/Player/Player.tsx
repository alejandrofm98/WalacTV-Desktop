import { useEffect, useRef, useCallback, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '../../store/useAppStore'
import { playerService } from '../../player/PlayerService'
import { usePlayer } from '../../player/usePlayer'
import { useRenderFrame } from '../../player/useRenderFrame'
import { usePlayerProgress } from '../../player/usePlayerProgress'
import { useIntroSkip } from '../../player/useIntroSkip'
import { usePlayerControls } from '../../player/usePlayerControls'
import { usePlayerStore } from '../../player/usePlayerStore'
import { getVolume } from '../../settings'
import { markWatched, getCatalogPage } from '../../api/client'
import { PlayerOverlay } from './PlayerOverlay'
import { PlayerChannelGuide } from './PlayerChannelGuide'
import { PlayerEventSources } from './PlayerEventSources'
import { PlayerIntroSkip } from './PlayerIntroSkip'
import { PlayerErrorState } from './PlayerErrorState'
import { PlayerLoadingState } from './PlayerLoadingState'
import { TorrentLoadingOverlay } from './TorrentLoadingOverlay'
import styles from './Player.module.css'

/**
 * Player container component.
 *
 * libmpv renders directly onto the native GPU surface behind this webview.
 * A hidden <video> element is kept only for Picture-in-Picture API support.
 * The container div is used for fullscreen (not the canvas/video).
 * UI controls sit as siblings above the canvas.
 */
export function Player() {
  const playerItem = useAppStore((s) => s.playerItem)
  const closePlayer = useAppStore((s) => s.closePlayer)
  const guideOpen = useAppStore((s) => s.guideOpen)

  const isChannel = playerItem?.kind === 'CHANNEL'
  const isEvent = playerItem?.kind === 'EVENT'
  const showGuide = (isChannel || isEvent) && guideOpen
  const isLiveItem = playerItem?.kind === 'CHANNEL' || isEvent

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pipVideoRef = useRef<HTMLVideoElement | null>(null)
  const prevItemRef = useRef(playerItem)

  const { service } = usePlayer()
  const storeError = usePlayerStore((s) => s.error)
  const isBuffering = usePlayerStore((s) => s.isBuffering)
  const isOpening = usePlayerStore((s) => s.isOpening)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const torrentInfo = usePlayerStore((s) => s.torrentInfo)
  const torrentStats = usePlayerStore((s) => s.torrentStats)

  // Draw mpv's offscreen frames onto the canvas while playing.
  // Both Linux (EGL readback) and Windows (WGL FBO readback) deliver frames
  // through `mpv_get_render_frame`; the native window is never shown.
  // The canvas stays mounted on all OSes: on Windows the webview is opaque
  // and would hide any native surface below it (airspace), so offscreen
  // readback + canvas is the only working path (verified ~23fps prod).
  const [renderFps, setRenderFps] = useState<number | null>(null)
  useRenderFrame(
    canvasRef,
    playerItem?.stableId ?? null,
    isPlaying,
    setRenderFps,
  )

  // True on Linux where mpv renders its own native OSC as a child window.
  // When true, the HTML PlayerOverlay is hidden to avoid a flash of HTML
  // controls before mpv's child window appears on top of them.
  // Starts as null (unknown) so the overlay NEVER renders until we know the
  // resolved value — prevents a brief flash of HTML controls on Linux where
  // the native mpv/uosc child window appears ~1s after mount.
  const [nativeControls, setNativeControls] = useState<boolean | null>(null)

  const getCurrentTime = useCallback(() => service.getCurrentTime(), [service])
  const getDuration = useCallback(() => service.getDuration(), [service])

  // Progress persistence
  usePlayerProgress({
    item: playerItem,
    getCurrentTime,
    getDuration,
    isPlaying,
  })

  useEffect(() => {
    if (!playerItem || (playerItem.kind !== 'MOVIE' && playerItem.kind !== 'SERIES')) return

    const handleEnded = () => {
      const markComplete = async () => {
        await markWatched(
          playerItem.stableId,
          playerItem.seasonNumber,
          playerItem.episodeNumber,
          true,
        )
      }
      markComplete().catch((error) => {
        console.warn('[Player] no se pudo marcar el contenido como completado:', error)
      })
    }

    service.addEventListener('ended', handleEnded)
    return () => service.removeEventListener('ended', handleEnded)
  }, [playerItem, service])

  // Intro skip
  const { activeSegment, skip: doSkip } = useIntroSkip({
    item: playerItem,
    getCurrentTime,
    onSkip: (secs) => service.seek(secs),
  })

  // 1s ticker so time-derived UI (e.g. intro skip segment detection,
  // which recomputes on render) stays fresh while playing
  const [, setPlaybackTick] = useState(0)
  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(() => setPlaybackTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [isPlaying])

  // Controls auto-hide + keyboard
  // En directo (canales/eventos): ↑/↓ zapean y ←/→ suben/bajan volumen.
  // En VOD: ←/→ saltan ±10s y ↑/↓ volumen.
  const { controlsVisible } = usePlayerControls({
    isLive: isLiveItem,
    onTogglePlay: () => service.togglePlay(),
    onSeek: (delta) => {
      const current = service.getCurrentTime()
      service.seek(Math.max(0, current + delta))
    },
    onVolumeUp: () => {
      const vol = Math.min(1, (usePlayerStore.getState().volume) + 0.1)
      service.setVolume(vol)
    },
    onVolumeDown: () => {
      const vol = Math.max(0, (usePlayerStore.getState().volume) - 0.1)
      service.setVolume(vol)
    },
    onMute: () => {
      const muted = usePlayerStore.getState().isMuted
      service.setMuted(!muted)
    },
    onFullscreen: () => service.toggleFullscreen(),
    onPip: () => service.togglePip(),
    // Estilo TV: en canales ↑/↓ zapean canales; en eventos cambian de fuente.
    onChannelUp: () => {
      const st = useAppStore.getState()
      if (isChannel) st.zapChannel(-1)
      else st.zapSource(-1)
    },
    onChannelDown: () => {
      const st = useAppStore.getState()
      if (isChannel) st.zapChannel(1)
      else st.zapSource(1)
    },
  })

  // Rueda del raton sobre el reproductor: subir/bajar volumen (10% por paso).
  // Listener nativo en el contenedor (la delegacion sintetica de React no
  // dispara fiable con wheel). Se ignora si el cursor esta sobre la guia de
  // canales (su lista hace scroll) o sobre un input. Subir volumen cancela
  // el silencio; la rueda tambien muestra los controles (ver usePlayerControls).
  // El contenedor solo existe con playerItem, por eso depende de containerEl.
  useEffect(() => {
    const el = containerEl
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[class*=guide]')) return
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const step = e.deltaY < 0 ? 0.1 : -0.1
      const state = usePlayerStore.getState()
      const vol = Math.min(1, Math.max(0, state.volume + step))
      if (vol > state.volume && state.isMuted) service.setMuted(false)
      service.setVolume(vol)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => el.removeEventListener('wheel', onWheel)
  }, [containerEl, service])

  // Store DOM refs for the player service
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el
    setContainerEl(el)
    // Tell the service about the container for fullscreen
    service.setContainerEl(el)
  }, [service])
  const setPipVideoRef = useCallback((el: HTMLVideoElement | null) => {
    pipVideoRef.current = el
    // Tell the service about the hidden video for PiP API
    service.setPipVideoEl(el)
  }, [service])
  // Attach player + load content when playerItem changes.
  // Unificado en un solo efecto para que attach() resuelva antes de load().
  useEffect(() => {
    const prev = prevItemRef.current
    prevItemRef.current = playerItem

    if (!playerItem) {
      // Item removed — unload
      service.unload().catch(() => {})
      return
    }

    let cancelled = false

    const run = async () => {
      try {
        // 1. Attach — llama a mpv_init() en Rust (no necesita elemento DOM)
        await service.attach()
        setNativeControls(service.getNativeControls())

        if (cancelled) return

        // Restore persisted volume for this session
        service.setVolume(getVolume())

        // 2. Solo despues de attach completado, cargar contenido
        const streamOptions = playerItem.streamOptions
        if (!streamOptions || streamOptions.length === 0) {
          console.warn(
            `[Player] No stream options for item:`,
            `id=${playerItem.stableId}`,
            `kind=${playerItem.kind}`,
            `title="${playerItem.title}"`,
            `streamOptions=${JSON.stringify(streamOptions)}`,
          )
          usePlayerStore.getState().setError({
            kind: 'not_found',
            message: 'No hay opciones de stream disponibles.',
            recoverable: false,
          })
          return
        }

        console.log(
          `[Player] Loading item: id=${playerItem.stableId} kind=${playerItem.kind} title="${playerItem.title}"`,
          `streamOptions=${streamOptions.length}:`,
          streamOptions.map((o) => `"${o.label}"`).join(', '),
        )

        // Read start position from store directly instead of via deps to avoid a
        // re-entrancy bug: setting playerStartPosition=0 below would re-trigger
        // this effect if it were in the dependency array, causing a double load.
        const currentStartPos = useAppStore.getState().playerStartPosition
        const startPos = currentStartPos > 0 ? currentStartPos : undefined

        // Respect the user-selected stream (chosen source in detail screens):
        // start from that index, falling back to the remaining options in
        // order if it fails.
        const preferredIndex = useAppStore.getState().playerStreamIndex
        const orderedStreams =
          preferredIndex > 0 && preferredIndex < streamOptions.length
            ? [...streamOptions.slice(preferredIndex), ...streamOptions.slice(0, preferredIndex)]
            : streamOptions

        await service.load(playerItem, orderedStreams, startPos)

        // Reset start position / stream index for next open
        useAppStore.setState({ playerStartPosition: 0, playerStreamIndex: 0 })
      } catch (err) {
        if (!cancelled) {
          console.error('[Player] attach/load failed:', err)
        }
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [playerItem, service])

  // Lista base para zapping (flechas arriba/abajo y botones de canal) cuando
  // la guia nunca se ha abierto: la guia publica su lista al montarse, pero
  // si esta cerrada no hay referencia. Se carga la primera pagina del
  // catalogo de canales; si la guia ya tiene lista (p. ej. filtrada), se respeta.
  useEffect(() => {
    if (!isChannel) return
    if (useAppStore.getState().guideChannels.length > 0) return
    let cancelled = false
    getCatalogPage({ content_type: 'channels', page: 1, page_size: 48 })
      .then((r) => {
        if (cancelled) return
        if (useAppStore.getState().guideChannels.length === 0) {
          useAppStore.setState({ guideChannels: r.items })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isChannel, playerItem?.stableId])

  // Channel guide: SOLO se abre con el boton de guia (manual). Al estar
  // abierta en un canal, se auto-cierra a los ~3s de que el canal este
  // reproduciendose (estilo TV); cambiar de canal reinicia el contador.
  useEffect(() => {
    if (!showGuide || !isPlaying) return
    const id = setTimeout(() => useAppStore.setState({ guideOpen: false }), 3000)
    return () => clearTimeout(id)
  }, [showGuide, isPlaying, playerItem?.stableId])

  // Close on Escape via window keydown (works when webview has focus).
  // When fullscreen or PiP is active, let the browser consume Escape to
  // exit that mode first; a second press closes the player.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (document.fullscreenElement || document.pictureInPictureElement) return
        // La guia de canales abierta se pliega primero; escribiendo en su
        // campo de busqueda solo se desenfoca el input en vez de plegarla.
        if (useAppStore.getState().guideOpen) {
          const ae = document.activeElement
          if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) {
            ;(ae as HTMLElement).blur()
            return
          }
          e.preventDefault()
          useAppStore.setState({ guideOpen: false })
          return
        }
        // La ventana Tauri en pantalla completa no la gestiona el navegador:
        // primer Escape sale de fullscreen, el segundo cierra el player.
        if (usePlayerStore.getState().isFullscreen) {
          e.preventDefault()
          service.exitFullscreen()
          return
        }
        e.preventDefault()
        closePlayer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closePlayer, service])

  // Listen for player://close Tauri event emitted by the global shortcut
  // handler in Rust. This guarantees the player can be closed even when
  // the mpv child window has keyboard focus (Escape keydown not reaching JS).
  useEffect(() => {
    let unlisten: (() => void) | undefined

    const setup = async () => {
      unlisten = await listen<null>('player://close', () => {
        closePlayer()
      })
    }
    setup()

    return () => {
      if (unlisten) unlisten()
    }
  }, [closePlayer])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (usePlayerStore.getState().isFullscreen) {
        service.exitFullscreen()
      }
      service.detach()
    }
  }, [service])

  // Retry the current item after a recoverable error
  // Re-attaches the player then reloads, because a failed attach() means
  // load() will skip (logs "load() called before attach() completed").
  const handleRetry = useCallback(async () => {
    if (!playerItem?.streamOptions?.length) return
    usePlayerStore.getState().clearError()

    try {
      await service.attach()
      setNativeControls(service.getNativeControls())
      await service.load(playerItem, playerItem.streamOptions)
    } catch (err) {
      console.error('[Player] retry load failed:', err)
    }
  }, [playerItem, service])

  if (!playerItem) return null

  return (
    <div ref={setContainerRef} className={styles.container}>
      <div className={styles.body}>
        <div className={styles.stage}>
          <div className={styles.videoWrapper}>
            {/* Canvas where mpv's offscreen frames are drawn (CPU readback).
                Mounted on all OSes: Linux EGL + Windows WGL FBO readback. */}
            <canvas ref={canvasRef} className={styles.canvas} />
            {renderFps !== null && isPlaying && (
              <div className={styles.fpsCounter}>{renderFps} fps</div>
            )}
            {/* Hidden video element for PiP API support only */}
            <video
              ref={setPipVideoRef}
              style={{ display: 'none' }}
              playsInline
            />
          </div>

          {/* En directo (canales/eventos) el overlay sigue montado aunque
              haya error: los botones de zapping/fuentes deben poder usarse
              siempre para cambiar sin cerrar el reproductor. */}
          {(!storeError || isLiveItem) && nativeControls === false && (
            <PlayerOverlay
              visible={controlsVisible}
              item={playerItem}
              epg={null}
              onBack={closePlayer}
            />
          )}
          {!storeError && (
            <PlayerIntroSkip segment={activeSegment} onSkip={doSkip} />
          )}

          {storeError ? (
            <PlayerErrorState
              error={storeError}
              onRetry={handleRetry}
              onClose={closePlayer}
              compact={isChannel || isEvent}
            />
          ) : torrentInfo && (isOpening || isBuffering) ? (
            <TorrentLoadingOverlay info={torrentInfo} stats={torrentStats} />
          ) : isOpening || isBuffering ? (
            <PlayerLoadingState variant={isOpening ? 'opening' : 'buffering'} />
          ) : null}
        </div>

        {showGuide && isChannel && <PlayerChannelGuide currentId={playerItem.stableId} />}
        {showGuide && isEvent && <PlayerEventSources item={playerItem} />}
      </div>
    </div>
  )
}
