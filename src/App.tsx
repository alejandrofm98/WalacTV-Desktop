import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from './store/useAppStore'
import { login as apiLogin, setToken, getToken, getHomeCatalog, getHomeContinueWatching, getWatchedItems, applyWatchedState, getPreferredLanguage, cwGroupKey } from './api/client'
import { loadCredentials } from './credentials'
import { checkForUpdates } from './updater'
import { LoginScreen } from './components/LoginScreen'
import { SideRail } from './components/SideRail'
import { HomeContent } from './components/HomeContent'
import { TVGuide } from './components/TVGuide'
import { EventsContent } from './components/EventsContent'
import { DiscoverContent } from './components/DiscoverContent'
import { SearchContent } from './components/SearchContent'
import { SettingsContent } from './components/SettingsContent'
import { Player } from './components/Player/Player'
import { MovieDetail } from './components/MovieDetail'
import { SeriesDetail } from './components/SeriesDetail'
import { EventDetail } from './components/EventDetail'
import { LoadingScreen } from './components/LoadingScreen'
import { ErrorScreen } from './components/ErrorScreen'
import { UpdateBanner } from './components/UpdateBanner/UpdateBanner'
import type { CatalogItem, WatchProgressItem } from './api/types'
import styles from './App.module.css'

export default function App() {
  const {
    signedIn, loading, error, mode, playerItem, detailItem, railExpanded,
    signOut, setMode, setHomeSections, setContinueWatching,
    setSelectedHero, setError, setRailExpanded,
  } = useAppStore()

  // Fetch monitor scale info and apply CSS variable
  useEffect(() => {
    invoke<{ scale_factor: number }>('get_scale_info')
      .then(info => {
        document.documentElement.style.setProperty('--app-scale', String(info.scale_factor))
      })
      .catch(() => {})
  }, [])

  // Initialize token from secure store
  useEffect(() => {
    const saved = localStorage.getItem('walactv_token')
    const savedUser = localStorage.getItem('walactv_username')
    if (saved && savedUser) {
      setToken(saved)
      loadCredentials().catch(() => {})
      useAppStore.setState({ signedIn: true, token: saved, username: savedUser })
      loadData()
    }
  }, [])

  // Check for app updates on startup (non-blocking, independent of auth/data)
  useEffect(() => {
    useAppStore.setState({ updateChecking: true })
    checkForUpdates()
      .then((info) => useAppStore.setState({ updateInfo: info }))
      .finally(() => useAppStore.setState({ updateChecking: false }))
  }, [])

  // Shared CW map builder: sort desc by lastWatchedAt, group by cwGroupKey, keep first per key.
  function buildCwMap(items: WatchProgressItem[]): Map<string, WatchProgressItem> {
    const sorted = [...items].sort((a, b) =>
      (b.lastWatchedAt || '').localeCompare(a.lastWatchedAt || ''),
    )
    const map = new Map<string, WatchProgressItem>()
    for (const item of sorted) {
      const key = cwGroupKey(item.contentType, item.seriesName, item.contentId)
      if (!map.has(key)) map.set(key, item)
    }
    return map
  }

  async function loadData() {
    useAppStore.setState({ loading: true, error: null })
    try {
      const lang = getPreferredLanguage()
      const [home, cw, watched] = await Promise.all([
        getHomeCatalog(lang).catch(() => null),
        getHomeContinueWatching(20).catch(() => ({ items: [] })),
        getWatchedItems(500).catch(() => ({ items: [] })),
      ])

      let hero: CatalogItem | null = null
      if (home) {
        const sections = watched.items.length ? applyWatchedState(home.sections, watched.items) : home.sections
        setHomeSections(sections)
        hero = sections
          .flatMap((s) => s.items)
          .find((i) => i.kind === 'MOVIE' || i.kind === 'SERIES') ?? null
      }

      if (cw?.items) {
        const map = buildCwMap(cw.items)
        setContinueWatching(map)
        const cwSorted = [...cw.items].sort((a, b) =>
          (b.lastWatchedAt || '').localeCompare(a.lastWatchedAt || ''),
        )
        if (!hero && cwSorted.length > 0) {
          const e = cwSorted[0]
          hero = {
            stableId: cwGroupKey(e.contentType, e.seriesName, e.contentId),
            title: e.title,
            subtitle: e.seriesName || '',
            description: e.overview ?? '',
            imageUrl: e.imageUrl,
            tmdbPosterUrl: e.tmdbPosterUrl,
            backdropUrl: e.backdropUrl,
            kind: (e.contentType === 'series' ? 'SERIES' : 'MOVIE') as CatalogItem['kind'],
            group: '',
            badgeText: '',
            streamOptions: [],
            genres: e.genres ?? [],
            seasonNumber: e.seasonNumber,
            episodeNumber: e.episodeNumber,
            tmdbTitle: e.tmdbTitle,
            voteAverage: e.voteAverage,
            voteCount: e.voteCount,
            runtimeMinutes: e.runtimeMinutes,
            year: e.year,
            totalSeasons: e.totalSeasons,
            tagline: e.tagline,
            releaseDate: e.releaseDate,
          }
        }
      }

      setSelectedHero(hero)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error cargando datos')
    } finally {
      useAppStore.setState({ loading: false })
    }
  }

  async function handleLogin(u: string, p: string) {
    useAppStore.setState({ signingIn: true, authError: null })
    try {
      await apiLogin(u, p)
      const token = getToken()
      localStorage.setItem('walactv_token', token)
      localStorage.setItem('walactv_username', u)
      useAppStore.setState({ signedIn: true, username: u, signingIn: false, token })
      await loadData()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Error de autenticacion'
      useAppStore.setState({ authError: message, signingIn: false })
      throw e
    }
  }

  // Keyboard: Escape to close overlays. Player has its own Escape handler.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (detailItem) { useAppStore.getState().closeDetail(); return }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailItem])

  // Refresh continue watching when the player closes.
  const prevPlayerItemRef = useRef(playerItem)
  useEffect(() => {
    const prev = prevPlayerItemRef.current
    prevPlayerItemRef.current = playerItem
    if (prev && !playerItem) {
      getHomeContinueWatching(20)
        .then((cw) => {
          if (cw?.items) setContinueWatching(buildCwMap(cw.items))
        })
        .catch(() => {})
    }
  }, [playerItem])

  if (!signedIn) return <LoginScreen onLogin={handleLogin} />
  if (loading) return <LoadingScreen />
  if (error) return <ErrorScreen message={error} onRetry={loadData} />

  return (
    <div className={styles.shell}>
      <UpdateBanner />
      <div className={styles.root}>
        <SideRail
          mode={mode}
          onModeChange={(m) => { setMode(m); setRailExpanded(false) }}
          expanded={railExpanded}
          onSetExpanded={setRailExpanded}
        />
        <main className={styles.main}>
          {detailItem && (
            <div className={styles.detailOverlay}>
              {detailItem.kind === 'MOVIE' && <MovieDetail item={detailItem} />}
              {detailItem.kind === 'SERIES' && <SeriesDetail item={detailItem} />}
              {detailItem.kind === 'EVENT' && <EventDetail item={detailItem} />}
            </div>
          )}
          {mode === 'Home' && <HomeContent />}
          {mode === 'TV' && <TVGuide contentType="CHANNEL" />}
          {mode === 'Events' && <EventsContent />}
          {mode === 'Discover' && <DiscoverContent />}
          {mode === 'Search' && <SearchContent />}
          {mode === 'Settings' && <SettingsContent onSignOut={signOut} />}
        </main>
        {playerItem && <Player />}
      </div>
    </div>
  )
}
