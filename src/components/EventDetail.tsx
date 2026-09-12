import { useEffect, useState } from 'react'
import type { CatalogItem, StreamOption } from '../api/types'
import { resolveReplayStreamUrl } from '../api/client'
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
  const [loadingStream, setLoadingStream] = useState(false)

  // Reset/clamp de fuente al cambiar de evento.
  useEffect(() => {
    setSelectedStream(0)
  }, [item.stableId])
  useEffect(() => {
    setSelectedStream((cur) => (cur >= item.streamOptions.length ? 0 : cur))
  }, [item.streamOptions.length])

  const handlePlay = async () => {
    const current = item.streamOptions[selectedStream]
    if (!current) return
    setLoadingStream(true)
    try {
      const url = await resolveReplayStreamUrl(current)
      openPlayer({
        ...item,
        streamOptions: item.streamOptions.map((option, index) => index === selectedStream ? { ...option, url } : option),
      }, selectedStream)
    } finally {
      setLoadingStream(false)
    }
  }

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

        <button onClick={handlePlay} className={styles.playBtn} disabled={loadingStream || item.streamOptions.length === 0}>
          <span className={styles.playIcon}>▶</span>
          {loadingStream ? 'Cargando...' : 'Reproducir'}
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
