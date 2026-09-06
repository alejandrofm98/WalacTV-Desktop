import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Heart, X } from 'lucide-react'
import type { CatalogItem } from '../../api/types'
import {
  getCatalogPage,
  getGroups,
  getFavorites,
  addFavorite,
  removeFavorite,
  search,
  HARDCODED_COUNTRIES,
  countryLabelFor,
} from '../../api/client'
import { useAppStore } from '../../store/useAppStore'
import { SearchableSelect } from '../SearchableSelect'
import { SearchInput } from '../SearchInput'
import styles from './PlayerChannelGuide.module.css'

const PAGE_SIZE = 48
const SEARCH_DEBOUNCE_MS = 350

interface PlayerChannelGuideProps {
  currentId: string
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

/**
 * Guia lateral de canales dentro del reproductor.
 * Permite buscar por nombre, filtrar por pais/grupo y cambiar de canal
 * sin salir del player. Solo se muestra con contenido CHANNEL.
 */
export function PlayerChannelGuide({ currentId }: PlayerChannelGuideProps) {
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
  const currentRowRef = useRef<HTMLDivElement | null>(null)

  const openPlayer = useAppStore((s) => s.openPlayer)
  const setGuideOpen = useAppStore((s) => s.setGuideOpen)
  const setGuideChannels = useAppStore((s) => s.setGuideChannels)

  // Load favorites on mount
  useEffect(() => {
    getFavorites()
      .then((r) => setFavorites(new Set((r ?? []).map((f) => f.stableId))))
      .catch(() => {})
  }, [])

  // Reload groups when country changes
  useEffect(() => {
    setGroup(undefined)
    getGroups('channels', country)
      .then((r) => setGroups(r.groups ?? []))
      .catch(() => {})
  }, [country])

  // Load items or search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    setLoading(true)
    setPage(1)
    setError(null)

    if (!query.trim()) {
      getCatalogPage({ content_type: 'channels', country, group, page: 1, page_size: PAGE_SIZE })
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
      search(query.trim(), 1, { country, group, types: 'channels' })
        .then((r) => {
          setItems(r.results)
          setHasNext(false)
          setPage(1)
        })
        .catch((e) => setError(e.message ?? 'Error buscando'))
        .finally(() => {
          setSearching(false)
          setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current)
    }
  }, [country, group, query])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasNext) return
    const next = page + 1
    setLoadError(false)
    setLoadingMore(true)
    getCatalogPage({ content_type: 'channels', country, group, page: next, page_size: PAGE_SIZE })
      .then((r) => {
        setItems((prev) => [...prev, ...r.items])
        setHasNext(r.has_next)
        setPage(next)
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoadingMore(false))
  }, [page, country, group, hasNext, loadingMore])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNext && !loading && !loadingMore && !loadError) {
          loadMore()
        }
      },
      { threshold: 0.1 },
    )
    const target = observerTarget.current
    if (target) observer.observe(target)
    return () => { if (target) observer.unobserve(target) }
  }, [loadMore, hasNext, loading, loadingMore, loadError])

  const displayed = useMemo(
    () => (showFavs ? items.filter((i) => favorites.has(i.stableId)) : items),
    [items, showFavs, favorites],
  )

  // Expose the visible list so the transport buttons can zap between channels
  useEffect(() => {
    setGuideChannels(displayed)
  }, [displayed, setGuideChannels])

  // Keep the playing channel in view when it changes (zapping)
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentId])

  function toggleFavorite(item: CatalogItem) {
    const id = item.stableId
    if (togglingFav) return
    setTogglingFav(id)
    if (favorites.has(id)) {
      removeFavorite(id)
        .then(() => {
          setFavorites((prev) => { const n = new Set(prev); n.delete(id); return n })
        })
        .catch(() => {})
        .finally(() => setTogglingFav(null))
    } else {
      addFavorite(id)
        .then(() => {
          setFavorites((prev) => new Set(prev).add(id))
        })
        .catch(() => {})
        .finally(() => setTogglingFav(null))
    }
  }

  const activeCountryLabel = country
    ? (HARDCODED_COUNTRIES.find((c) => c.value === country)?.label ?? country)
    : null

  return (
    <aside className={styles.guide} aria-label="Guia de canales">
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>Guia</h2>
          <span className={styles.count}>
            {loading ? 'Cargando...' : `${displayed.length} canales`}
          </span>
          <button
            className={styles.closeBtn}
            onClick={() => setGuideOpen(false)}
            aria-label="Ocultar guia de canales"
            title="Ocultar guia"
          >
            <X size={18} />
          </button>
        </div>
        <SearchInput placeholder="Buscar por nombre..." value={query} onChange={setQuery} />
        <div className={styles.filters}>
          <SearchableSelect
            label="Pais"
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
        </div>
        <button
          className={`${styles.favChip} ${showFavs ? styles.favChipActive : ''}`}
          onClick={() => setShowFavs((v) => !v)}
          aria-pressed={showFavs}
        >
          Solo favoritos
        </button>
      </div>

      <div className={styles.list} role="listbox" aria-label="Canales">
        {loading ? (
          <div className={styles.status}>{searching ? 'Buscando...' : 'Cargando...'}</div>
        ) : error ? (
          <div className={styles.status}>{error}</div>
        ) : displayed.length === 0 ? (
          <div className={styles.status}>Sin resultados</div>
        ) : (
          displayed.map((item) => {
            const isCurrent = item.stableId === currentId
            const isFav = favorites.has(item.stableId)
            const countryLabel = countryLabelFor(item.countries?.[0]) ?? activeCountryLabel
            const meta = [countryLabel, item.group || null].filter(Boolean).join(' · ')
            return (
              <div
                key={item.stableId}
                ref={isCurrent ? currentRowRef : undefined}
                className={`${styles.row} ${isCurrent ? styles.rowCurrent : ''}`}
                role="option"
                aria-selected={isCurrent}
                tabIndex={0}
                onClick={() => { if (!isCurrent) openPlayer(item) }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !isCurrent) {
                    e.preventDefault()
                    openPlayer(item)
                  }
                }}
              >
                {item.channelNumber != null && (
                  <span className={styles.num}>{item.channelNumber}</span>
                )}
                <span className={styles.thumb}>
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <span className={styles.thumbFallback} aria-hidden="true">
                      {initialsOf(item.tmdbTitle ?? item.title)}
                    </span>
                  )}
                </span>
                <span className={styles.texts}>
                  <span className={styles.name} title={item.tmdbTitle ?? item.title}>
                    {item.tmdbTitle ?? item.title}
                  </span>
                  {meta && (
                    <span className={styles.meta} title={meta}>{meta}</span>
                  )}
                  {isCurrent && <span className={styles.now}>Reproduciendo ahora</span>}
                </span>
                <button
                  type="button"
                  className={`${styles.favBtn} ${isFav ? styles.favActive : ''}`}
                  disabled={togglingFav === item.stableId}
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(item) }}
                  aria-label={isFav ? 'Quitar de favoritos' : 'Anadir a favoritos'}
                  title={isFav ? 'Quitar de favoritos' : 'Anadir a favoritos'}
                >
                  <Heart size={15} fill={isFav ? 'currentColor' : 'none'} />
                </button>
              </div>
            )
          })
        )}
        {hasNext && !loading && !error && (
          <div ref={observerTarget} className={styles.sentinel} />
        )}
        {loadingMore && <div className={styles.status}>Cargando mas...</div>}
        {loadError && (
          <button onClick={loadMore} className={styles.retryBtn}>
            Error. Reintentar
          </button>
        )}
      </div>
    </aside>
  )
}
