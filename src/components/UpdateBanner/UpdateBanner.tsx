import { useAppStore } from '../../store/useAppStore'
import { APP_VERSION, downloadAndInstall } from '../../updater'
import { useState } from 'react'
import styles from './UpdateBanner.module.css'

interface DownloadState {
  status: 'idle' | 'downloading' | 'installing' | 'error'
  progress: number
  errorMessage?: string
}

export function UpdateBanner() {
  const updateInfo = useAppStore((s) => s.updateInfo)
  const updateDismissed = useAppStore((s) => s.updateDismissed)
  const dismissUpdate = useAppStore((s) => s.dismissUpdate)
  const [dlState, setDlState] = useState<DownloadState>({ status: 'idle', progress: 0 })

  if (!updateInfo?.available || updateDismissed) return null

  const latest = updateInfo.version ?? ''

  const handleDownload = async () => {
    setDlState({ status: 'downloading', progress: 0 })
    let totalBytes = 0
    let downloaded = 0
    try {
      await downloadAndInstall((event) => {
        if (event.event === 'Started') {
          const d = event.data as { contentLength?: number } | undefined
          if (d?.contentLength) totalBytes = d.contentLength
        }
        if (event.event === 'Progress') {
          const d = event.data as { chunkLength: number }
          downloaded += d.chunkLength
          if (totalBytes > 0) {
            const pct = Math.min(Math.round((downloaded / totalBytes) * 100), 99)
            setDlState((prev) => ({ ...prev, progress: pct }))
          }
        }
        if (event.event === 'Finished') {
          setDlState((prev) => ({ ...prev, status: 'installing', progress: 100 }))
        }
      })
    } catch (err) {
      setDlState({
        status: 'error',
        progress: 0,
        errorMessage: err instanceof Error ? err.message : 'Error al descargar',
      })
    }
  }

  return (
    <div className={styles.banner} role="status">
      <div className={styles.content}>
        <span className={styles.info}>
          {dlState.status === 'idle' && (
            <>
              Nueva version disponible: <strong>v{latest}</strong>
              <span className={styles.divider}>|</span>
              Version actual: v{APP_VERSION}
            </>
          )}
          {dlState.status === 'downloading' && (
            <>Descargando actualizacion... {dlState.progress}%</>
          )}
          {dlState.status === 'installing' && (
            <>Instalando...</>
          )}
          {dlState.status === 'error' && (
            <span className={styles.errorText}>{dlState.errorMessage}</span>
          )}
        </span>

        {dlState.status === 'idle' && (
          <>
            <button className={styles.downloadBtn} onClick={handleDownload}>
              Descargar e instalar
            </button>
            <button className={styles.closeBtn} onClick={dismissUpdate} aria-label="Cerrar">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}

        {dlState.status === 'downloading' && (
          <div className={styles.progressArea}>
            <div className={styles.progressBar}>
              <div
                className={styles.progressFill}
                style={{ width: `${dlState.progress}%` }}
              />
            </div>
          </div>
        )}

        {dlState.status === 'installing' && (
          <span className={styles.installingText}>La app se cerrara al instalar</span>
        )}

        {dlState.status === 'error' && (
          <button className={styles.retryBtn} onClick={handleDownload}>
            Reintentar
          </button>
        )}
      </div>
    </div>
  )
}
