import { useState, useRef, useEffect } from 'react'
import type { CatalogItem } from '../api/types'
import { search as apiSearch } from '../api/client'
import { MediaCard } from './MediaCard'
import { useAppStore } from '../store/useAppStore'
import styles from './SearchContent.module.css'

export function SearchContent() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const openDetail = useAppStore((s) => s.openDetail)
  const openPlayer = useAppStore((s) => s.openPlayer)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    let cancelled = false
    const timer = setTimeout(() => {
      setLoading(true)
      apiSearch(query)
        .then((r) => { if (!cancelled) setResults(r.results ?? []) })
        .catch(() => { if (!cancelled) setResults([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 300)
    return () => { clearTimeout(timer); cancelled = true }
  }, [query])

  function handleClick(item: CatalogItem) {
    if (item.kind === 'MOVIE' || item.kind === 'SERIES') openDetail(item)
    else openPlayer(item)
  }

  return (
    <div className={styles.container}>
      <div className={styles.searchBar}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar peliculas, series, canales..."
          className={styles.searchInput}
        />
      </div>

      <div className={styles.resultsScroll}>
        {loading ? (
          <div className={styles.loadingText}>Buscando...</div>
        ) : results.length > 0 ? (
          <div className={styles.grid}>
            {results.map((item) => (
              <MediaCard
                key={item.stableId}
                item={item}
                width={180}
                height={260}
                onClick={() => handleClick(item)}
              />
            ))}
          </div>
        ) : query.trim() ? (
          <div className={styles.loadingText}>Sin resultados</div>
        ) : (
          <div className={styles.loadingText}>Escribe para buscar</div>
        )}
      </div>
    </div>
  )
}
