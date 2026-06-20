import { useState } from 'react'
import type { CatalogItem } from '../api/types'
import { useAppStore } from '../store/useAppStore'
import styles from './MovieDetail.module.css'

interface Props {
  item: CatalogItem
}

export function MovieDetail({ item }: Props) {
  const { closeDetail, openPlayer } = useAppStore()
  const [selectedStream, setSelectedStream] = useState(0)

  return (
    <div className={styles.container}>
      {/* Backdrop */}
      <div className={styles.backdrop}>
        {(item.backdropUrl || item.tmdbPosterUrl || item.imageUrl) ? (
          <img src={item.backdropUrl || item.tmdbPosterUrl || item.imageUrl} alt="" className={styles.backdropImage} />
        ) : (
          <div className={styles.backdropFallback} />
        )}
        <div className={styles.gradientLeft} />
        <div className={styles.gradientBottom} />

        <button onClick={closeDetail} className={styles.backBtn}>
          ← Volver
        </button>

        <div className={styles.info}>
          <h1 className={styles.title}>{item.title}</h1>
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
                <span className={styles.metaText}>
                  {Math.floor(item.runtimeMinutes / 60)}h {item.runtimeMinutes % 60}min
                </span>
              </>
            )}
          </div>
          {item.genres?.length > 0 && (
            <div className={styles.genreRow}>
              {item.genres.map((g) => (
                <span key={g} className={styles.genreTag}>{g}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className={styles.body}>
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
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <button onClick={() => openPlayer(item, selectedStream)} className={styles.playBtn}>
          <span className={styles.playIcon}>▶</span>
          Reproducir
        </button>
      </div>
    </div>
  )
}
