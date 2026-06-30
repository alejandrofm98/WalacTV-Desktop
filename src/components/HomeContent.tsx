import { useMemo, useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SectionRow } from './SectionRow'
import { getContentById, getSeriesEpisodes, cwGroupKey, removeWatchProgress } from '../api/client'
import type { CatalogItem, BrowseSection, WatchProgressItem } from '../api/types'
import styles from './HomeContent.module.css'

export function HomeContent() {
  const { homeSections, selectedHero, continueWatchingEntries, openPlayer, openDetail, removeContinueWatchingEntry } = useAppStore()

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

  const handleCardClick = useCallback(async (item: CatalogItem) => {
    const cwKey = cwGroupKey(
      item.kind === 'SERIES' ? 'series' : 'movie',
      item.seriesName,
      item.stableId,
    )
    const cw = continueWatchingEntries.get(cwKey)
      ?? continueWatchingEntries.get(item.stableId)
      ?? continueWatchingEntries.get(item.providerId ?? '')
    if (cw) {
      let fullItem: CatalogItem | null = null
      if (item.kind === 'SERIES' && cw.seriesName) {
        try {
          const { episodes } = await getSeriesEpisodes(cw.contentId)
          fullItem = episodes.find(
            (ep) => ep.seasonNumber === cw.seasonNumber && ep.episodeNumber === cw.episodeNumber
          ) ?? null
        } catch {}
      }
      if (!fullItem) {
        fullItem = await getContentById(cw.contentId)
      }
      if (fullItem && fullItem.streamOptions.length > 0) {
        openPlayer(fullItem, 0, cw.positionMs)
        return
      }
    }
    if (item.kind === 'MOVIE' || item.kind === 'SERIES') {
      const detailItem = cw ? { ...item, stableId: cw.contentId } : item
      openDetail(detailItem)
    } else {
      openPlayer(item)
    }
  }, [continueWatchingEntries, openPlayer, openDetail])

  const handleCwViewDetail = useCallback((item: CatalogItem, entry: WatchProgressItem) => {
    if (item.kind === 'SERIES') {
      openDetail({ ...item, stableId: entry.contentId })
      return
    }
    openDetail(item)
  }, [openDetail])

  const handleCwRemove = useCallback((entry: WatchProgressItem) => {
    const cwKey = cwGroupKey(entry.contentType, entry.seriesName, entry.contentId)
    removeContinueWatchingEntry(cwKey)
    removeWatchProgress(entry.contentId).catch((err) => {
      console.error('removeWatchProgress failed', err)
    })
  }, [removeContinueWatchingEntry])

  // Build continue watching section from entries if backend doesn't provide one
  const cwSection = homeSections.find((s) => s.title === 'Continuar viendo')
  const syntheticCwSection = useMemo<BrowseSection | null>(() => {
    if (cwSection) return null
    if (continueWatchingEntries.size === 0) return null
    const items: CatalogItem[] = [...continueWatchingEntries.values()].map((e) => ({
      stableId: cwGroupKey(e.contentType, e.seriesName, e.contentId),
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
            onCwRemove={handleCwRemove}
          />
        )}
        {otherSections.map((s, i) => (
          <SectionRow key={`${s.title}-${i}`} section={s} onCardClick={handleCardClick} onCardHover={handleCardHover} />
        ))}
      </div>
    </div>
  )
}
