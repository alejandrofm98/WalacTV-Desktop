import { useState, useEffect } from 'react'
import { APP_VERSION, checkForUpdates, downloadAndInstall, type UpdateInfo } from '../updater'
import { setPreferredLanguage } from '../api/client'
import { getTorrentMaxMb, setTorrentMaxMb } from '../settings'
import { API_URL } from '../config'
import styles from './SettingsContent.module.css'

interface Props {
  onSignOut: () => void
}

const LANGUAGES = ['ES', 'EN'] as const

const TORRENT_LIMIT_GB = [1, 2, 4, 8] as const

export function SettingsContent({ onSignOut }: Props) {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(true)
  const [language, setLang] = useState(() => localStorage.getItem('walactv_language') || 'ES')
  const [torrentLimitGb, setTorrentLimitGb] = useState(() => getTorrentMaxMb() / 1024)

  useEffect(() => {
    checkForUpdates()
      .then(setUpdateInfo)
      .catch(() => setUpdateInfo({ available: false }))
      .finally(() => setChecking(false))
  }, [])

  function handleLanguage(lang: string) {
    setLang(lang)
    setPreferredLanguage(lang)
  }

  function handleTorrentLimit(gb: number) {
    setTorrentLimitGb(gb)
    void setTorrentMaxMb(gb * 1024)
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.title}>Ajustes</h2>

      <div className={styles.card}>
        {/* Info rows */}
        <Row label="Version" value={`v${APP_VERSION}`} />
        <Row label="Backend" value={API_URL.replace(/^https?:\/\//, '')} />
        <Row label="Plataforma" value={navigator.platform} />

        {/* Language */}
        <div className={styles.settingRow}>
          <span className={styles.rowLabel}>Idioma preferido</span>
          <div className={styles.langGroup}>
            {LANGUAGES.map((l) => (
              <button
                key={l}
                className={`${styles.langBtn} ${language === l ? styles.langBtnActive : ''}`}
                onClick={() => handleLanguage(l)}
              >{l}</button>
            ))}
          </div>
        </div>

        {/* Torrent download budget */}
        <div className={styles.settingRow}>
          <span className={styles.rowLabel}>Limite descarga torrent</span>
          <div className={styles.langGroup}>
            {TORRENT_LIMIT_GB.map((gb) => (
              <button
                key={gb}
                className={`${styles.langBtn} ${torrentLimitGb === gb ? styles.langBtnActive : ''}`}
                onClick={() => handleTorrentLimit(gb)}
              >{gb}GB</button>
            ))}
            <button
              className={`${styles.langBtn} ${torrentLimitGb === 0 ? styles.langBtnActive : ''}`}
              onClick={() => handleTorrentLimit(0)}
            >Ilimitado</button>
          </div>
        </div>

        {/* Updates section */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Actualizaciones</div>
        </div>
        <div className={styles.updateRow}>
          <span className={styles.rowLabel}>Estado</span>
          {checking ? (
            <span className={`${styles.updateStatus} ${styles.updateChecking}`}>Buscando...</span>
          ) : updateInfo?.available ? (
            <span className={`${styles.updateStatus} ${styles.updateAvailable}`}>
              v{updateInfo.version} disponible
            </span>
          ) : (
            <span className={`${styles.updateStatus} ${styles.updateUpToDate}`}>Actualizado</span>
          )}
        </div>
        {updateInfo?.available && (
          <div className={styles.updateRow}>
            <span className={styles.rowLabel}>
              {updateInfo.body?.slice(0, 100) ?? 'Nueva version disponible'}
            </span>
            {(
              <button onClick={() => downloadAndInstall()} className={styles.updateBtn}>
                Descargar e instalar
              </button>
            )}
          </div>
        )}

        {/* Sign out */}
        <div className={styles.signOutSection}>
          <button onClick={onSignOut} className={styles.signOutBtn}>
            Cerrar sesion
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}
