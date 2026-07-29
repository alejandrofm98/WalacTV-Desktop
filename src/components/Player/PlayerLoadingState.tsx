import styles from './PlayerLoadingState.module.css'

interface PlayerLoadingStateProps {
  variant?: 'opening' | 'buffering'
}

/**
 * Loading spinner overlay.
 * 'opening' covers the video with a blurred backdrop while the stream loads.
 * 'buffering' is a lightweight spinner for mid-playback rebuffers.
 */
export function PlayerLoadingState({ variant = 'opening' }: PlayerLoadingStateProps) {
  return (
    <div
      className={`${styles.overlay} ${variant === 'buffering' ? styles.overlayBuffering : ''}`}
    >
      <div className={styles.spinner} />
      {variant === 'opening' && <p className={styles.text}>Cargando...</p>}
    </div>
  )
}
