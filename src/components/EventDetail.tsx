import { useState } from 'react'
import type { CatalogItem, StreamOption } from '../api/types'
import { useAppStore } from '../store/useAppStore'
import styles from './EventDetail.module.css'

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

export function EventDetail({ item }: Props) {
  const { closeDetail, openPlayer } = useAppStore()
  const [selectedStream, setSelectedStream] = useState(0)

  return (
    <div className={styles.container}>
      <div className={styles.backdrop}>
        {item.imageUrl ? (
          <img src={item.imageUrl} alt="" className={styles.backdropImage} />
        ) : (
          <div className={styles.backdropFallback} />
        )}
        <div className={styles.backdropOverlay} />
      </div>

      <button onClick={closeDetail} className={styles.backBtn}>
        ← Volver
      </button>

      <div className={styles.content}>
        <h1 className={styles.title}>{item.title}</h1>

        <div className={styles.metaRow}>
          {item.badgeText && <span className={styles.badgeText}>{item.badgeText}</span>}
          {item.group && (
            <>
              <span className={styles.metaSep} />
              <span className={styles.metaText}>{item.group}</span>
            </>
          )}
          {item.subtitle && (
            <>
              <span className={styles.metaSep} />
              <span className={styles.metaText}>{item.subtitle}</span>
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

        {item.streamOptions.length > 1 && (
          <div className={styles.streamSection}>
            <h3 className={styles.streamTitle}>Fuentes disponibles</h3>
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
