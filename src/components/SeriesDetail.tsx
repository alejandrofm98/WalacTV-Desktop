import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Play, ArrowLeft } from 'lucide-react'
import type { CatalogItem, StreamOption, WatchProgressItem } from '../api/types'
import { getAllSeriesEpisodes, getWatchProgress, markSeriesEpisodesWatched, cwGroupKey, getTorrentioEpisodeStreams } from '../api/client'
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

function formatAirDate(raw: string): string {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  return d.toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' })
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

function qualityRank(q: string): number {
  return q === '2160p' ? 4 : q === '1080p' ? 3 : q === '720p' ? 2 : 1
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

  const seriesId = item.stableId || item.seriesName || item.normalizedTitle || item.title
  const preselectedRef = useRef(false)
  const wasPlayingRef = useRef(false)
  const episodeRefs = useRef<Map<string, HTMLElement>>(new Map())

  const fetchEpisodes = useCallback(() => {
    if (!seriesId) return
    setLoading(true)
    setError(null)
    return getAllSeriesEpisodes(seriesId)
      .then((eps) => {
        setEpisodes(eps ?? [])
        if (!preselectedRef.current) {
          preselectedRef.current = true
          const cw = computeCwEntry(item, useAppStore.getState().continueWatchingEntries)
          const loaded = eps ?? []
          const seasonsArr = [...new Set(loaded.map((e) => e.seasonNumber).filter(Boolean))] as number[]
          if (cw?.seasonNumber != null && seasonsArr.includes(cw.seasonNumber)) {
            setSelectedSeason(cw.seasonNumber)
          }
        }
      })
      .catch(() => setError('No se pudieron cargar los episodios'))
      .finally(() => setLoading(false))
  }, [item, seriesId])

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
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        el.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [cwEntry, selectedSeason, episodes])

  const playerItem = useAppStore((s) => s.playerItem)
  useEffect(() => {
    const playing = !!playerItem
    if (wasPlayingRef.current && !playing) {
      fetchEpisodes()
    }
    wasPlayingRef.current = playing
  }, [playerItem, fetchEpisodes])

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

  // Reproduccion directa: mezcla Torrentio con los streams del episodio y abre
  // el player. La fila del episodio reproduce el mejor stream disponible.
  const handlePlayEpisode = useCallback(async (episode: CatalogItem) => {
    if (episode.seasonNumber != null && episode.episodeNumber != null) {
      try {
        const streams = await getTorrentioEpisodeStreams(
          item.imdbId ?? item.catalogId ?? item.stableId,
          episode.seasonNumber,
          episode.episodeNumber,
        )
        openPlayer({ ...episode, streamOptions: [...episode.streamOptions, ...streams] })
        return
      } catch {
        // IPTV playback remains available when Torrentio is unavailable.
      }
    }
    openPlayer(episode)
  }, [item, openPlayer])

  // Abre el modal de fuentes para el episodio: consulta Torrentio y combina
  // con los streams IPTV del episodio. La mejor fuente queda preseleccionada.
  const handleChooseSource = useCallback(async (episode: CatalogItem) => {
    setSourceEpisode(episode)
    setSelectedSource(0)
    setSourceStreams([])
    setSourceError(false)
    setSourceLoading(true)
    const iptv = episode.streamOptions.filter((o) => !isTorrentStream(o))
    const base = [...iptv, ...episode.streamOptions.filter(isTorrentStream)]
    if (episode.seasonNumber != null && episode.episodeNumber != null) {
      try {
        const torrents = await getTorrentioEpisodeStreams(
          item.imdbId ?? item.catalogId ?? item.stableId,
          episode.seasonNumber,
          episode.episodeNumber,
        )
        setSourceStreams([...base, ...torrents])
      } catch {
        setSourceStreams(base)
        setSourceError(true)
      }
    } else {
      setSourceStreams(base)
      setSourceError(true)
    }
    setSourceLoading(false)
  }, [item])

  const bestTorrentIndex = useMemo(() => {
    if (sourceStreams.length === 0) return -1
    const torrents = sourceStreams.filter(isTorrentStream)
    if (torrents.length === 0) return -1
    const best = [...torrents].sort(
      (a, b) =>
        qualityRank(qualityOf(b)) - qualityRank(qualityOf(a)) ||
        (b.seeders ?? 0) - (a.seeders ?? 0),
    )[0]
    return sourceStreams.indexOf(best)
  }, [sourceStreams])

  // Preselecciona la mejor fuente (calidad + seeds) cuando se abre el modal.
  useEffect(() => {
    if (!sourceLoading && sourceStreams.length > 0 && bestTorrentIndex >= 0 && selectedSource === 0) {
      setSelectedSource(bestTorrentIndex)
    }
  }, [sourceLoading, sourceStreams, bestTorrentIndex, selectedSource])

  // Cierra el modal con Escape
  useEffect(() => {
    if (!sourceEpisode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSourceEpisode(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sourceEpisode])

  // La fila del episodio reproduce directo; el botón de fuentes abre el modal.
  // sourceStreams ya incluye IPTV + torrents del episodio + Torrentio, así que
  // el índice elegido en el modal coincide con el array que recibe el player.
  const handlePlayFromSource = useCallback((index: number) => {
    if (!sourceEpisode) return
    openPlayer({ ...sourceEpisode, streamOptions: sourceStreams }, index)
    setSourceEpisode(null)
  }, [sourceEpisode, sourceStreams, openPlayer])

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

  const heroLabel = firstUnwatched
    ? `Reproducir T${firstUnwatched.seasonNumber ?? '?'} E${firstUnwatched.episodeNumber ?? '?'}`
    : 'Reproducir'

  return (
    <div className={styles.container}>
      {/* Hero Section */}
      <div className={styles.hero}>
        {(item.backdropUrl || item.tmdbPosterUrl || item.imageUrl) ? (
          <img src={item.backdropUrl || item.tmdbPosterUrl || item.imageUrl} alt="" className={styles.heroImage} />
        ) : (
          <div className={styles.heroFallback} />
        )}
        <div className={styles.heroGradientLeft} />
        <div className={styles.heroGradientBottom} />
        <div className={styles.heroVignette} />

        <button onClick={closeDetail} className={styles.backBtn}>
          <ArrowLeft className={styles.backIcon} aria-hidden="true" size={20} /> 
          Volver
        </button>

        <div className={styles.heroInfo}>
          <h1 className={styles.heroTitle}>{item.tmdbTitle ?? item.title}</h1>

          <div className={styles.heroMetaRow}>
            {(item.voteAverage ?? 0) > 0 && (
              <span className={styles.ratingBadge}>
                ★ {item.voteAverage!.toFixed(1)}
              </span>
            )}
            {item.year && <span className={styles.metaItem}>{item.year}</span>}
            {item.genres.length > 0 && (
              <span className={styles.metaItem}>{item.genres.slice(0, 3).join(' \u2022 ')}</span>
            )}
            {item.totalSeasons != null && (
              <span className={styles.metaItem}>
                {item.totalSeasons === 1 ? '1 temporada' : `${item.totalSeasons} temporadas`}
              </span>
            )}
          </div>

          {item.description && (
            <p className={styles.heroDescription}>{item.description}</p>
          )}

          <button onClick={handlePlayHero} className={styles.heroPlayBtn} disabled={!firstUnwatched}>
            <Play className={styles.heroPlayIcon} aria-hidden="true" fill="currentColor" size={24} />
            {heroLabel}
          </button>
        </div>
      </div>

      {/* Season Tabs + Episodes */}
      <div className={styles.episodesSection}>
        {seasons.length > 0 && (
          <div className={styles.seasonTabs} role="tablist" aria-label="Temporadas">
            <button
              className={`${styles.seasonTab} ${selectedSeason === null ? styles.seasonTabActive : ''}`}
              onClick={() => setSelectedSeason(null)}
              role="tab"
              aria-selected={selectedSeason === null}
            >
              Todas
            </button>
            {seasons.map((s) => {
              const prog = watchedBySeason.get(s)
              const suffix = prog ? ` ${prog.seen}/${prog.total}` : ''
              return (
                <button
                  key={s}
                  className={`${styles.seasonTab} ${selectedSeason === s ? styles.seasonTabActive : ''}`}
                  onClick={() => setSelectedSeason(s)}
                  role="tab"
                  aria-selected={selectedSeason === s}
                >
                  T{s}{suffix}
                </button>
              )
            })}
          </div>
        )}

        <div className={styles.episodesScroll}>
          {loading ? (
            <div className={styles.statusMessage}>Cargando episodios...</div>
          ) : error ? (
            <div className={styles.statusMessage}>{error}</div>
          ) : filteredEpisodes.length === 0 ? (
            <div className={styles.statusMessage}>Sin episodios</div>
          ) : (
            <div className={styles.episodeList}>
              {filteredEpisodes.map((ep, i) => {
                const key = ep.stableId ?? `${ep.seasonNumber ?? '?'}-${i}`
                const refKey = `${ep.seasonNumber ?? '?'}|${ep.episodeNumber ?? '?'}`
                const isContinue =
                  !!cwEntry &&
                  cwEntry.seasonNumber === ep.seasonNumber &&
                  cwEntry.episodeNumber === ep.episodeNumber &&
                  !cwEntry.isWatched
                const epProgress = isContinue ? continueProgress : 0
                const status = getEpisodeStatus(ep, cwEntry)
                return (
                  <div
                    key={key}
                    ref={(el) => registerEpisodeRef(refKey, el)}
                    className={`${styles.episodeRow} ${isContinue ? styles.episodeRowActive : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => { void handlePlayEpisode(ep) }}
                    onContextMenu={(e) => { e.preventDefault(); setContextEpisode(ep) }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void handlePlayEpisode(ep) } }}
                    aria-label={`Reproducir T${ep.seasonNumber ?? '?'} E${ep.episodeNumber ?? '?'}: ${ep.tmdbTitle ?? ep.title}`}
                  >
                    <div className={styles.episodeNumberLeft}>{ep.episodeNumber ?? i + 1}</div>

                    <div className={styles.episodeThumbWrap}>
                      {(ep.stillPath || ep.imageUrl) ? (
                        <img src={ep.stillPath || ep.imageUrl} alt="" className={styles.episodeThumb} />
                      ) : (
                        <div className={styles.episodeThumbPlaceholder}>TV</div>
                      )}
                      <div className={styles.playOverlay} aria-hidden="true">
                        <Play size={24} fill="currentColor" />
                      </div>
                    </div>

                    <div className={styles.episodeInfo}>
                      <div className={styles.episodeTitle}>{ep.tmdbTitle ?? ep.title}</div>
                      <div className={styles.episodeMeta}>
                        {(ep.voteAverage ?? 0) > 0 && (
                          <span className={styles.ratingBadge}>
                            ★ {ep.voteAverage!.toFixed(1)}
                          </span>
                        )}
                        {ep.runtimeMinutes != null && (
                          <span className={styles.episodeDuration}>{formatRuntime(ep.runtimeMinutes)}</span>
                        )}
                        {(ep.airDate ?? ep.releaseDate) && (
                          <span className={styles.episodeAirDate}>{formatAirDate(ep.airDate ?? ep.releaseDate!)}</span>
                        )}
                        {ep.hasTorrentSource && (
                          <span className={styles.sourceChipTorrent}>
                            <span className={styles.sourceChipDot} />Torrent
                          </span>
                        )}
                        {ep.hasIptvSource && (
                          <span className={styles.sourceChipIptv}>
                            <span className={styles.sourceChipDot} />IPTV
                          </span>
                        )}
                      </div>
                      {ep.description && (
                        <p className={styles.episodeDescription}>{ep.description}</p>
                      )}
                    </div>

                    <div className={styles.episodeRight}>
                      <button
                        type="button"
                        className={styles.sourceBtn}
                        onClick={(e) => { e.stopPropagation(); void handleChooseSource(ep) }}
                        aria-label={`Elegir fuente de T${ep.seasonNumber ?? '?'} E${ep.episodeNumber ?? '?'}`}
                        title="Elegir fuente"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                        Fuentes
                      </button>
                      {isContinue && epProgress > 0 && (
                        <div className={styles.progressTrack} aria-hidden="true">
                          <div className={styles.progressFillRight} style={{ width: `${epProgress}%` }} />
                        </div>
                      )}
                      
                      <div className={styles.episodeStatus}>
                        {status.variant === 'watched' && (
                          <span className={styles.statusWatched}>
                            <span className={styles.statusLabel}>Visto</span>
                            <span className={styles.statusBadge} aria-hidden="true">
                              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </span>
                          </span>
                        )}
                        {status.variant === 'inProgress' && epProgress > 0 && (
                          <span className={styles.statusInProgress}>
                            <span className={styles.statusLabel}>
                              {ep.runtimeMinutes ? `${Math.round(ep.runtimeMinutes * (1 - epProgress / 100))} min restantes` : 'En reproduccion'}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
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
            <div className={styles.sourceModalHead}>
              <div className={styles.sourceModalEyebrow}>
                Temporada {sourceEpisode.seasonNumber ?? '?'} · Episodio {sourceEpisode.episodeNumber ?? '?'}
              </div>
              <div className={styles.sourceModalTitle}>{sourceEpisode.tmdbTitle ?? sourceEpisode.title}</div>
              <div className={styles.sourceModalSub}>
                {sourceLoading
                  ? 'Buscando fuentes en Torrentio...'
                  : sourceError && sourceStreams.length === 0
                    ? 'Solo hay fuentes IPTV disponibles'
                    : `${sourceStreams.length} fuentes disponibles`}
              </div>
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
                      <>
                        <div className={`${styles.sourceGroupLabel} ${styles.sourceGroupLabelIptv}`}>
                          <span className={styles.sourceGroupBar} />
                          Directo IPTV
                        </div>
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
                      </>
                    )}
                    {sourceStreams.length - iptvCount > 0 && (
                      <>
                        <div className={`${styles.sourceGroupLabel} ${styles.sourceGroupLabelTorrent}`}>
                          <span className={styles.sourceGroupBar} />
                          Torrent
                        </div>
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
                    )}
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
      <span className={`${styles.sourceRowIcon} ${isTorrent ? styles.sourceRowIconTorrent : styles.sourceRowIconIptv}`}>
        {isTorrent ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M16 3v4M8 3v4" /></svg>
        )}
      </span>

      <span className={styles.sourceRowTitle}>{opt.torrentTitle ?? opt.label ?? 'Directo'}</span>

      <span className={styles.sourceRowMeta}>
        {!isTorrent && opt.language && (
          <span className={styles.sourceLangTag}>{opt.language}</span>
        )}
        {qualityOf(opt) !== 'SD' && (
          <span className={styles.sourceQualityBadge}>{qualityOf(opt)}</span>
        )}
        {opt.seeders != null && (
          <span className={styles.sourceSeeds}>{opt.seeders}</span>
        )}
        {opt.sizeBytes != null && (
          <span className={styles.sourceSize}>{formatSize(opt.sizeBytes)}</span>
        )}
        {!isTorrent && (
          <span className={styles.sourceLiveTag}>EN DIRECTO</span>
        )}
      </span>

      <span className={styles.sourceRowPlay} onClick={(e) => { e.stopPropagation(); onPlay() }}>
        {selected ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        )}
      </span>
    </div>
  )
}
