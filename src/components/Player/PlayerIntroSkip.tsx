import { SkipForward } from 'lucide-react'
import styles from './PlayerIntroSkip.module.css'

interface SkipSegment {
  type: 'intro' | 'recap' | 'outro'
  endTime: number
}

interface PlayerIntroSkipProps {
  segment: SkipSegment | null
  onSkip: () => void
}

const SKIP_LABELS: Record<SkipSegment['type'], string> = {
  intro: 'Saltar intro',
  recap: 'Saltar recap',
  outro: 'Saltar créditos',
}

/**
 * Floating skip button shown while an intro/recap/outro segment is active.
 * Independent from the controls overlay: visible even when chrome is hidden.
 */
export function PlayerIntroSkip({ segment, onSkip }: PlayerIntroSkipProps) {
  if (!segment) return null

  return (
    <button key={segment.type} className={styles.skipBtn} onClick={onSkip}>
      <span>{SKIP_LABELS[segment.type]}</span>
      <SkipForward size={18} />
    </button>
  )
}
