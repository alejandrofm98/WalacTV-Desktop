import { useState, useEffect } from 'react'
import type { CatalogItem } from '../api/types'
import { getSeriesEpisodes } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import styles from './SeriesDetail.module.css'

interface Props {
  item: CatalogItem
}

export function SeriesDetail({ item }: Props) {
  const { closeDetail, openPlayer } = useAppStore()
  const [episodes, setEpisodes] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)

  const seriesName = item.seriesName ?? item.normalizedTitle ?? item.title

  useEffect(() => {
    if (!seriesName) return
    setLoading(true)
    setError(null)
    getSeriesEpisodes(seriesName)
      .then((r) => setEpisodes(r.episodes ?? []))
      .catch((e) => setError(e.message ?? 'Error cargando episodios'))
      .finally(() => setLoading(false))
  }, [seriesName])

  const seasons = [...new Set(episodes.map((e) => e.seasonNumber).filter(Boolean))].sort((a, b) => a! - b!)
  const filteredEpisodes = selectedSeason != null
    ? episodes.filter((e) => e.seasonNumber === selectedSeason)
    : episodes

  const sortedEpisodes = [...filteredEpisodes].sort((a, b) =>
    (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0)
  )

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        {(item.backdropUrl || item.tmdbPosterUrl || item.imageUrl) ? (
          <img src={item.backdropUrl || item.tmdbPosterUrl || item.imageUrl} alt="" className={styles.headerImage} />
        ) : (
          <div className={styles.headerFallback} />
        )}
        <div className={styles.gradientLeft} />
        <div className={styles.gradientBottom} />
        <button onClick={closeDetail} className={styles.backBtn}>← Volver</button>
        <div className={styles.headerInfo}>
          <h1 className={styles.title}>{item.tmdbTitle ?? item.title}</h1>
          {item.totalSeasons && (
            <span className={styles.seasonsText}>
              {item.totalSeasons === 1 ? '1 temporada' : `${item.totalSeasons} temporadas`}
            </span>
          )}
        </div>
      </div>

      {/* Seasons tabs */}
      {seasons.length > 1 && (
        <div className={styles.seasonTabs}>
          <SeasonTab label="Todas" active={selectedSeason === null} onClick={() => setSelectedSeason(null)} />
          {seasons.map((s) => (
            <SeasonTab
              key={s} label={`Temp ${s}`}
              active={selectedSeason === s}
              onClick={() => setSelectedSeason(s ?? null)}
            />
          ))}
        </div>
      )}

      {/* Episodes */}
      <div className={styles.episodes}>
        {loading ? (
          <div className={styles.loadingText}>Cargando episodios...</div>
        ) : error ? (
          <div className={styles.loadingText}>{error}</div>
        ) : sortedEpisodes.length === 0 ? (
          <div className={styles.loadingText}>Sin episodios</div>
        ) : (
          <div className={styles.episodeList}>
            {sortedEpisodes.map((ep, i) => (
              <div
                key={ep.stableId ?? i}
                onClick={() => openPlayer(ep)}
                className={styles.episodeCard}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') openPlayer(ep) }}
              >
                {/* Thumbnail */}
                {(ep.stillPath || ep.imageUrl) ? (
                  <img src={ep.stillPath || ep.imageUrl} alt="" className={styles.episodeThumb} />
                ) : (
                  <div className={styles.episodeThumbPlaceholder}>TV</div>
                )}

                <div className={styles.episodeInfo}>
                  <div className={styles.episodeNumber}>
                    T{ep.seasonNumber ?? '?'} E{ep.episodeNumber ?? '?'}
                  </div>
                  <div className={styles.episodeTitle}>{ep.tmdbTitle ?? ep.title}</div>
                  {ep.subtitle && (
                    <div className={styles.episodeSubtitle}>{ep.subtitle}</div>
                  )}
                </div>

                <span className={styles.playIcon}>▶</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SeasonTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`${styles.seasonTab} ${active ? styles.seasonTabActive : styles.seasonTabDefault}`}
    >
      {label}
    </button>
  )
}
