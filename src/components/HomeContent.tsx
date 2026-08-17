import { useMemo, useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SectionRow } from './SectionRow'
import { getContentById, getSeriesEpisodes, cwGroupKey, markSeriesEpisodesWatched, markWatched, saveWatchProgress, getAllSeriesEpisodes, getHomeContinueWatching, getWatchedItems, applyWatchedState, removeWatchProgress } from '../api/client'
import type { CatalogItem, BrowseSection, WatchProgressItem } from '../api/types'
import { pickFirstUnwatched } from '../utils/series'
import styles from './HomeContent.module.css'

export function HomeContent() {
  const { homeSections, selectedHero, continueWatchingEntries, openPlayer, openDetail, removeContinueWatchingEntry, setContinueWatching, setHomeSections } = useAppStore()

  const [hoveredHero, setHoveredHero] = useState<CatalogItem | null>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const defaultHero = useMemo(() => {
    const allVod = homeSections
      .flatMap((s) => s.items)
      .filter((i) => i.kind === 'MOVIE' || i.kind === 'SERIES')
    return allVod.length > 0 ? allVod[Math.floor(Math.random() * allVod.length)] : null
  }, [homeSections])

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    }
  }, [])

  const handleCardHover = useCallback((item: CatalogItem) => {
    if (item.kind !== 'MOVIE' && item.kind !== 'SERIES') return
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredHero(item)
    }, 150)
  }, [])

  const handleCardHoverEnd = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredHero(null)
    }, 150)
  }, [])

  const displayHero = hoveredHero ?? defaultHero ?? selectedHero

  const handleCardClick = useCallback(async (item: CatalogItem, startOver = false) => {
    const cwKey = cwGroupKey(
      item.kind === 'SERIES' ? 'series' : 'movie',
      item.seriesName,
      item.stableId,
    )
    const cw = continueWatchingEntries.get(cwKey)
      ?? continueWatchingEntries.get(item.stableId)
      ?? continueWatchingEntries.get(item.providerId ?? '')
    // ── Continue-watching flow ──────────────────────────────
    let fullItem: CatalogItem | null = null
    if (cw) {
      // For series, try fetching the specific episode from the series catalog
      if (item.kind === 'SERIES' && cw.seriesName) {
        try {
          const { episodes } = await getSeriesEpisodes(cw.contentId)
          fullItem = episodes.find(
            (ep) => ep.seasonNumber === cw.seasonNumber && ep.episodeNumber === cw.episodeNumber
          ) ?? null
        } catch {
          // getSeriesEpisodes may fail if cw.contentId is an episode ID, not a series ID
          // Fallback to getContentById below
        }
      }
      // Fetch the full item from the content API with the correct URL pattern
      if (!fullItem) {
        fullItem = await getContentById(
          item.kind === 'SERIES' ? 'series' : 'movies',
          cw.contentId,
        )
      }
      if (fullItem && fullItem.streamOptions.length > 0) {
        openPlayer(fullItem, 0, startOver ? 0 : cw.positionMs)
        return
      }
    }

    // ── Fallback: open detail or play directly ──────────────
    if (fullItem) {
      // We have a real item from the API (even without streamOptions) — prefer it
      if (fullItem.kind === 'MOVIE' || fullItem.kind === 'SERIES') {
        openDetail(fullItem)
      } else {
        openPlayer(fullItem)
      }
    } else if (item.kind === 'MOVIE' || item.kind === 'SERIES') {
      const detailItem = cw ? { ...item, stableId: cw.contentId } : item
      openDetail(detailItem)
    } else {
      openPlayer(item)
    }
  }, [continueWatchingEntries, openPlayer, openDetail])

  const refreshWatchedState = useCallback(async () => {
    try {
      const watched = await getWatchedItems(500)
      setHomeSections(applyWatchedState(useAppStore.getState().homeSections, watched.items))
    } catch (err) {
      console.error('refresh watched state failed', err)
    }
  }, [setHomeSections])

  const handleCatalogMarkWatched = useCallback(async (item: CatalogItem) => {
    try {
      if (item.kind === 'SERIES') {
        const episodes = await getAllSeriesEpisodes(item.stableId)
        await markSeriesEpisodesWatched(item.stableId, episodes)
      } else {
        await markWatched(item.stableId)
      }
      const { items } = await getHomeContinueWatching(20)
      const map = new Map<string, WatchProgressItem>()
      for (const entry of items) {
        const key = cwGroupKey(entry.contentType, entry.seriesName, entry.contentId)
        if (!map.has(key)) map.set(key, entry)
      }
      setContinueWatching(map)
      refreshWatchedState()
    } catch (err) {
      console.error('mark catalog item watched failed', err)
    }
  }, [setContinueWatching, refreshWatchedState])

  const handleCwViewDetail = useCallback((item: CatalogItem, entry: WatchProgressItem) => {
    openDetail({ ...item, stableId: entry.contentId, catalogId: entry.contentId })
  }, [openDetail])

  const handleCwMarkWatched = useCallback(async (entry: WatchProgressItem) => {
    const cwKey = cwGroupKey(entry.contentType, entry.seriesName, entry.contentId)
    removeContinueWatchingEntry(cwKey)

    const isSeries = entry.contentType === 'series' && entry.seriesName
    if (isSeries && entry.seasonNumber != null && entry.episodeNumber != null) {
      const season = entry.seasonNumber
      const episode = entry.episodeNumber

      await markWatched(entry.contentId, season, episode).catch((err) =>
        console.error('markWatched failed', err),
      )

      const episodes = await getAllSeriesEpisodes(entry.contentId).catch(() => [] as CatalogItem[])
      const next = pickFirstUnwatched(episodes, season, episode)

      if (next) {
        const FALLBACK_EPISODE_DURATION_MS = 45 * 60_000
        const nextDurationMs = (next.runtimeMinutes ?? entry.runtimeMinutes ?? 0) * 60_000
        const finalDurationMs = nextDurationMs > 0 ? nextDurationMs : (entry.durationMs > 0 ? entry.durationMs : FALLBACK_EPISODE_DURATION_MS)
        await saveWatchProgress(entry.contentId, {
          content_type: 'series',
          position_ms: 1000,
          duration_ms: finalDurationMs,
          series_name: entry.seriesName,
          season_number: next.seasonNumber,
          episode_number: next.episodeNumber,
          title: next.title,
          image_url: next.imageUrl,
        }).catch((err) => console.error('saveWatchProgress next episode failed', err))
      }
    } else {
      await markWatched(entry.contentId).catch((err) =>
        console.error('markWatched failed', err),
      )
    }

    try {
      const { items } = await getHomeContinueWatching(20)
      const map = new Map<string, WatchProgressItem>()
      for (const item of items) {
        const key = cwGroupKey(item.contentType, item.seriesName, item.contentId)
        if (!map.has(key)) map.set(key, item)
      }
      setContinueWatching(map)
      refreshWatchedState()
    } catch (err) {
      console.error('CW reload failed', err)
    }
  }, [removeContinueWatchingEntry, setContinueWatching, refreshWatchedState])

  const handleCwRemove = useCallback(async (entry: WatchProgressItem) => {
    const cwKey = cwGroupKey(entry.contentType, entry.seriesName, entry.contentId)
    removeContinueWatchingEntry(cwKey)
    await removeWatchProgress(entry.contentId).catch((err) =>
      console.error('removeWatchProgress failed', err),
    )
    try {
      const { items } = await getHomeContinueWatching(20)
      const map = new Map<string, WatchProgressItem>()
      for (const item of items) {
        const key = cwGroupKey(item.contentType, item.seriesName, item.contentId)
        if (!map.has(key)) map.set(key, item)
      }
      setContinueWatching(map)
      refreshWatchedState()
    } catch (err) {
      console.error('CW reload failed', err)
    }
  }, [removeContinueWatchingEntry, setContinueWatching, refreshWatchedState])


  // Build continue watching section from entries if backend doesn't provide one
  const cwSection = homeSections.find((s) => s.title === 'Continuar viendo')
  const syntheticCwSection = useMemo<BrowseSection | null>(() => {
    if (cwSection) return null
    if (continueWatchingEntries.size === 0) return null
    const items: CatalogItem[] = [...continueWatchingEntries.values()].map((e) => ({
      stableId: cwGroupKey(e.contentType, e.seriesName, e.contentId),
      catalogId: e.contentId,
      imdbId: e.imdbId ?? null,
      title: e.title,
      subtitle: e.seriesName || '',
      seriesName: e.seriesName || null,
      description: e.overview ?? '',
      imageUrl: e.imageUrl,
      tmdbPosterUrl: e.tmdbPosterUrl,
      backdropUrl: e.backdropUrl,
      kind: (e.contentType === 'series' ? 'SERIES' : 'MOVIE') as CatalogItem['kind'],
      group: '',
      badgeText: '',
      streamOptions: [],
      genres: e.genres ?? [],
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
      tmdbTitle: e.tmdbTitle,
      voteAverage: e.voteAverage,
      voteCount: e.voteCount,
      runtimeMinutes: e.runtimeMinutes,
      year: e.year,
      totalSeasons: e.totalSeasons,
      tagline: e.tagline,
      releaseDate: e.releaseDate,
    }))
    return { title: 'Continuar viendo', items, currentPage: 1, hasNextPage: false }
  }, [cwSection, continueWatchingEntries])

  const activeCwSection = cwSection ?? syntheticCwSection
  const otherSections = homeSections.filter((s) => s.title !== 'Continuar viendo')

  return (
    <div className={styles.container}>
      {/* Hero backdrop */}
      <div className={styles.hero}>
        {displayHero?.backdropUrl ? (
          <img src={displayHero.backdropUrl} alt="" className={styles.heroImage} />
        ) : displayHero?.tmdbPosterUrl || displayHero?.imageUrl ? (
          <img src={displayHero.tmdbPosterUrl || displayHero.imageUrl} alt="" className={styles.heroImage} />
        ) : (
          <div className={styles.heroFallback} />
        )}

        {/* Gradient overlays */}
        <div className={styles.heroGradientLeft} />
        <div className={styles.heroGradientBottom} />

        {/* Hero text */}
        <div className={styles.heroText}>
          <h1 className={styles.heroTitle}>
            {(displayHero?.tmdbTitle ?? displayHero?.title) || 'WalacTV'}
          </h1>

          {(displayHero?.voteAverage ?? 0) > 0 && (
            <div className={styles.metaRow}>
              <span className={styles.ratingBadge}>
                ★ {displayHero!.voteAverage!.toFixed(1)}
              </span>
              {displayHero!.year && (
                <>
                  <span className={styles.metaSep} />
                  <span className={styles.metaText}>{displayHero!.year}</span>
                </>
              )}
              {displayHero!.runtimeMinutes && (
                <>
                  <span className={styles.metaSep} />
                  <span className={styles.metaText}>
                    {Math.floor(displayHero!.runtimeMinutes / 60)}h {displayHero!.runtimeMinutes % 60}min
                  </span>
                </>
              )}
              {displayHero!.kind === 'SERIES' && displayHero!.totalSeasons && (
                <>
                  <span className={styles.metaSep} />
                  <span className={styles.metaText}>
                    {displayHero!.totalSeasons === 1 ? '1 temporada' : `${displayHero!.totalSeasons} temporadas`}
                  </span>
                </>
              )}
            </div>
          )}

          {displayHero && displayHero.genres.length > 0 && (
            <div className={styles.genreRow}>
              {displayHero.genres.slice(0, 5).map((g) => (
                <span key={g} className={styles.genreTag}>{g}</span>
              ))}
            </div>
          )}

          {displayHero?.description && (
            <p className={styles.heroDescription}>
              {displayHero.description}
            </p>
          )}
        </div>
      </div>

      {/* Sections */}
      <div className={styles.sections} onMouseLeave={handleCardHoverEnd}>
        {activeCwSection && (
          <SectionRow
            section={activeCwSection}
            onCardClick={handleCardClick}
            onCardHover={handleCardHover}
            continueWatching={continueWatchingEntries}
            onCwViewDetail={handleCwViewDetail}
            onCwMarkWatched={handleCwMarkWatched}
            onCwRemove={handleCwRemove}
            onCwStartOver={(item) => handleCardClick(item, true)}
            onMarkWatched={handleCatalogMarkWatched}
          />
        )}
        {otherSections.map((s, i) => (
          <SectionRow key={`${s.title}-${i}`} section={s} onCardClick={handleCardClick} onCardHover={handleCardHover} onMarkWatched={handleCatalogMarkWatched} />
        ))}
      </div>
    </div>
  )
}
