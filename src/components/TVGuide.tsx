import { useState, useEffect, useRef, useCallback } from 'react'
import type { CatalogItem } from '../api/types'
import { getCatalogPage, getGroups, getFavorites, addFavorite, removeFavorite, search, HARDCODED_COUNTRIES } from '../api/client'
import { ChannelCard } from './ChannelCard'
import { SearchableSelect } from './SearchableSelect'
import { useAppStore } from '../store/useAppStore'
import styles from './TVGuide.module.css'

interface Props {
  contentType: 'CHANNEL' | 'EVENT'
}

export function TVGuide({ contentType }: Props) {
  const [items, setItems] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [country, setCountry] = useState<string | undefined>()
  const [group, setGroup] = useState<string | undefined>()
  const [groups, setGroups] = useState<string[]>([])
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [showFavs, setShowFavs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [togglingFav, setTogglingFav] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const observerTarget = useRef<HTMLDivElement>(null)
  const openPlayer = useAppStore((s) => s.openPlayer)

  const apiType = contentType === 'CHANNEL' ? 'channels' : 'events'

  // Load favorites on mount
  useEffect(() => {
    if (contentType === 'CHANNEL') {
      getFavorites().then((r) => {
        setFavorites(new Set((r ?? []).map((f) => f.stableId)))
      }).catch(() => {})
    }
  }, [apiType, contentType])

  // Reload groups when country changes
  useEffect(() => {
    setGroup(undefined)
    getGroups(apiType, country).then((r) => setGroups(r.groups ?? [])).catch(() => {})
  }, [apiType, country])

  // Load items or search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    setLoading(true)
    setPage(1)
    setError(null)

    if (!query.trim()) {
      getCatalogPage({ content_type: apiType, country, group, page: 1, page_size: 48 })
        .then((r) => {
          setItems(r.items)
          setHasNext(r.has_next)
        })
        .catch((e) => setError(e.message ?? 'Error cargando'))
        .finally(() => setLoading(false))
      return
    }

    setSearching(true)
    searchTimeout.current = setTimeout(() => {
      search(query.trim(), 1, { country, group })
        .then((r) => {
          const filtered = r.results.filter((item) => item.kind === 'CHANNEL')
          setItems(filtered)
          setHasNext(false)
          setPage(1)
        })
        .catch((e) => setError(e.message ?? 'Error buscando'))
        .finally(() => {
          setSearching(false)
          setLoading(false)
        })
    }, 350)

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current)
    }
  }, [apiType, country, group, query])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasNext) return
    const next = page + 1
    setLoadError(false)
    setLoadingMore(true)
    getCatalogPage({ content_type: apiType, country, group, page: next, page_size: 48 })
      .then((r) => {
        setItems((prev) => [...prev, ...r.items])
        setHasNext(r.has_next)
        setPage(next)
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoadingMore(false))
  }, [page, apiType, country, group, hasNext, loadingMore])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNext && !loading && !loadingMore && !loadError) {
          loadMore()
        }
      },
      { threshold: 0.1 }
    )
    const target = observerTarget.current
    if (target) observer.observe(target)
    return () => { if (target) observer.unobserve(target) }
  }, [loadMore, hasNext, loading, loadingMore, loadError])

  function toggleFavorite(item: CatalogItem) {
    const id = item.stableId
    setTogglingFav(id)
    if (favorites.has(id)) {
      removeFavorite(id).then(() => {
        setFavorites((prev) => { const n = new Set(prev); n.delete(id); return n })
      }).catch(() => {}).finally(() => setTogglingFav(null))
    } else {
      addFavorite(id).then(() => {
        setFavorites((prev) => new Set(prev).add(id))
      }).catch(() => {}).finally(() => setTogglingFav(null))
    }
  }

  return (
    <div className={styles.container}>
      {/* Filters bar */}
      <div className={styles.filtersBar}>
        <span className={styles.filtersTitle}>
          {contentType === 'CHANNEL' ? 'TV en vivo' : 'Eventos'}
        </span>

        <SearchableSelect
          label="País"
          options={HARDCODED_COUNTRIES}
          value={country}
          onChange={setCountry}
        />
        <SearchableSelect
          label="Grupo"
          options={groups}
          value={group}
          onChange={setGroup}
        />
        {contentType === 'CHANNEL' && (
          <button
            onClick={() => setShowFavs(!showFavs)}
            className={`${styles.favBtn} ${showFavs ? styles.favBtnActive : styles.favBtnDefault}`}
          >
            ⭐ Favoritos
          </button>
        )}
        <div className={styles.searchBox}>
          <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Buscar canales..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className={styles.searchClear} onClick={() => setQuery('')} aria-label="Limpiar búsqueda">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className={styles.gridScroll}>
        {loading ? (
          <div className={styles.loadingText}>{searching ? 'Buscando...' : 'Cargando...'}</div>
        ) : error ? (
          <div className={styles.loadingText}>{error}</div>
        ) : items.length === 0 ? (
          <div className={styles.loadingText}>Sin resultados</div>
        ) : (
          <>
            <div className={styles.grid}>
              {items
                .filter((i) => !showFavs || favorites.has(i.stableId))
                .map((item) => (
                <ChannelCard
                  key={item.stableId}
                  item={item}
                  isFavorite={favorites.has(item.stableId)}
                  toggling={togglingFav === item.stableId}
                  onClick={() => openPlayer(item)}
                  onToggleFavorite={contentType === 'CHANNEL' ? toggleFavorite : undefined}
                />
              ))}
            </div>
            {hasNext && <div ref={observerTarget} style={{ height: 20, width: '100%', marginTop: 20 }} />}
            {loadingMore && <div className={styles.loadingText}>Cargando más...</div>}
            {loadError && (
              <button onClick={loadMore} className={styles.loadMoreBtn}>
                Error. Reintentar
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
