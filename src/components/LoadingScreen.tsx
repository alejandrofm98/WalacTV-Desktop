import styles from './LoadingScreen.module.css'

export function LoadingScreen() {
  return (
    <div className={styles.container}>
      <img src="/logo.png" alt="WalacTV" className={styles.logoImage} width={240} height={126} />
      <div className={styles.spinner}>
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </div>
    </div>
  )
}
