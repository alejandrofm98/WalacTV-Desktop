import { AlertCircle, Download, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { PlayerError } from '../../player/types'
import styles from './PlayerErrorState.module.css'

interface ErrorMessage {
  title: string
  message: string
}

const ERROR_MESSAGES: Record<PlayerError['kind'], ErrorMessage> = {
  auth: { title: 'Sesión expirada', message: 'Iniciá sesión de nuevo.' },
  codec: { title: 'Formato no compatible', message: 'Este formato de video no es compatible con tu sistema.' },
  not_found: { title: 'No encontrado', message: 'No se pudo encontrar el contenido.' },
  network: { title: 'Error de red', message: 'Error de conexión. Reintentando...' },
  unsupported_format: { title: 'Formato no compatible', message: 'El backend sirve un formato no soportado.' },
  dependency_missing: {
    title: 'Dependencia del sistema faltante',
    message: 'No se pudo cargar libmpv. La app puede intentar instalarlo automaticamente o podés hacerlo manualmente.',
  },
  unknown: { title: 'Algo salio mal', message: 'Reintenta o reinicia la app.' },
  platform_unsupported: {
    title: 'Plataforma no soportada',
    message: 'Wayland no esta soportado todavia.',
  },
}

interface PlayerErrorStateProps {
  error: PlayerError
  onRetry?: () => void
  onClose: () => void
}

/**
 * Full-screen error state shown when playback fails terminally.
 */
export function PlayerErrorState({ error, onRetry, onClose }: PlayerErrorStateProps) {
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  // Show detailed error info when available (for debugging)
  const detailParts: string[] = []
  if (error.code != null) {
    detailParts.push(`código ${error.code}`)
  }
  if (error.message && !ERROR_MESSAGES[error.kind].message.includes(error.message)) {
    detailParts.push(error.message)
  }

  const { title, message } = ERROR_MESSAGES[error.kind]

  const handleAutoInstall = async () => {
    setInstalling(true)
    setInstallError(null)
    try {
      const path = await invoke<string>('ensure_libmpv_installed_command')
      console.log('[PlayerErrorState] libmpv installed at:', path)
      // Retry automatically after successful install
      onRetry?.()
    } catch (err: any) {
      const errMsg = typeof err === 'string' ? err : String(err?.message ?? err)
      setInstallError(errMsg)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <AlertCircle size={56} className={styles.icon} />
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.message}>{message}</p>
        {error.url && (
          <p className={styles.url}>
            URL: {error.url.length > 80 ? error.url.slice(0, 77) + '...' : error.url}
          </p>
        )}
        {detailParts.length > 0 && error.kind !== 'platform_unsupported' && (
          <p className={styles.detail}>{detailParts.join(' — ')}</p>
        )}

        {error.kind === 'platform_unsupported' && error.message && (
          <pre className={styles.platformBlock}>{error.message}</pre>
        )}

        {(error.kind === 'dependency_missing') && (
          <div className={styles.installSection}>
            {installError && (
              <p className={styles.installError}>{installError}</p>
            )}
            <button
              className={styles.installBtn}
              onClick={handleAutoInstall}
              disabled={installing}
            >
              <Download size={16} />
              {installing ? 'Instalando...' : 'Instalar automaticamente'}
            </button>
            <p className={styles.installHelp}>
              Si la instalacion automatica falla, instalalo manualmente:
              <br />
              Debian/Ubuntu: <code>sudo apt install libmpv-dev</code>
              <br />
              Fedora: <code>sudo dnf install mpv-libs-devel</code>
              <br />
              Arch: <code>sudo pacman -S mpv</code>
            </p>
          </div>
        )}

        <div className={styles.actions}>
          {error.recoverable && onRetry && error.kind !== 'dependency_missing' && (
            <button className={styles.retryBtn} onClick={onRetry}>
              <RotateCcw size={16} />
              Reintentar
            </button>
          )}
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={16} />
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
