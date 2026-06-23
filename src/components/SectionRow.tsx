import { useRef, useState, useEffect } from 'react'
import type { BrowseSection, CatalogItem } from '../api/types'
import { MediaCard } from './MediaCard'
import styles from './SectionRow.module.css'

interface Props {
  section: BrowseSection
  onCardClick: (item: CatalogItem) => void
  onCardHover?: (item: CatalogItem) => void
  continueWatching?: Map<string, { positionMs: number; durationMs: number; isWatched?: boolean; seasonNumber?: number | null; episodeNumber?: number | null }>
}

export function SectionRow({ section, onCardClick, onCardHover, continueWatching }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function update() {
      setCanScrollLeft(el!.scrollLeft > 10)
      setCanScrollRight(el!.scrollLeft < el!.scrollWidth - el!.clientWidth - 10)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [section.items.length])

  const isEvents = section.items[0]?.kind === 'EVENT'
  const isCwSection = section.title === 'Continuar viendo'
  const isVodSection = section.contentType === 'movies' || section.contentType === 'series' || isCwSection

  const badgeClass = section.contentType === 'movies' ? styles.badgeMovies : styles.badgeSeries

  return (
    <div className={styles.container}>
      {/* Section title */}
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>
          {isEvents ? 'Eventos' : section.title}
        </span>
        {(section.contentType === 'movies' || section.contentType === 'series') && (
          <span className={`${styles.badge} ${badgeClass}`}>
            {section.contentType === 'movies' ? 'PELICULAS' : 'SERIES'}
          </span>
        )}
      </div>

      {/* Cards row */}
      <div className={styles.scrollContainer}>
        {canScrollLeft && (
          <button
            onClick={() => scrollRef.current?.scrollBy({ left: -400, behavior: 'smooth' })}
            className={`${styles.scrollBtn} ${styles.scrollBtnLeft}`}
          >‹</button>
        )}
        <div ref={scrollRef} className={styles.scrollTrack}>
          {section.items.map((item) => {
            const cw = continueWatching?.get(item.stableId) ?? continueWatching?.get(item.providerId ?? '')
            const progress = cw ? Math.round(((cw.positionMs ?? 0) * 100) / (cw.durationMs ?? 1)) : undefined

            const topBadges: string[] = []
            if (isCwSection && cw) {
              if (item.kind === 'SERIES' && cw.seasonNumber && cw.episodeNumber) {
                topBadges.push(`T${cw.seasonNumber} E${cw.episodeNumber}`)
              }
              
              if (cw.durationMs > cw.positionMs) {
                const minutesLeft = Math.max(1, Math.floor((cw.durationMs - cw.positionMs) / 60000))
                if (minutesLeft >= 60) {
                  const hours = Math.floor(minutesLeft / 60)
                  const mins = minutesLeft % 60
                  topBadges.push(mins > 0 ? `${hours}h ${mins}m restantes` : `${hours}h restantes`)
                } else {
                  topBadges.push(`${minutesLeft} min restantes`)
                }
              }
            }

            return (
              <MediaCard
                key={item.stableId}
                item={item}
                width={isEvents ? 290 : isVodSection ? 185 : 230}
                height={isEvents ? 180 : isVodSection ? 270 : 150}
                showText={!isVodSection}
                progressPercent={progress}
                topBadges={topBadges}
                onClick={() => onCardClick(item)}
                onHover={onCardHover}
              />
            )
          })}
        </div>
        {canScrollRight && (
          <button
            onClick={() => scrollRef.current?.scrollBy({ left: 400, behavior: 'smooth' })}
            className={`${styles.scrollBtn} ${styles.scrollBtnRight}`}
          >›</button>
        )}
      </div>
    </div>
  )
}
