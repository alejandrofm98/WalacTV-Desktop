import { X } from 'lucide-react'
import type { CatalogItem, StreamOption } from '../../api/types'
import { useAppStore } from '../../store/useAppStore'
import { usePlayerStore } from '../../player/usePlayerStore'
import styles from './PlayerEventSources.module.css'

interface PlayerEventSourcesProps {
  item: CatalogItem
}

function sourceMeta(o: StreamOption): string {
  const parts: (string | null)[] = [
    o.language ?? null,
    o.quality ?? null,
    o.provider ?? o.source ?? null,
    o.seeders != null ? `${o.seeders} seeds` : null,
  ]
  return parts.filter((p): p is string => p != null && p !== '').join(' · ')
}

/**
 * Panel lateral de fuentes para eventos en directo: lista los streams del
 * evento (idioma, calidad, proveedor) y permite cambiar de fuente sin salir
 * del reproductor, igual que la guia de canales pero solo con las fuentes
 * del propio evento.
 */
export function PlayerEventSources({ item }: PlayerEventSourcesProps) {
  const setGuideOpen = useAppStore((s) => s.setGuideOpen)
  const openPlayer = useAppStore((s) => s.openPlayer)
  const currentIndex = usePlayerStore((s) => s.currentSourceIndex)

  const options = item.streamOptions ?? []

  return (
    <aside className={styles.panel} aria-label="Fuentes del evento">
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Fuentes</h2>
          <span className={styles.count}>{options.length}</span>
          <button
            className={styles.closeBtn}
            onClick={() => setGuideOpen(false)}
            aria-label="Ocultar fuentes del evento"
            title="Ocultar fuentes"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className={styles.list} role="listbox" aria-label="Fuentes">
        {options.length === 0 ? (
          <div className={styles.empty}>Sin fuentes disponibles</div>
        ) : (
          options.map((o, i) => {
            const isCurrent = i === currentIndex
            const meta = sourceMeta(o)
            return (
              <div
                key={`${o.label}-${i}`}
                className={`${styles.row} ${isCurrent ? styles.rowCurrent : ''}`}
                role="option"
                aria-selected={isCurrent}
                tabIndex={0}
                onClick={() => { if (!isCurrent) openPlayer({ ...item }, i) }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !isCurrent) {
                    e.preventDefault()
                    openPlayer({ ...item }, i)
                  }
                }}
              >
                <span className={styles.num}>{i + 1}</span>
                <span className={styles.texts}>
                  <span className={styles.name} title={o.torrentTitle ?? o.label}>
                    {o.label}
                  </span>
                  {meta && (
                    <span className={styles.meta} title={meta}>{meta}</span>
                  )}
                  {isCurrent && <span className={styles.now}>Reproduciendo ahora</span>}
                </span>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
