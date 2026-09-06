import type { TorrentOverlayInfo, TorrentStats } from '../../player/types'
import styles from './TorrentLoadingOverlay.module.css'

interface TorrentLoadingOverlayProps {
  info: TorrentOverlayInfo
  stats: TorrentStats | null
}

/** Objetivo de prebuffer para la barra: 30 MB o el 5% del archivo. */
function prebufferTarget(totalBytes: number): number {
  if (!totalBytes) return 30 * 1024 * 1024
  return Math.min(30 * 1024 * 1024, Math.max(5 * 1024 * 1024, totalBytes * 0.05))
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bps: number): string {
  if (!bps) return '—'
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function formatEta(remainingBytes: number, bps: number): string {
  if (!bps || remainingBytes <= 0) return '—'
  const seconds = Math.round(remainingBytes / bps)
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatPeers(peers: number, connecting: number): string {
  return connecting > 0 ? `${peers} (+${connecting})` : `${peers}`
}

/**
 * Overlay de carga para pelis y series, tanto torrent como directo: imagen
 * del titulo de fondo, barra de progreso y estadisticas en vivo.
 * En directo (stats null) no se muestra ninguna cifra, solo titulo y barra.
 * Espejo del TorrentLoadingOverlay del cliente Android.
 */
export function TorrentLoadingOverlay({ info, stats }: TorrentLoadingOverlayProps) {
  const target = prebufferTarget(stats?.totalBytes ?? 0)
  const progress = stats?.progressBytes ?? 0
  const percent = stats?.finished ? 100 : Math.min(100, (progress / target) * 100)
  const remainingToTarget = Math.max(0, target - progress)
  const eta = formatEta(remainingToTarget, stats?.downloadRateBps ?? 0)
  // El POSTER del titulo es el fondo grande (no el backdrop): peticion del
  // usuario. Si no hay poster se recurre al backdrop/backdrop del episodio.
  const bg = info.posterUrl || info.backdropUrl
  const isDirect = !stats

  return (
    <div className={styles.overlay}>
      {bg && (
        <div
          className={styles.posterBg}
          style={{ backgroundImage: `url(${bg})` }}
        />
      )}
      <div className={styles.scrim} />

      <div className={styles.content}>
        <div className={styles.panel}>
          <h2 className={styles.title}>{info.title}</h2>
          {info.subtitle && <p className={styles.subtitle}>{info.subtitle}</p>}

          <p className={styles.hint}>
            {!isDirect && !stats?.ready
              ? 'Recibiendo metadatos del torrent…'
              : 'Preparando la transmisión…'}
          </p>

          <div className={styles.barTrack}>
            <div
              className={`${styles.barFill} ${!stats?.ready || isDirect ? styles.barIndeterminate : ''}`}
              style={{ width: !stats?.ready || isDirect ? undefined : `${percent}%` }}
            />
          </div>

          {!isDirect && stats && (
            <div className={styles.chips}>
              {stats.seeds != null && (
                <span className={styles.chip}>Seeds {stats.seeds}</span>
              )}
              <span className={styles.chip}>Peers {formatPeers(stats.peers, stats.peersConnecting)}</span>
              <span className={styles.chip}>{formatSpeed(stats.downloadRateBps)}</span>
              <span className={styles.chip}>ETA {eta}</span>
              {stats.totalBytes ? (
                <span className={styles.chip}>
                  {formatMb(progress)} / {formatMb(stats.totalBytes)}
                </span>
              ) : null}
              {stats.finished && <span className={styles.chip}>Completado</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
