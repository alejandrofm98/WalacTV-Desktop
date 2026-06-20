import { useMemo, useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'
import { SectionRow } from './SectionRow'
import { getContentById, getSeriesEpisodes } from '../api/client'
import type { CatalogItem, BrowseSection } from '../api/types'
import styles from './HomeContent.module.css'

export function HomeContent() {
  const { homeSections, selectedHero, continueWatchingEntries, openPlayer, openDetail } = useAppStore()

  const handleCardClick = useCallback(async (item: CatalogItem) => {
    const cw = continueWatchingEntries.get(item.stableId)
    if (cw) {
      let fullItem: CatalogItem | null = null
      if (item.kind === 'SERIES' && cw.seriesName) {
        try {
          const { episodes } = await getSeriesEpisodes(cw.seriesName)
          fullItem = episodes.find(
            (ep) => ep.seasonNumber === cw.seasonNumber && ep.episodeNumber === cw.episodeNumber
          ) ?? null
        } catch {}
      }
      if (!fullItem) {
        fullItem = await getContentById(item.stableId)
      }
      if (fullItem && fullItem.streamOptions.length > 0) {
        openPlayer(fullItem, 0, cw.positionMs)
        return
      }
    }
    if (item.kind === 'MOVIE' || item.kind === 'SERIES') {
      openDetail(item)
    } else {
      openPlayer(item)
    }
  }, [continueWatchingEntries, openPlayer, openDetail])

  // Build continue watching section from entries if backend doesn't provide one
  const cwSection = homeSections.find((s) => s.title === 'Continuar viendo')
  const syntheticCwSection = useMemo<BrowseSection | null>(() => {
    if (cwSection) return null
    if (continueWatchingEntries.size === 0) return null
    const items: CatalogItem[] = [...continueWatchingEntries.values()].map((e) => ({
      stableId: e.contentId,
      title: e.title,
      subtitle: e.seriesName || '',
      description: '',
      imageUrl: e.imageUrl,
      kind: (e.contentType === 'series' ? 'SERIES' : 'MOVIE') as CatalogItem['kind'],
      group: '',
      badgeText: '',
      streamOptions: [],
      genres: [],
      seasonNumber: e.seasonNumber,
      episodeNumber: e.episodeNumber,
    }))
    return { title: 'Continuar viendo', items, currentPage: 1, hasNextPage: false }
  }, [cwSection, continueWatchingEntries])

  const activeCwSection = cwSection ?? syntheticCwSection
  const otherSections = homeSections.filter((s) => s.title !== 'Continuar viendo')

  return (
    <div className={styles.container}>
      {/* Hero backdrop */}
      <div className={styles.hero}>
        {selectedHero?.backdropUrl ? (
          <img src={selectedHero.backdropUrl} alt="" className={styles.heroImage} />
        ) : selectedHero?.tmdbPosterUrl || selectedHero?.imageUrl ? (
          <img src={selectedHero.tmdbPosterUrl || selectedHero.imageUrl} alt="" className={styles.heroImage} />
        ) : (
          <div className={styles.heroFallback} />
        )}

        {/* Gradient overlays */}
        <div className={styles.heroGradientLeft} />
        <div className={styles.heroGradientBottom} />

        {/* Hero text */}
        <div className={styles.heroText}>
          <h1 className={styles.heroTitle}>
            {selectedHero?.title || 'WalacTV'}
          </h1>

          {(selectedHero?.voteAverage ?? 0) > 0 && (
            <div className={styles.metaRow}>
              <span className={styles.ratingBadge}>
                ★ {selectedHero!.voteAverage!.toFixed(1)}
              </span>
              {selectedHero!.year && (
                <>
                  <span className={styles.metaSep} />
                  <span className={styles.metaText}>{selectedHero!.year}</span>
                </>
              )}
              {selectedHero!.runtimeMinutes && (
                <>
                  <span className={styles.metaSep} />
                  <span className={styles.metaText}>
                    {Math.floor(selectedHero!.runtimeMinutes / 60)}h {selectedHero!.runtimeMinutes % 60}min
                  </span>
                </>
              )}
              {selectedHero!.kind === 'SERIES' && selectedHero!.totalSeasons && (
                <>
                  <span className={styles.metaSep} />
                  <span className={styles.metaText}>
                    {selectedHero!.totalSeasons === 1 ? '1 temporada' : `${selectedHero!.totalSeasons} temporadas`}
                  </span>
                </>
              )}
            </div>
          )}

          {selectedHero && selectedHero.genres.length > 0 && (
            <div className={styles.genreRow}>
              {selectedHero.genres.slice(0, 5).map((g) => (
                <span key={g} className={styles.genreTag}>{g}</span>
              ))}
            </div>
          )}

          {selectedHero?.description && (
            <p className={styles.heroDescription}>
              {selectedHero.description}
            </p>
          )}
        </div>
      </div>

      {/* Sections */}
      <div className={styles.sections}>
        {activeCwSection && (
          <SectionRow
            section={activeCwSection}
            onCardClick={handleCardClick}
            continueWatching={continueWatchingEntries}
          />
        )}
        {otherSections.map((s, i) => (
          <SectionRow key={`${s.title}-${i}`} section={s} onCardClick={handleCardClick} />
        ))}
      </div>
    </div>
  )
}
