import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CatalogItem } from '../api/types'
import {
  displayTitleOf,
  getCatalogPage,
  search,
} from '../api/client'
import { sendOverlayCtl } from './useOverlayState'
import type { OverlayItemSnapshot } from '../player/overlayBridge'
import styles from './OverlayApp.module.css'

const PAGE_SIZE = 60
const SEARCH_DEBOUNCE_MS = 350

interface OverlayGuideProps {
  snapshot: OverlayItemSnapshot
  onClose: () => void
}

/**
 * Guia dentro de la overlay: canales (catalogo + busqueda, cambio con un
 * clic via overlay://ctl play) o fuentes del evento (overlay://ctl
 * play-source). Vive en la webview overlay porque el video nativo tapa la
 * guia del main en modo wid.
 */
export function OverlayGuide({ snapshot, onClose }: OverlayGuideProps) {
  const isChannel = snapshot.kind === 'CHANNEL'
  const isEvent = snapshot.kind === 'EVENT'
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(isChannel)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Carga de catalogo o busqueda (solo canales; eventos usan snapshot.sources)
  useEffect(() => {
    if (!isChannel) return
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    const q = query.trim()
    setError(null)

    if (!q) {
      setLoading(true)
      getCatalogPage({ content_type: 'channels', page: 1, page_size: PAGE_SIZE })
        .then((r) => {
          setItems(r.items)
          setHasNext(r.has_next)
          setPage(1)
        })
        .catch((e: Error) => setError(e.message ?? 'Error cargando'))
        .finally(() => setLoading(false))
      return
    }

    setSearching(true)
    setLoading(true)
    searchTimeout.current = setTimeout(() => {
      search(q, 1, { types: 'channels' })
        .then((r) => {
          setItems(r.results)
          setHasNext(false)
          setPage(1)
        })
        .catch((e: Error) => setError(e.message ?? 'Error buscando'))
        .finally(() => {
          setSearching(false)
          setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current)
    }
  }, [query, isChannel])

  const loadMore = useCallback(() => {
    if (loading || !hasNext || query.trim()) return
    const next = page + 1
    getCatalogPage({ content_type: 'channels', page: next, page_size: PAGE_SIZE })
      .then((r) => {
        setItems((prev) => [...prev, ...r.items])
        setHasNext(r.has_next)
        setPage(next)
      })
      .catch(() => {})
  }, [page, hasNext, loading, query])

  const playChannel = useCallback((item: CatalogItem) => {
    if (item.stableId === snapshot.currentId) return
    sendOverlayCtl({ action: 'play', item })
  }, [snapshot.currentId])

  return (
    <aside className={styles.guide} aria-label={isEvent ? 'Fuentes del evento' : 'Guia de canales'}>
      <div className={styles.guideHead}>
        <h2 className={styles.guideTitle}>
          {isEvent ? 'Fuentes' : 'Guia'}
        </h2>
        <button className={styles.iconBtn} onClick={onClose} aria-label="Cerrar guia" title="Cerrar">
          <X size={18} />
        </button>
      </div>

      {isChannel && (
        <input
          className={styles.guideSearch}
          type="text"
          placeholder="Buscar canal..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}

      <div className={styles.guideList}>
        {isEvent ? (
          snapshot.sources.map((label, index) => (
            <div
              key={`${label}-${index}`}
              className={`${styles.guideRow} ${label === snapshot.label ? styles.guideRowCurrent : ''}`}
              onClick={() => {
                if (label !== snapshot.label) {
                  sendOverlayCtl({ action: 'play-source', index })
                }
              }}
            >
              <span className={styles.guideName}>{label}</span>
              {label === snapshot.label && <span className={styles.guideNow}>Activa</span>}
            </div>
          ))
        ) : loading ? (
          <div className={styles.guideStatus}>{searching ? 'Buscando...' : 'Cargando...'}</div>
        ) : error ? (
          <div className={styles.guideStatus}>{error}</div>
        ) : items.length === 0 ? (
          <div className={styles.guideStatus}>Sin resultados</div>
        ) : (
          <>
            {items.map((item) => {
              const isCurrent = item.stableId === snapshot.currentId
              return (
                <div
                  key={item.stableId}
                  className={`${styles.guideRow} ${isCurrent ? styles.guideRowCurrent : ''}`}
                  onClick={() => playChannel(item)}
                >
                  <span className={styles.guideName} title={displayTitleOf(item)}>
                    {displayTitleOf(item)}
                  </span>
                  {item.channelNumber != null && (
                    <span className={styles.guideMeta}>{item.channelNumber}</span>
                  )}
                  {isCurrent && <span className={styles.guideNow}>Ahora</span>}
                </div>
              )
            })}
            {hasNext && !query.trim() && (
              <button className={styles.guideMore} onClick={loadMore}>
                Cargar mas
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
