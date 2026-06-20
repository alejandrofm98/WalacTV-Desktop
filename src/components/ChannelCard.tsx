import { useState, useMemo, useCallback } from 'react'
import type { CatalogItem } from '../api/types'
import styles from './ChannelCard.module.css'

const GRADIENTS = [
  'linear-gradient(135deg, #6a11cb, #2575fc)',
  'linear-gradient(135deg, #f7971e, #ffd200)',
  'linear-gradient(135deg, #e52d27, #b31217)',
  'linear-gradient(135deg, #11998e, #38ef7d)',
  'linear-gradient(135deg, #8e44ad, #3498db)',
  'linear-gradient(135deg, #f7971e, #e52d27)',
  'linear-gradient(135deg, #00b4db, #0083b0)',
  'linear-gradient(135deg, #ff416c, #ff4b2b)',
  'linear-gradient(135deg, #56ab2f, #a8e063)',
  'linear-gradient(135deg, #8360c3, #2ebf91)',
]

interface ChannelCardProps {
  item: CatalogItem
  isFavorite?: boolean
  toggling?: boolean
  onClick?: () => void
  onToggleFavorite?: (item: CatalogItem) => void
}

function hashToIndex(str: string, length: number): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash) % length
}

export function ChannelCard({
  item,
  isFavorite = false,
  toggling = false,
  onClick,
  onToggleFavorite,
}: ChannelCardProps) {
  const [imageError, setImageError] = useState(false)
  const hasImage = item.imageUrl && !imageError
  const gradient = useMemo(
    () => GRADIENTS[hashToIndex(item.stableId, GRADIENTS.length)],
    [item.stableId]
  )

  const handleFavClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!toggling) {
        onToggleFavorite?.(item)
      }
    },
    [item, onToggleFavorite, toggling]
  )

  return (
    <div
      className={styles.card}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      }}
    >
      <div
        className={styles.thumb}
        style={{ background: hasImage ? undefined : gradient }}
      >
        {hasImage ? (
          <img
            src={item.imageUrl}
            alt={item.title}
            className={styles.logo}
            onError={() => setImageError(true)}
            loading="lazy"
          />
        ) : (
          <span className={styles.fallbackIcon} aria-hidden="true">
            📺
          </span>
        )}

        <span className={styles.badge247}>24/7</span>

        {onToggleFavorite && (
          <button
            type="button"
            className={`${styles.favBtn} ${isFavorite ? styles.favActive : ''}`}
            onClick={handleFavClick}
            disabled={toggling}
            aria-label={isFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}
            title={isFavorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}
          >
            {isFavorite ? '♥' : '♡'}
          </button>
        )}
      </div>

      <div className={styles.info}>
        <div className={styles.name} title={item.title}>
          {item.title}
        </div>
        <div className={styles.group} title={item.group}>
          {item.group}
        </div>
      </div>
    </div>
  )
}
