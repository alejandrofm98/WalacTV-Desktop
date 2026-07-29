import { useState } from 'react'
import { usePlayerStore } from '../../player/usePlayerStore'
import type { PlayerItem } from '../../player/types'
import { PlayerTopBar } from './PlayerTopBar'
import { PlayerCenter } from './PlayerCenter'
import { PlayerControls } from './PlayerControls'
import type { PanelKind } from './PlayerControls'
import type { EpgData } from './PlayerEpg'
import styles from './PlayerOverlay.module.css'

interface PlayerOverlayProps {
  visible: boolean
  item: PlayerItem
  epg: EpgData | null
  onBack: () => void
}

/**
 * Absolute overlay above the <video> element.
 * Composes top bar, center layer and bottom controls, and fades them
 * together based on the auto-hide signal. Controls stay forced-visible
 * while paused or while a track panel is open.
 */
export function PlayerOverlay({ visible, item, epg, onBack }: PlayerOverlayProps) {
  const [activePanel, setActivePanel] = useState<PanelKind>(null)
  const isPlaying = usePlayerStore((s) => s.isPlaying)

  const effectiveVisible = visible || activePanel !== null || !isPlaying

  return (
    <div className={`${styles.overlay} ${effectiveVisible ? '' : styles.hidden}`}>
      <PlayerTopBar item={item} epg={epg} onBack={onBack} />
      <PlayerCenter />
      <PlayerControls
        item={item}
        activePanel={activePanel}
        onPanelChange={setActivePanel}
      />
    </div>
  )
}
