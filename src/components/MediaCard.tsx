import { useState } from 'react'
import type { CatalogItem } from '../api/types'
import { useAppStore } from '../store/useAppStore'
import styles from './MediaCard.module.css'

interface Props {
  item: CatalogItem
  width?: number
  height?: number
  showText?: boolean
  progressPercent?: number
  topBadges?: string[]
  onClick: () => void
  onHover?: (item: CatalogItem) => void
  onViewDetail?: () => void
  onRemove?: () => void
}

const CARD_W = 170
const CARD_H = 240
const TEXT_AREA_H = 46

export function MediaCard({ item, width = CARD_W, height = CARD_H, showText = false, progressPercent, topBadges, onClick, onHover, onViewDetail, onRemove }: Props) {
  const [focused, setFocused] = useState(false)
  const [imgError, setImgError] = useState(false)
  const playerOpening = useAppStore((s) => s.playerOpening)
  const playerItem = useAppStore((s) => s.playerItem)
  const isVod = item.kind === 'MOVIE' || item.kind === 'SERIES'
  const isEvent = item.kind === 'EVENT'
  const isChannel = item.kind === 'CHANNEL'
  const isDimmed = playerOpening && playerItem?.stableId === item.stableId
  const displayTitle = item.tmdbTitle ?? item.title

  const displayImage = item.tmdbPosterUrl || item.imageUrl || ''
  const imgFailed = imgError || !displayImage

  // Placeholder: first word of title, uppercase
  const placeholderInitial = displayTitle?.split(' ')[0]?.slice(0, 4).toUpperCase() ?? '?'
  const placeholderType = isChannel ? 'Canal' : isEvent ? 'Evento' : item.kind === 'SERIES' ? 'Serie' : 'Película'

  const cardClass = [
    styles.card,
    focused ? styles.cardFocus : styles.cardDefault,
    isVod ? styles.cardVod : styles.cardNonVod,
    isDimmed && styles.cardDimmed,
  ].join(' ')

  const imgHeight = showText ? height - TEXT_AREA_H : height

  const isHiddenBadge = ['EN VIVO', 'CINE', 'SERIES', 'SERIE', 'PELICULA', 'PELICULAS'].includes(item.badgeText?.trim().toUpperCase() || '')

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={displayTitle}
      onFocus={() => { setFocused(true); onHover?.(item) }}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => onHover?.(item)}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className={cardClass}
      style={{ width, minWidth: width, height }}
    >
      {/* Image */}
      {!imgFailed ? (
        <img
          src={displayImage}
          alt={displayTitle}
          className={styles.image}
          style={{ height: imgHeight }}
          loading="lazy"
          onError={() => setImgError(true)}
        />
      ) : (
        <div className={styles.placeholder} style={{ height: imgHeight }}>
          <span className={styles.placeholderInitial}>{placeholderInitial}</span>
          <span className={styles.placeholderType}>{placeholderType}</span>
        </div>
      )}

      {/* Badge */}
      {topBadges && topBadges.length > 0 ? (
        <div className={styles.badgesContainer}>
          {topBadges.map((badge, idx) => (
            <div key={idx} className={`${styles.badge} ${styles.badgeDefault} ${styles.badgeInline}`}>
              {badge}
            </div>
          ))}
        </div>
      ) : (item.badgeText && !isHiddenBadge && (
        <div className={`${styles.badge} ${isEvent ? styles.badgeLive : styles.badgeDefault}`}>
          {item.badgeText}
        </div>
      ))}

      {(onViewDetail || onRemove) && (
        <div className={styles.cwActions}>
          {onViewDetail && (
            <button
              type="button"
              className={`${styles.cwBtn} ${styles.cwBtnInfo}`}
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); onViewDetail() }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="Ver detalle"
              title="Ver detalle"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <circle cx="12" cy="7" r="0.6" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className={`${styles.cwBtn} ${styles.cwBtnRemove}`}
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); onRemove() }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="Eliminar de continuar viendo"
              title="Eliminar de continuar viendo"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Progress bar */}
      {progressPercent != null && progressPercent > 0 && (
        <div className={styles.progressTrack} style={{ bottom: showText ? TEXT_AREA_H : 0 }}>
          <div className={styles.progressBar} style={{ width: `${progressPercent}%` }} />
        </div>
      )}

      {/* Text area */}
      {showText && (
        <div className={`${styles.textArea} ${isVod ? styles.textAreaVod : styles.textAreaNonVod}`}>
          <div className={styles.title}>{displayTitle}</div>
          {item.subtitle && (
            <div className={styles.subtitle}>{item.subtitle}</div>
          )}
        </div>
      )}
    </div>
  )
}
