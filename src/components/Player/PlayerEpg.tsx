import styles from './PlayerEpg.module.css'

export interface EpgProgram {
  title: string
  startTime: string
  endTime: string
}

export interface EpgData {
  now?: EpgProgram
  next?: EpgProgram
}

interface PlayerEpgProps {
  epg: EpgData | null
}

function formatEpgTime(raw: string): string {
  const d = new Date(raw)
  if (isNaN(d.getTime())) return raw
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
}

/**
 * "Ahora / Siguiente" EPG overlay for live channels.
 * Renders nothing when there is no EPG data.
 */
export function PlayerEpg({ epg }: PlayerEpgProps) {
  if (!epg || (!epg.now && !epg.next)) return null

  return (
    <div className={styles.epg}>
      {epg.now && (
        <div className={styles.row}>
          <span className={styles.label}>Ahora</span>
          <span className={styles.program}>{epg.now.title}</span>
          <span className={styles.time}>
            {formatEpgTime(epg.now.startTime)} - {formatEpgTime(epg.now.endTime)}
          </span>
        </div>
      )}
      {epg.next && (
        <div className={`${styles.row} ${styles.rowNext}`}>
          <span className={styles.label}>Siguiente</span>
          <span className={styles.program}>{epg.next.title}</span>
          <span className={styles.time}>
            {formatEpgTime(epg.next.startTime)} - {formatEpgTime(epg.next.endTime)}
          </span>
        </div>
      )}
    </div>
  )
}
