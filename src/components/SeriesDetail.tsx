import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Play, ArrowLeft, Check } from 'lucide-react'
import type { CatalogItem, StreamOption, WatchProgressItem } from '../api/types'
import { getAllSeriesEpisodes, getWatchProgress, markSeriesEpisodesWatched, cwGroupKey, getTorrentioEpisodeStreams, isPlayableOption, pickBestStreamIndex, displayTitleOf, sortTorrentStreams } from '../api/client'
import { devWarn } from '../utils/logger'
import { useAppStore } from '../store/useAppStore'
import styles from './SeriesDetail.module.css'

interface Props {
  item: CatalogItem
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}min` : `${m}min`
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  return `${Math.round(mb)} MB`
}

function qualityOf(opt: StreamOption): string {
  const q = opt.quality?.toLowerCase() ?? ''
  if (q) return q
  const hay = `${opt.label} ${opt.torrentTitle ?? ''}`.toLowerCase()
  if (hay.includes('2160') || hay.includes('4k')) return '2160p'
  if (hay.includes('1080')) return '1080p'
  if (hay.includes('720')) return '720p'
  return 'SD'
}

const isTorrentStream = (o: StreamOption) => !!o.infoHash

function computeCwEntry(item: CatalogItem, entries: Map<string, WatchProgressItem>): WatchProgressItem | undefined {
  return entries.get(cwGroupKey('series', item.seriesName, item.stableId))
    ?? entries.get(item.stableId)
    ?? entries.get(item.providerId ?? '')
}

function getEpisodeStatus(
  ep: CatalogItem,
  cwEntry: WatchProgressItem | undefined,
): { label: string; variant: 'play' | 'watched' | 'inProgress' } {
  const isCurrent =
    !!cwEntry &&
    cwEntry.seasonNumber === ep.seasonNumber &&
    cwEntry.episodeNumber === ep.episodeNumber &&
    !cwEntry.isWatched

  if (isCurrent) return { label: 'En reproduccion', variant: 'inProgress' }
  if (ep.isWatched) return { label: 'Visto', variant: 'watched' }
  return { label: '', variant: 'play' }
}

// Completa un capítulo para el player con el arte de la serie: los
// episodios suelen venir sin póster/backdrop y la pantalla de carga debe
// mostrar lo mismo que la ficha.
function withSeriesArt(ep: CatalogItem, series: CatalogItem): CatalogItem {
  return {
    ...ep,
    imageUrl: ep.imageUrl || series.imageUrl,
    tmdbPosterUrl: ep.tmdbPosterUrl ?? series.tmdbPosterUrl ?? null,
    backdropUrl: ep.backdropUrl ?? series.backdropUrl ?? null,
  }
}

export function SeriesDetail({ item }: Props) {
  const { closeDetail, openPlayer, continueWatchingEntries, setContinueWatching } = useAppStore()
  const [episodes, setEpisodes] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const [contextEpisode, setContextEpisode] = useState<CatalogItem | null>(null)
  const [sourceEpisode, setSourceEpisode] = useState<CatalogItem | null>(null)
  const [sourceStreams, setSourceStreams] = useState<StreamOption[]>([])
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState(false)
  const [selectedSource, setSelectedSource] = useState(0)

  // IDs estables primero: los tiles de Continuar viendo traen stableId='series:nombre'
  // (group key, no sirve para la API) pero conservan catalogId/contentId real.
  const seriesId = item.seriesKey ?? item.catalogId ?? item.seriesProviderId ?? item.providerId ?? item.stableId ?? item.seriesName ?? item.normalizedTitle ?? item.title
  // Nombre TMDB de la serie para el player (el del proveedor suele traer suciedad).
  const seriesDisplayTitle = displayTitleOf(item)
  const preselectedRef = useRef(false)
  const wasPlayingRef = useRef(false)
  const episodeRefs = useRef<Map<string, HTMLElement>>(new Map())
  const railRef = useRef<HTMLDivElement>(null)
  // imdb del serie: el tile de Continuar viendo llega sin imdb_id, se recupera
  // del primer episodio que lo traiga (el backend lo incluye por episodio).
  const [seriesImdb, setSeriesImdb] = useState<string | null>(
    item.imdbId && /^tt\d+$/i.test(item.imdbId) ? item.imdbId : null,
  )

  const fetchEpisodes = useCallback(() => {
    if (!seriesId) return
    setLoading(true)
    setError(null)
    // Captura primitiva para no depender de la identidad del objeto item.
    const itemStableId = item.stableId
    const itemSeriesName = item.seriesName
    const itemProviderId = item.providerId
    return getAllSeriesEpisodes(seriesId)
      .then((eps) => {
        setEpisodes(eps ?? [])
        setSeriesImdb((current) => {
          if (current) return current
          const found = (eps ?? []).find((e) => e.imdbId && /^tt\d+$/i.test(e.imdbId))
          return found?.imdbId ?? null
        })
        if (!preselectedRef.current) {
          preselectedRef.current = true
          const cw = computeCwEntry(
            { stableId: itemStableId, seriesName: itemSeriesName, providerId: itemProviderId } as CatalogItem,
            useAppStore.getState().continueWatchingEntries,
          )
          const loaded = eps ?? []
          const seasonsArr = [...new Set(loaded.map((e) => e.seasonNumber).filter(Boolean))] as number[]
          if (cw?.seasonNumber != null && seasonsArr.includes(cw.seasonNumber)) {
            setSelectedSeason(cw.seasonNumber)
          }
        }
      })
      .catch(() => setError('No se pudieron cargar los episodios'))
      .finally(() => setLoading(false))
  }, [seriesId, item.stableId, item.seriesName, item.providerId])

  useEffect(() => {
    preselectedRef.current = false
    fetchEpisodes()
  }, [fetchEpisodes])

  const cwEntry = computeCwEntry(item, continueWatchingEntries)

  const seasons = useMemo(
    () => [...new Set(episodes.map((e) => e.seasonNumber).filter(Boolean))].sort((a, b) => a! - b!) as number[],
    [episodes],
  )

  const filteredEpisodes = useMemo(() => {
    const base = selectedSeason != null
      ? episodes.filter((e) => e.seasonNumber === selectedSeason)
      : episodes
    return [...base].sort(
      (a, b) =>
        (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
        (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
    )
  }, [episodes, selectedSeason])

  const watchedBySeason = useMemo(() => {
    const map = new Map<number, { seen: number; total: number }>()
    for (const e of episodes) {
      if (e.seasonNumber == null) continue
      const cur = map.get(e.seasonNumber) ?? { seen: 0, total: 0 }
      cur.total += 1
      if (e.isWatched) cur.seen += 1
      map.set(e.seasonNumber, cur)
    }
    return map
  }, [episodes])

  useEffect(() => {
    if (cwEntry?.seasonNumber == null || cwEntry.episodeNumber == null) return
    if (!preselectedRef.current) return
    const key = `${cwEntry.seasonNumber}|${cwEntry.episodeNumber}`
    const el = episodeRefs.current.get(key)
    if (el) {
      const raf = requestAnimationFrame(() => {
        el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
        el.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [cwEntry, selectedSeason, episodes])

  const playerItem = useAppStore((s) => s.playerItem)

  // Posiciones guardadas por episodio ("T|E" -> ms): el listado de episodios
  // no trae position_ms, se resuelven desde watch-progress para reanudar.
  const [positionsByEp, setPositionsByEp] = useState<Map<string, number>>(new Map())
  const fetchPositions = useCallback(() => {
    // El endpoint acepta limit<=50: con mas da 422 y las posiciones no llegan.
    getWatchProgress(50)
      .then(({ items }) => {
        const map = new Map<string, number>()
        for (const p of items) {
          if (p.contentType !== 'series') continue
          if (p.seasonNumber == null || p.episodeNumber == null) continue
          if (!p.positionMs || p.isWatched) continue
          map.set(`${p.seasonNumber}|${p.episodeNumber}`, p.positionMs)
        }
        setPositionsByEp(map)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchPositions()
  }, [fetchPositions])

  useEffect(() => {
    const playing = !!playerItem
    if (wasPlayingRef.current && !playing) {
      fetchEpisodes()
      fetchPositions()
    }
    wasPlayingRef.current = playing
  }, [playerItem, fetchEpisodes, fetchPositions])

  const continueProgress = cwEntry && cwEntry.durationMs > 0
    ? Math.min(100, (cwEntry.positionMs / cwEntry.durationMs) * 100)
    : 0

  const registerEpisodeRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) episodeRefs.current.set(key, el)
    else episodeRefs.current.delete(key)
  }, [])

  const firstUnwatched = useMemo(() => {
    if (cwEntry && !cwEntry.isWatched) {
      const cwEp = episodes.find(
        (e) => e.seasonNumber === cwEntry.seasonNumber && e.episodeNumber === cwEntry.episodeNumber
      )
      if (cwEp) return cwEp
    }

    const sortedAll = [...episodes].sort(
      (a, b) =>
        (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
        (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
    )
    for (const ep of sortedAll) {
      if (!ep.isWatched) return ep
    }
    return sortedAll[0] ?? null
  }, [episodes, cwEntry])

  // Abre el modal de fuentes para el episodio: consulta Torrentio directo y combina
  // con los streams IPTV del episodio. La mejor fuente queda preseleccionada.
  const handleChooseSource = useCallback(async (episode: CatalogItem) => {
    setSourceEpisode(episode)
    setSelectedSource(0)
    setSourceStreams([])
    setSourceError(false)
    setSourceLoading(true)
    const iptv = episode.streamOptions.filter((o) => isPlayableOption(o) && !isTorrentStream(o))
    const backendTorrents = episode.streamOptions.filter(isTorrentStream)
    if (episode.seasonNumber != null && episode.episodeNumber != null && seriesImdb) {
      try {
        const torrents = await getTorrentioEpisodeStreams(
          seriesImdb,
          episode.seasonNumber,
          episode.episodeNumber,
        )
        // getTorrentio ya ordena por idioma preferido; se reordena el
        // conjunto con los torrents que vengan del backend.
        setSourceStreams([...iptv, ...sortTorrentStreams([...backendTorrents, ...torrents])])
      } catch (err) {
        devWarn('[Torrentio] source modal lookup failed:', err)
        setSourceStreams([...iptv, ...sortTorrentStreams(backendTorrents)])
        setSourceError(true)
      }
    } else {
      setSourceStreams([...iptv, ...sortTorrentStreams(backendTorrents)])
      setSourceError(false)
    }
    setSourceLoading(false)
  }, [seriesImdb])

  // Reproduccion directa: mezcla Torrentio directo (sin servidor) con los streams del episodio.
  // Reanuda a mitad si el episodio tiene posicion guardada (watch-progress, ms).
  const handlePlayEpisode = useCallback(async (episode: CatalogItem) => {
    const epKey = episode.seasonNumber != null && episode.episodeNumber != null
      ? `${episode.seasonNumber}|${episode.episodeNumber}`
      : null
    const savedMs = (epKey ? positionsByEp.get(epKey) : undefined) ?? 0
    const resumeMs = savedMs && !episode.isWatched ? savedMs : 0
    if (episode.seasonNumber != null && episode.episodeNumber != null && seriesImdb) {
      try {
        const torrents = await getTorrentioEpisodeStreams(
          seriesImdb,
          episode.seasonNumber,
          episode.episodeNumber,
        )
        if (torrents.length > 0) {
          const opts = [...episode.streamOptions.filter((o) => isPlayableOption(o) && !o.infoHash), ...torrents]
          openPlayer(
            withSeriesArt({ ...episode, streamOptions: opts, seriesTmdbTitle: seriesDisplayTitle }, item),
            pickBestStreamIndex(opts),
            resumeMs,
          )
          return
        }
      } catch {
        // IPTV playback remains available when Torrentio is unavailable.
      }
    }
    const fallback = episode.streamOptions.filter(isPlayableOption)
    if (fallback.length === 0) {
      // Nada reproducible: abre el modal de fuentes para mostrar el estado en vez de un player roto.
      void handleChooseSource(episode)
      return
    }
    openPlayer(
      withSeriesArt({ ...episode, streamOptions: fallback, seriesTmdbTitle: seriesDisplayTitle }, item),
      pickBestStreamIndex(fallback),
      resumeMs,
    )
  }, [seriesImdb, openPlayer, handleChooseSource, seriesDisplayTitle, item, positionsByEp])

  const bestTorrentIndex = useMemo(() => {
    if (sourceStreams.length === 0) return -1
    const torrents = sourceStreams.filter(isTorrentStream)
    if (torrents.length === 0) return -1
    // sourceStreams ya ordena los torrents por idioma preferido primero.
    return sourceStreams.indexOf(torrents[0])
  }, [sourceStreams])

  // Preselecciona la mejor fuente (calidad + seeds) cuando se abre el modal.
  useEffect(() => {
    if (!sourceLoading && sourceStreams.length > 0 && bestTorrentIndex >= 0 && selectedSource === 0) {
      setSelectedSource(bestTorrentIndex)
    }
  }, [sourceLoading, sourceStreams, bestTorrentIndex, selectedSource])

  // Cierra el modal con Escape (stopPropagation para no cerrar tambien la ficha global).
  useEffect(() => {
    if (!sourceEpisode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setSourceEpisode(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sourceEpisode])

  // La fila del episodio reproduce directo; el botón de fuentes abre el modal.
  // sourceStreams ya incluye IPTV + torrents del episodio + Torrentio, así que
  // el índice elegido en el modal coincide con el array que recibe el player.
  const handlePlayFromSource = useCallback((index: number) => {
    if (!sourceEpisode) return
    const epKey = sourceEpisode.seasonNumber != null && sourceEpisode.episodeNumber != null
      ? `${sourceEpisode.seasonNumber}|${sourceEpisode.episodeNumber}`
      : null
    const savedMs = (epKey ? positionsByEp.get(epKey) : undefined) ?? 0
    const resumeMs = savedMs && !sourceEpisode.isWatched ? savedMs : 0
    openPlayer(withSeriesArt({ ...sourceEpisode, streamOptions: sourceStreams, seriesTmdbTitle: seriesDisplayTitle }, item), index, resumeMs)
    setSourceEpisode(null)
  }, [sourceEpisode, sourceStreams, openPlayer, seriesDisplayTitle, item, positionsByEp])

  const handlePlayHero = useCallback(() => {
    if (firstUnwatched) void handlePlayEpisode(firstUnwatched)
  }, [firstUnwatched, handlePlayEpisode])

  const markEpisodesWatched = useCallback(async (targets: CatalogItem[]) => {
    if (targets.length === 0) return
    try {
      await markSeriesEpisodesWatched(seriesId, targets)
      const marked = new Set(targets.map((ep) => `${ep.seasonNumber}|${ep.episodeNumber}`))
      setEpisodes((current) => current.map((ep) =>
        marked.has(`${ep.seasonNumber}|${ep.episodeNumber}`) ? { ...ep, isWatched: true } : ep,
      ))
      const { items } = await getWatchProgress(20)
      const entries = new Map<string, WatchProgressItem>()
      for (const progress of items) {
        const key = cwGroupKey(progress.contentType, progress.seriesName, progress.contentId)
        if (!entries.has(key)) entries.set(key, progress)
      }
      setContinueWatching(entries)
    } catch (err) {
      console.error('mark series episodes watched failed', err)
    } finally {
      setContextEpisode(null)
    }
  }, [seriesId, setContinueWatching])

  // Close context menu on outside click
  useEffect(() => {
    if (!contextEpisode) return
    const close = () => setContextEpisode(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextEpisode])

  const isResuming = !!(cwEntry && !cwEntry.isWatched)
  const ctaLabel = firstUnwatched
    ? `${isResuming ? 'Continuar' : 'Reproducir'} T${firstUnwatched.seasonNumber ?? '?'} E${firstUnwatched.episodeNumber ?? '?'}`
    : 'Reproducir'
  const ctaMinutesLeft =
    isResuming && continueProgress > 0 && firstUnwatched?.runtimeMinutes
      ? Math.max(1, Math.round(firstUnwatched.runtimeMinutes * (1 - continueProgress / 100)))
      : null
  const ctaSub = firstUnwatched
    ? [
        displayTitleOf(firstUnwatched),
        ctaMinutesLeft != null ? `quedan ${ctaMinutesLeft} min` : null,
      ]
        .filter((p): p is string => p != null)
        .join(' · ')
    : ''
  const heroSourceCount =
    firstUnwatched &&
    sourceEpisode?.stableId === firstUnwatched.stableId &&
    !sourceLoading &&
    sourceStreams.length > 0
      ? sourceStreams.length
      : null

  // 'F' abre el selector de fuentes del episodio en curso (lean-back).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key !== 'f' && e.key !== 'F') return
      if (!firstUnwatched || sourceEpisode || contextEpisode) return
      e.preventDefault()
      void handleChooseSource(firstUnwatched)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [firstUnwatched, handleChooseSource, sourceEpisode, contextEpisode])

  // Roaming con flechas dentro del rail de episodios.
  const handleRailKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const rail = railRef.current
    if (!rail) return
    const cards = Array.from(rail.querySelectorAll<HTMLElement>('[data-ep-card]'))
    const idx = cards.indexOf(document.activeElement as HTMLElement)
    if (idx === -1) return
    e.preventDefault()
    const next = cards[idx + (e.key === 'ArrowRight' ? 1 : -1)]
    if (next) {
      next.focus()
      next.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
    }
  }, [])

  return (
    <div className={styles.container}>
      {/* Masthead compacto: el arte no compite con la accion */}
      <header className={styles.masthead}>
        {(item.backdropUrl || item.tmdbPosterUrl || item.imageUrl) && (
          <img
            src={item.backdropUrl || item.tmdbPosterUrl || item.imageUrl}
            alt=""
            className={styles.mastheadArt}
          />
        )}
        <div className={styles.mastheadShade} />

        <div className={styles.backRow}>
          <button onClick={closeDetail} className={styles.backBtn}>
            <ArrowLeft className={styles.backIcon} aria-hidden="true" size={18} />
            Volver
          </button>
          <span className={styles.keysHint}>
            <kbd>←</kbd><kbd>→</kbd> navegar &nbsp; <kbd>Enter</kbd> reproducir &nbsp; <kbd>F</kbd> fuentes
          </span>
        </div>

        <h1 className={styles.showTitle}>{displayTitleOf(item)}</h1>

        <div className={styles.showMeta}>
          {(item.voteAverage ?? 0) > 0 && (
            <span className={styles.star}>★ {item.voteAverage!.toFixed(1)}</span>
          )}
          {item.year && <b>{item.year}</b>}
          {seasons.length > 0 && (
            <span>
              {seasons.length === 1 ? '1 temporada' : `${seasons.length} temporadas`}
              {' '}· {episodes.length} capitulos
            </span>
          )}
          {item.genres.length > 0 && <span>{item.genres.slice(0, 3).join(' · ')}</span>}
        </div>

        <div className={styles.ctaRow}>
          <button onClick={handlePlayHero} className={styles.ctaPlay} disabled={!firstUnwatched}>
            <Play size={26} fill="currentColor" aria-hidden="true" />
            <span className={styles.ctaTxt}>
              {ctaLabel}
              {ctaSub && <small>{ctaSub}</small>}
            </span>
          </button>
          <button
            onClick={() => firstUnwatched && void handleChooseSource(firstUnwatched)}
            className={styles.ctaSources}
            disabled={!firstUnwatched}
          >
            Fuentes
            {heroSourceCount != null && <span className={styles.ctaCount}>{heroSourceCount}</span>}
          </button>
        </div>
      </header>

      {/* Rail horizontal de episodios */}
      <section className={styles.railSection}>
        <div className={styles.railHead}>
          <h2 className={styles.railTitle}>
            {selectedSeason != null ? `Temporada ${selectedSeason}` : 'Episodios'}
          </h2>
          {seasons.length > 0 && (
            <div className={styles.bigTabs} role="tablist" aria-label="Temporadas">
              <button
                className={`${styles.bigTab} ${selectedSeason === null ? styles.bigTabActive : ''}`}
                onClick={() => setSelectedSeason(null)}
                role="tab"
                aria-selected={selectedSeason === null}
              >
                Todas
              </button>
              {seasons.map((s) => {
                const prog = watchedBySeason.get(s)
                return (
                  <button
                    key={s}
                    className={`${styles.bigTab} ${selectedSeason === s ? styles.bigTabActive : ''}`}
                    onClick={() => setSelectedSeason(s)}
                    role="tab"
                    aria-selected={selectedSeason === s}
                  >
                    T{s}
                    {prog && <span className={styles.bigTabFrac}>{prog.seen}/{prog.total}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className={styles.rail} ref={railRef} onKeyDown={handleRailKeyDown}>
          {loading ? (
            Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.cardSkeleton} aria-hidden="true" />)
          ) : error ? (
            <div className={styles.railStatus}>{error}</div>
          ) : filteredEpisodes.length === 0 ? (
            <div className={styles.railStatus}>Sin episodios</div>
          ) : (
            filteredEpisodes.map((ep, i) => {
              const key = ep.stableId ?? `${ep.seasonNumber ?? '?'}-${i}`
              const refKey = `${ep.seasonNumber ?? '?'}|${ep.episodeNumber ?? '?'}`
              const isContinue =
                !!cwEntry &&
                cwEntry.seasonNumber === ep.seasonNumber &&
                cwEntry.episodeNumber === ep.episodeNumber &&
                !cwEntry.isWatched
              const epProgress = isContinue ? continueProgress : 0
              const status = getEpisodeStatus(ep, cwEntry)
              const minutesLeft = epProgress > 0 && ep.runtimeMinutes
                ? Math.max(1, Math.round(ep.runtimeMinutes * (1 - epProgress / 100)))
                : null
              return (
                <div
                  key={key}
                  ref={(el) => registerEpisodeRef(refKey, el)}
                  data-ep-card
                  className={`${styles.card} ${isContinue ? styles.cardFocused : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { void handlePlayEpisode(ep) }}
                  onContextMenu={(e) => { e.preventDefault(); setContextEpisode(ep) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handlePlayEpisode(ep) } }}
                  aria-label={`Reproducir T${ep.seasonNumber ?? '?'} E${ep.episodeNumber ?? '?'}: ${displayTitleOf(ep)}`}
                >
                  <div className={styles.cardStill}>
                    {(ep.stillPath || ep.imageUrl) ? (
                      <img src={ep.stillPath || ep.imageUrl} alt="" className={styles.cardStillImg} loading="lazy" />
                    ) : (
                      <span className={styles.cardStillFallback}>
                        T{ep.seasonNumber ?? '?'} · E{ep.episodeNumber ?? '?'}
                      </span>
                    )}
                    {status.variant === 'watched' && (
                      <span className={styles.cardCheck} aria-label="Visto">
                        <Check size={15} strokeWidth={3.5} />
                      </span>
                    )}
                    {isContinue && epProgress > 0 && (
                      <div className={styles.cardBar} aria-hidden="true"><i style={{ width: `${epProgress}%` }} /></div>
                    )}
                    <div className={styles.cardHover} aria-hidden="true">
                      <span className={styles.cardHoverGo}><Play size={22} fill="currentColor" /></span>
                    </div>
                  </div>
                  <div className={styles.cardBody}>
                    <span className={styles.cardNum}>{ep.episodeNumber ?? i + 1}</span>
                    <span className={styles.cardTexts}>
                      <span className={styles.cardTitle}>{displayTitleOf(ep)}</span>
                      <span className={styles.cardMeta}>
                        {ep.runtimeMinutes != null && <span>{formatRuntime(ep.runtimeMinutes)}</span>}
                        {ep.hasIptvSource && <span className={styles.srcDotIptv} title="Disponible en IPTV" />}
                        {ep.hasTorrentSource && <span className={styles.srcDotTorrent} title="Disponible en Torrent" />}
                      </span>
                      {isContinue && minutesLeft != null && (
                        <span className={styles.cardLeft}>Visto al {Math.round(epProgress)} % · quedan {minutesLeft} min</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className={styles.cardSourcesBtn}
                      onClick={(e) => { e.stopPropagation(); void handleChooseSource(ep) }}
                      aria-label={`Elegir fuente de T${ep.seasonNumber ?? '?'} E${ep.episodeNumber ?? '?'}`}
                      title="Elegir fuente"
                    >
                      Fuentes
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>
      {contextEpisode && createPortal(
        <div className={styles.episodeContextMenuBackdrop} onMouseDown={() => setContextEpisode(null)}>
          <div className={styles.episodeContextMenu} role="menu" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => markEpisodesWatched([contextEpisode])}>
              Marcar este capítulo como visto
            </button>
            <button type="button" onClick={() => markEpisodesWatched(episodes.filter((ep) => ep.seasonNumber === contextEpisode.seasonNumber))}>
              Marcar toda la temporada como vista
            </button>
            <button type="button" onClick={() => markEpisodesWatched(episodes.filter((ep) =>
              (ep.seasonNumber ?? 0) < (contextEpisode.seasonNumber ?? 0) ||
              (ep.seasonNumber === contextEpisode.seasonNumber && (ep.episodeNumber ?? 0) <= (contextEpisode.episodeNumber ?? 0)),
            ))}>
              Marcar capítulos anteriores como vistos
            </button>
          </div>
        </div>,
        document.body,
      )}
      {sourceEpisode && createPortal(
        <div className={styles.sourceModalBackdrop} onMouseDown={() => setSourceEpisode(null)}>
          <div
            className={styles.sourceModal}
            role="dialog"
            aria-modal="true"
            aria-label={`Fuentes de T${sourceEpisode.seasonNumber ?? '?'} E${sourceEpisode.episodeNumber ?? '?'}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className={styles.sheetHandle} aria-hidden="true" />
            <div className={styles.sourceModalHead}>
              <div>
                <div className={styles.sourceModalEyebrow}>
                  Temporada {sourceEpisode.seasonNumber ?? '?'} · Episodio {sourceEpisode.episodeNumber ?? '?'}
                </div>
                <div className={styles.sourceModalTitle}>{displayTitleOf(sourceEpisode)}</div>
                <div className={styles.sourceModalSub}>
                  {sourceLoading
                    ? 'Buscando fuentes en Torrentio...'
                    : sourceError && sourceStreams.length === 0
                      ? 'Solo hay fuentes IPTV disponibles'
                      : `${sourceStreams.length} fuentes disponibles`}
                </div>
              </div>
              {bestTorrentIndex >= 0 && !sourceLoading && sourceStreams[bestTorrentIndex] && (
                <span className={styles.sourceModalRec}>
                  Recomendada: {qualityOf(sourceStreams[bestTorrentIndex]).toUpperCase()}
                  {sourceStreams[bestTorrentIndex].seeders != null &&
                    ` · ${sourceStreams[bestTorrentIndex].seeders} seeds`}
                </span>
              )}
              <button
                type="button"
                className={styles.sourceModalClose}
                onClick={() => setSourceEpisode(null)}
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>

            <div className={styles.sourceModalBody}>
              {sourceLoading && (
                <div className={styles.sourceModalStatus}>Buscando en Torrentio...</div>
              )}

              {!sourceLoading && sourceError && (
                <div className={styles.sourceModalStatus}>No se pudo consultar Torrentio. Mostrando fuentes IPTV.</div>
              )}

              {!sourceLoading && sourceStreams.length === 0 && (
                <div className={styles.sourceModalStatus}>Sin fuentes para este episodio.</div>
              )}

              {!sourceLoading && (() => {
                const iptvCount = sourceStreams.filter((o) => !isTorrentStream(o)).length
                return (
                  <>
                    {iptvCount > 0 && (
                      <div className={styles.sourceGroupLabel}>Directo IPTV · {iptvCount}</div>
                    )}
                    {sourceStreams.map((opt, i) => (
                      !isTorrentStream(opt) && (
                        <SourceRow
                          key={`iptv-${i}`}
                          opt={opt}
                          variant="iptv"
                          selected={selectedSource === i}
                          onSelect={() => setSelectedSource(i)}
                          onPlay={() => handlePlayFromSource(i)}
                        />
                      )
                    ))}
                    {sourceStreams.length - iptvCount > 0 && (
                      <div className={styles.sourceGroupLabel}>Torrent · {sourceStreams.length - iptvCount}</div>
                    )}
                    {sourceStreams.map((opt, i) => (
                      isTorrentStream(opt) && (
                        <SourceRow
                          key={`tor-${i}`}
                          opt={opt}
                          variant="torrent"
                          selected={selectedSource === i}
                          onSelect={() => setSelectedSource(i)}
                          onPlay={() => handlePlayFromSource(i)}
                        />
                      )
                    ))}
                  </>
                )
              })()}
            </div>

            <div className={styles.sourceModalFoot}>
              <span className={styles.sourceModalNote}>
                {selectedSource >= 0 && sourceStreams[selectedSource]
                  ? `Reproducirá: ${sourceStreams[selectedSource].torrentTitle ?? sourceStreams[selectedSource].label}`
                  : 'Elige una fuente para reproducir'}
              </span>
              <button
                type="button"
                className={styles.sourcePlayBtn}
                disabled={sourceLoading || sourceStreams.length === 0}
                onClick={() => handlePlayFromSource(selectedSource)}
              >
                <Play size={16} fill="currentColor" aria-hidden="true" />
                Reproducir
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function SourceRow({
  opt,
  variant,
  selected,
  onSelect,
  onPlay,
}: {
  opt: StreamOption
  variant: 'iptv' | 'torrent'
  selected: boolean
  onSelect: () => void
  onPlay: () => void
}) {
  const isTorrent = variant === 'torrent'
  const badge = isTorrent
    ? qualityOf(opt).toUpperCase()
    : (opt.language ?? 'ES').toUpperCase()
  return (
    <div
      className={`${styles.sourceRow} ${selected ? styles.sourceRowSelected : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay() }
      }}
    >
      <span className={styles.sourceRowQ}>{badge}</span>

      <span className={styles.sourceRowTitle}>{opt.torrentTitle ?? opt.label ?? 'Directo'}</span>

      <span className={styles.sourceRowMeta}>
        {opt.seeders != null && (
          <span className={styles.sourceSeeds}>{opt.seeders} seeds</span>
        )}
        {opt.sizeBytes != null && (
          <span className={styles.sourceSize}>{formatSize(opt.sizeBytes)}</span>
        )}
        {isTorrent && opt.language && (
          <span className={styles.sourceLangTag}>{opt.language}</span>
        )}
        {!isTorrent && (
          <span className={styles.sourceLiveTag}>EN DIRECTO</span>
        )}
      </span>

      <span className={styles.sourceRowPlay} role="button" tabIndex={0} aria-label={`Reproducir ${opt.torrentTitle ?? opt.label ?? 'fuente'}`}
        onClick={(e) => { e.stopPropagation(); onPlay() }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPlay() } }}>
        {selected ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        )}
      </span>
    </div>
  )
}
