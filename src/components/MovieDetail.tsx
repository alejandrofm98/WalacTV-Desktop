import { useState } from 'react'
import type { CatalogItem, StreamOption } from '../api/types'
import { useAppStore } from '../store/useAppStore'
import styles from './MovieDetail.module.css'

interface Props {
  item: CatalogItem
}

function formatStreamLabel(opt: StreamOption): string {
  const label = opt.label?.trim() ?? ''
  const quality = opt.quality?.trim() ?? ''
  if (!label) return quality || 'Default'
  if (!quality) return label
  if (label.toLowerCase() === quality.toLowerCase()) return label
  return `${label} · ${quality}`
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

  return (
    <div className={styles.container}>
      {/* Fullscreen backdrop */}
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

      <button onClick={closeDetail} className={styles.backBtn}>
        ← Volver
      </button>

      <div className={styles.content}>
        <h1 className={styles.title}>{displayTitle}</h1>

        <div className={styles.metaRow}>
          {(item.voteAverage ?? 0) > 0 && (
            <span className={styles.ratingBadge}>★ {item.voteAverage!.toFixed(1)}</span>
          )}
          {item.year && (
            <>
              <span className={styles.metaSep} />
              <span className={styles.metaText}>{item.year}</span>
            </>
          )}
          {item.runtimeMinutes && (
            <>
              <span className={styles.metaSep} />
              <span className={styles.metaText}>{formatRuntime(item.runtimeMinutes)}</span>
            </>
          )}
          {item.countries && item.countries.length > 0 && (
            <>
              <span className={styles.metaSep} />
              <span className={styles.metaText}>{item.countries.join(', ')}</span>
            </>
          )}
          {item.genres.length > 0 && (
            <>
              <span className={styles.metaSep} />
              <span className={styles.metaText}>{item.genres.join(', ')}</span>
            </>
          )}
        </div>

        <button onClick={() => openPlayer(item, selectedStream)} className={styles.playBtn}>
          <span className={styles.playIcon}>▶</span>
          Reproducir
        </button>

        {item.description && (
          <p className={styles.description}>{item.description}</p>
        )}

        {item.streamOptions.length > 0 && (
          <div className={styles.streamSection}>
            <h3 className={styles.streamTitle}>Opciones de stream</h3>
            <div className={styles.streamOptions}>
              {item.streamOptions.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedStream(i)}
                  className={`${styles.streamBtn} ${selectedStream === i ? styles.streamBtnSelected : styles.streamBtnDefault}`}
                >
                  {formatStreamLabel(opt)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
