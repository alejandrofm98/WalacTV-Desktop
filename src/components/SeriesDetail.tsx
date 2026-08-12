import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Play, ChevronDown, ArrowLeft } from 'lucide-react'
import type { CatalogItem, WatchProgressItem } from '../api/types'
import { getAllSeriesEpisodes, getWatchProgress, markSeriesEpisodesWatched, cwGroupKey } from '../api/client'
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
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [contextEpisode, setContextEpisode] = useState<CatalogItem | null>(null)

  const seriesId = item.stableId || item.seriesName || item.normalizedTitle || item.title
  const preselectedRef = useRef(false)
  const wasPlayingRef = useRef(false)
  const episodeRefs = useRef<Map<string, HTMLElement>>(new Map())
  const dropdownRef = useRef<HTMLDivElement>(null)

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

  const handlePlayHero = useCallback(() => {
    if (firstUnwatched) openPlayer(firstUnwatched)
  }, [firstUnwatched, openPlayer])

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

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  useEffect(() => {
    if (!contextEpisode) return
    const close = () => setContextEpisode(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextEpisode])

  const selectedSeasonLabel = selectedSeason != null
    ? `Temporada ${selectedSeason}`
    : seasons.length > 0
      ? 'Todas'
      : ''

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

      {/* Season Selector + Episodes */}
      <div className={styles.episodesSection}>
        {seasons.length > 0 && (
          <div className={styles.seasonSelector} ref={dropdownRef}>
            <button
              className={styles.seasonDropdown}
              onClick={() => setDropdownOpen(!dropdownOpen)}
              aria-expanded={dropdownOpen}
              aria-haspopup="listbox"
            >
              <span className={styles.seasonDropdownText}>{selectedSeasonLabel}</span>
              <ChevronDown className={styles.seasonChevron} aria-hidden="true" size={20} />
            </button>
            {dropdownOpen && (
              <ul className={styles.seasonMenu} role="listbox">
                <li
                  className={`${styles.seasonOption} ${selectedSeason === null ? styles.seasonOptionActive : ''}`}
                  role="option"
                  aria-selected={selectedSeason === null}
                  onClick={() => { setSelectedSeason(null); setDropdownOpen(false) }}
                >
                  Todas
                </li>
                {seasons.map((s) => {
                  const prog = watchedBySeason.get(s)
                  const suffix = prog ? ` (${prog.seen}/${prog.total})` : ''
                  return (
                    <li
                      key={s}
                      className={`${styles.seasonOption} ${selectedSeason === s ? styles.seasonOptionActive : ''}`}
                      role="option"
                      aria-selected={selectedSeason === s}
                      onClick={() => { setSelectedSeason(s); setDropdownOpen(false) }}
                    >
                      Temporada {s}{suffix}
                    </li>
                  )
                })}
              </ul>
            )}
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
                    onClick={() => openPlayer(ep, 0, isContinue ? cwEntry.positionMs : 0)}
                    onContextMenu={(e) => { e.preventDefault(); setContextEpisode(ep) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openPlayer(ep, 0, isContinue ? cwEntry.positionMs : 0)
                      }
                    }}
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
                      </div>
                      {ep.description && (
                        <p className={styles.episodeDescription}>{ep.description}</p>
                      )}
                    </div>

                    <div className={styles.episodeRight}>
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
    </div>
  )
}
