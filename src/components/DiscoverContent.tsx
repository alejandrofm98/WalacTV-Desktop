import { useState, useEffect, useRef, useCallback } from 'react'
import type { CatalogItem, WatchProgressItem } from '../api/types'
import { getAllSeriesEpisodes, getCatalogPage, getGenres, getUfcReplays, getWatchedItems, applyWatchedToItems, markSeriesEpisodesWatched, markWatched, search } from '../api/client'
import { MediaCard } from './MediaCard'
import { SearchableSelect } from './SearchableSelect'
import { SearchInput } from './SearchInput'
import { useAppStore } from '../store/useAppStore'
import styles from './DiscoverContent.module.css'

const LANGUAGES = [
  { value: 'ES', label: 'Español' },
  { value: 'EN', label: 'Inglés' },
]

export function DiscoverContent() {
  const [type, setType] = useState<'movies' | 'series' | 'ufc'>('movies')
  const [country, setCountry] = useState<string | undefined>()
  const [genre, setGenre] = useState<string | undefined>()
  const [genres, setGenres] = useState<string[]>([])
  const [items, setItems] = useState<CatalogItem[]>([])
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [query, setQuery] = useState('')
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchedRef = useRef<WatchProgressItem[]>([])
  const openDetail = useAppStore((s) => s.openDetail)
  const detailOpen = useAppStore((s) => !!s.detailItem)
  const observerTarget = useRef<HTMLDivElement>(null)

  const applyWatched = useCallback((list: CatalogItem[]) => applyWatchedToItems(list, watchedRef.current), [])

  // Carga global de "vistos" para marcar el tick en los posters
  useEffect(() => {
    getWatchedItems(500)
      .then((w) => {
        watchedRef.current = w.items
        setItems((current) => applyWatchedToItems(current, w.items))
      })
      .catch(() => {})
  }, [applyWatched])

  // Reload genres when country changes, reload items on any filter change
  useEffect(() => {
    if (type === 'ufc') {
      setGenres([])
      return
    }
    getGenres(type, country).then((r) => setGenres(r.genres ?? [])).catch(() => {})
  }, [type, country])

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    setLoading(true)
    setPage(1)
    setError(null)

    if (type === 'ufc') {
      getUfcReplays(1, query.trim() || undefined)
        .then((r) => { setItems(applyWatched(r.items)); setHasNext(r.has_next) })
        .catch((e) => setError(e.message ?? 'Error'))
        .finally(() => setLoading(false))
      return
    }

    if (!query.trim()) {
      getCatalogPage({ content_type: type, country, genre, page: 1, page_size: 48 })
        .then((r) => { setItems(applyWatched(r.items)); setHasNext(r.has_next) })
        .catch((e) => setError(e.message ?? 'Error'))
        .finally(() => setLoading(false))
      return
    }

    searchTimeout.current = setTimeout(() => {
      search(query.trim(), 1, { country, types: type, genre })
        .then((r) => {
          setItems(applyWatched(r.results))
          setHasNext(false)
          setPage(1)
        })
        .catch((e) => setError(e.message ?? 'Error buscando'))
        .finally(() => setLoading(false))
    }, 350)

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current)
    }
  }, [type, country, genre, query])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasNext) return
    const next = page + 1
    setLoadingMore(true)
    setLoadError(false)
    const request = type === 'ufc'
      ? getUfcReplays(next, query.trim() || undefined)
      : getCatalogPage({ content_type: type, country, genre, page: next, page_size: 48 })
    request
      .then((r) => { setItems((p) => applyWatched([...p, ...r.items])); setHasNext(r.has_next); setPage(next) })
      .catch(() => setLoadError(true))
      .finally(() => setLoadingMore(false))
  }, [page, type, country, genre, query, hasNext, loadingMore, applyWatched])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNext && !loading && !loadingMore && !loadError && !detailOpen) {
          loadMore()
        }
      },
      { threshold: 0.1 }
    )

    const target = observerTarget.current
    if (target) {
      observer.observe(target)
    }

    return () => {
      if (target) {
        observer.unobserve(target)
      }
    }
  }, [loadMore, hasNext, loading, loadingMore, loadError, detailOpen])

  const handleMarkWatched = useCallback(async (item: CatalogItem) => {
    try {
      if (item.kind === 'SERIES') {
        const episodes = await getAllSeriesEpisodes(item.stableId)
        await markSeriesEpisodesWatched(item.stableId, episodes)
      } else {
        await markWatched(item.stableId)
      }
      setItems((current) => current.map((entry) => entry.stableId === item.stableId ? { ...entry, isWatched: true } : entry))
    } catch (err) {
      console.error('mark catalog item watched failed', err)
    }
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <h2 className={styles.title}>Descubrir</h2>

        {/* Filters */}
        <div className={styles.filtersBar}>
          <div className={styles.typeToggle}>
            <button
              className={`${styles.typeBtn} ${type === 'movies' ? styles.typeBtnActive : ''}`}
              onClick={() => setType('movies')}
            >Peliculas</button>
            <button
              className={`${styles.typeBtn} ${type === 'series' ? styles.typeBtnActive : ''}`}
              onClick={() => setType('series')}
            >Series</button>
            <button
              className={`${styles.typeBtn} ${type === 'ufc' ? styles.typeBtnActive : ''}`}
              onClick={() => setType('ufc')}
            >UFC</button>
          </div>
          {type !== 'ufc' && <SearchableSelect label="Idioma" options={LANGUAGES} value={country} onChange={setCountry} />}
          {type !== 'ufc' && <SearchableSelect label="Género" options={genres} value={genre} onChange={setGenre} />}
          <SearchInput
            placeholder={type === 'ufc' ? 'Buscar eventos UFC...' : type === 'movies' ? 'Buscar peliculas...' : 'Buscar series...'}
            value={query}
            onChange={setQuery}
          />
        </div>

        {loading ? (
          <div className={styles.loadingText}>Cargando...</div>
        ) : error ? (
          <div className={styles.loadingText}>{error}</div>
        ) : items.length === 0 ? (
          <div className={styles.loadingText}>Sin resultados</div>
        ) : (
          <>
            <div className={styles.grid}>
              {items.map((item) => (
                <MediaCard
                  key={item.stableId}
                  item={item}
                  width={180}
                  height={284}
                  showText
                  onClick={() => openDetail(item)}
                  onMarkWatched={type === 'ufc' ? undefined : () => handleMarkWatched(item)}
                />
              ))}
            </div>
            
            {/* Observer Target for Infinite Scroll */}
            <div ref={observerTarget} style={{ height: 20, width: '100%', marginTop: 20 }} />

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
