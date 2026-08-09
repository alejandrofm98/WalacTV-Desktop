import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { PlayerItem } from '../../player/types'
import { playerService } from '../../player/PlayerService'
import { PlayerEpg } from './PlayerEpg'
import type { EpgData } from './PlayerEpg'
import styles from './PlayerTopBar.module.css'

interface PlayerTopBarProps {
  item: PlayerItem
  epg: EpgData | null
  onBack: () => void
}

function formatClock(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * Top chrome of the player: close button, content title, optional EPG,
 * current clock and the estimated end time of the episode/movie.
 */
export function PlayerTopBar({ item, epg, onBack }: PlayerTopBarProps) {
  const isLive = item.kind === 'CHANNEL' || item.kind === 'EVENT'
  const [now, setNow] = useState(() => new Date())
  const [endTime, setEndTime] = useState<Date | null>(null)

  // 1s ticker: keeps the clock fresh and recomputes the end time from the
  // playhead. End time stays fixed while paused (position static) and
  // approaches the current time as playback advances.
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setNow(now)
      if (isLive) return
      const duration = playerService.getDuration()
      const position = playerService.getCurrentTime()
      if (Number.isFinite(duration) && duration > 0 && position >= 0 && position < duration) {
        setEndTime(new Date(now.getTime() + (duration - position) * 1000))
      } else {
        setEndTime(null)
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [isLive])
  const title =
    item.kind === 'SERIES' && item.seriesName
      ? item.seriesName
      : item.tmdbTitle ?? item.title

  let subtitle: string | null = null
  if (item.kind === 'SERIES' && item.seasonNumber != null && item.episodeNumber != null) {
    const epTag = `T${item.seasonNumber}:E${item.episodeNumber}`
    subtitle = item.title && item.title !== title ? `${epTag} · ${item.title}` : epTag
  } else if (item.subtitle) {
    subtitle = item.subtitle
  }

  return (
    <div className={styles.topBar}>
      <button
        className={styles.backBtn}
        onClick={onBack}
        aria-label="Cerrar reproductor"
      >
        <X size={22} />
      </button>
      <div className={styles.titleBlock}>
        <h2 className={styles.title}>{title}</h2>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        <PlayerEpg epg={epg} />
      </div>
      <div className={styles.topRight}>
        <span className={styles.clock}>{formatClock(now)}</span>
        {!isLive && endTime && (
          <span className={styles.ends}>
            termina <b>{formatClock(endTime)}</b>
          </span>
        )}
      </div>
    </div>
  )
}
