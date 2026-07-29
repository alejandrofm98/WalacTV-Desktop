import { X } from 'lucide-react'
import type { PlayerItem } from '../../player/types'
import { PlayerEpg } from './PlayerEpg'
import type { EpgData } from './PlayerEpg'
import styles from './PlayerTopBar.module.css'

interface PlayerTopBarProps {
  item: PlayerItem
  epg: EpgData | null
  onBack: () => void
}

/**
 * Top chrome of the player: close button, content title and optional EPG.
 */
export function PlayerTopBar({ item, epg, onBack }: PlayerTopBarProps) {
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
    </div>
  )
}
