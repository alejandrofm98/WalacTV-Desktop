import styles from './ErrorScreen.module.css'

interface Props {
  message: string
  onRetry: () => void
}

export function ErrorScreen({ message, onRetry }: Props) {
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.icon}>⚠</div>
        <h2 className={styles.title}>No se pudo cargar WalacTV</h2>
        <p className={styles.message}>{message}</p>
        <button onClick={onRetry} className={styles.retryBtn}>
          Reintentar
        </button>
      </div>
    </div>
  )
}
