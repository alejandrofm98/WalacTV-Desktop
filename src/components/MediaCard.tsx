import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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
  onMarkWatched?: () => void
  onRemove?: () => void
  onStartOver?: () => void
}

const CARD_W = 170
const CARD_H = 240
const TEXT_AREA_H = 46

export function MediaCard({ item, width = CARD_W, height = CARD_H, showText = false, progressPercent, topBadges, onClick, onHover, onViewDetail, onMarkWatched, onRemove, onStartOver }: Props) {
  const [focused, setFocused] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
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

  useEffect(() => {
    if (!menuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [menuOpen])

  const hasMenu = onViewDetail || onStartOver || onMarkWatched || onRemove
  const runMenuAction = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={displayTitle}
      onFocus={() => { setFocused(true); onHover?.(item) }}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => onHover?.(item)}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!hasMenu) return
        e.preventDefault()
        setMenuOpen(true)
      }}
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
      {item.isWatched && isVod && (
        <div className={styles.watchedBadge}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      )}
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

      {hasMenu && menuOpen && createPortal(
        <div className={styles.contextMenuBackdrop} onMouseDown={() => setMenuOpen(false)}>
          <div
            className={styles.contextMenu}
            role="menu"
            aria-label={`Opciones para ${displayTitle}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {onViewDetail && (
              <button
                type="button"
                className={styles.contextMenuItem}
                onClick={(e) => { e.stopPropagation(); runMenuAction(onViewDetail) }}
              >
                Ir a detalles
              </button>
            )}
            {onStartOver && (
              <button type="button" className={styles.contextMenuItem} onClick={(e) => { e.stopPropagation(); runMenuAction(onStartOver) }}>
                Empezar desde el principio
              </button>
            )}
            {onMarkWatched && (
              <button
                type="button"
                className={styles.contextMenuItem}
                onClick={(e) => { e.stopPropagation(); runMenuAction(onMarkWatched) }}
              >
                Marcar como vista
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                onClick={(e) => { e.stopPropagation(); runMenuAction(onRemove) }}
              >
                Limpiar progreso
              </button>
            )}
          </div>
        </div>,
        document.body,
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
