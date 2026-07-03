import { useState, type ReactNode } from 'react'
import type { CatalogItem, StreamOption } from '../api/types'
import { useAppStore } from '../store/useAppStore'
import styles from './MovieDetail.module.css'

interface Props {
  item: CatalogItem
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${m}min`
}

export function MovieDetail({ item }: Props) {
  const { closeDetail, openPlayer } = useAppStore()
  const [selectedStream, setSelectedStream] = useState(0)

  const displayTitle = item.tmdbTitle ?? item.title

  const metaPieces: ReactNode[] = []
  if ((item.voteAverage ?? 0) > 0) {
    metaPieces.push(
      <span className={styles.ratingBadge}>★ {item.voteAverage!.toFixed(1)}</span>
    )
  }
  if (item.year) {
    metaPieces.push(<span className={styles.metaText}>{item.year}</span>)
  }
  if (item.runtimeMinutes) {
    metaPieces.push(<span className={styles.metaText}>{formatRuntime(item.runtimeMinutes)}</span>)
  }
  if (item.countries && item.countries.length > 0) {
    metaPieces.push(<span className={styles.metaText}>{item.countries.join(', ')}</span>)
  }
  if (item.genres.length > 0) {
    metaPieces.push(<span className={styles.metaText}>{item.genres.join(', ')}</span>)
  }
  if (item.languageLabel) {
    metaPieces.push(<span className={styles.metaText}>{item.languageLabel}</span>)
  }

  return (
    <div className={styles.container}>
      <div className={styles.backdrop}>
        {(item.backdropUrl || item.tmdbPosterUrl || item.imageUrl) ? (
          <img
            src={item.backdropUrl || item.tmdbPosterUrl || item.imageUrl}
            alt=""
            className={styles.backdropImage}
          />
        ) : (
          <div className={styles.backdropFallback} />
        )}
        <div className={styles.backdropOverlay} />
      </div>

      <button onClick={closeDetail} aria-label="Volver" className={styles.backBtn}>
        ← Volver
      </button>

      <div className={styles.content}>
        {item.tagline && (
          <p className={styles.tagline}>{item.tagline}</p>
        )}

        <h1 className={styles.title}>{displayTitle}</h1>

        {metaPieces.length > 0 && (
          <div className={styles.metaRow}>
            {metaPieces.map((piece, i) => (
              <span key={i} className={styles.metaItem}>
                {i > 0 && <span className={styles.metaSep} aria-hidden="true">·</span>}
                {piece}
              </span>
            ))}
          </div>
        )}

        {item.description && (
          <p className={styles.synopsis}>{item.description}</p>
        )}

        {item.streamOptions.length > 0 && (
          <div className={styles.streamSection}>
            <h3 className={styles.streamTitle}>Opciones de stream</h3>
            <div className={styles.streamOptions}>
              {item.streamOptions.map((opt: StreamOption, i) => {
                const label = opt.label?.trim() ?? ''
                const quality = opt.quality?.trim() ?? ''
                const sameQuality = !!label && !!quality && label.toLowerCase() === quality.toLowerCase()
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedStream(i)}
                    aria-pressed={selectedStream === i}
                    aria-label={`Stream ${label || quality || 'default'}${quality ? `, calidad ${quality}` : ''}`}
                    className={`${styles.streamPill} ${selectedStream === i ? styles.streamPillSelected : ''}`}
                  >
                    <span className={styles.streamLabel}>{label || quality || 'Default'}</span>
                    {quality && !sameQuality && <span className={styles.streamQuality}>{quality}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <button
          onClick={() => openPlayer(item, selectedStream)}
          className={styles.playBtn}
        >
          Reproducir
        </button>
      </div>
    </div>
  )
}

