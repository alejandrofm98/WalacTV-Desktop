import { Play } from 'lucide-react'
import { usePlayerStore } from '../../player/usePlayerStore'
import styles from './PlayerCenter.module.css'

/**
 * Center overlay: large translucent play badge shown while paused.
 * Placeholder anchor for future center-stage actions.
 */
export function PlayerCenter() {
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const isBuffering = usePlayerStore((s) => s.isBuffering)
  const isOpening = usePlayerStore((s) => s.isOpening)

  if (isPlaying || isBuffering || isOpening) return null

  return (
    <div className={styles.center}>
      <div className={styles.playBadge}>
        <Play size={40} fill="currentColor" />
      </div>
    </div>
  )
}
