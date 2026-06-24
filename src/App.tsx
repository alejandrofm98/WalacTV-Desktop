import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from './store/useAppStore'
import { login as apiLogin, setToken, getToken, getHomeCatalog, getWatchProgress, getPreferredLanguage } from './api/client'
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
import { Player } from './components/Player'
import { MovieDetail } from './components/MovieDetail'
import { SeriesDetail } from './components/SeriesDetail'
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

  async function loadData() {
    useAppStore.setState({ loading: true, error: null })
    try {
      const lang = getPreferredLanguage()
      const [home, cw] = await Promise.all([
        getHomeCatalog(lang).catch(() => null),
        getWatchProgress(20).catch(() => ({ items: [] })),
      ])

      let hero: CatalogItem | null = null
      if (home) {
        setHomeSections(home.sections)
        hero = home.sections
          .flatMap((s) => s.items)
          .find((i) => i.kind === 'MOVIE' || i.kind === 'SERIES') ?? null
      }

      if (cw?.items) {
        const map = new Map<string, WatchProgressItem>()
        for (const item of cw.items) {
          map.set(item.contentId, item)
        }
        setContinueWatching(map)
        if (!hero && cw.items.length > 0) {
          const e = cw.items[0]
          hero = {
            stableId: e.contentId,
            title: e.title,
            subtitle: e.seriesName || '',
            description: '',
            imageUrl: e.imageUrl,
            tmdbPosterUrl: e.tmdbPosterUrl,
            backdropUrl: e.backdropUrl,
            kind: (e.contentType === 'series' ? 'SERIES' : 'MOVIE') as CatalogItem['kind'],
            group: '',
            badgeText: '',
            streamOptions: [],
            genres: [],
            seasonNumber: e.seasonNumber,
            episodeNumber: e.episodeNumber,
          }
        }
      }

      setSelectedHero(hero)
    } catch (e: any) {
      setError(e.message ?? 'Error cargando datos')
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
    } catch (e: any) {
      useAppStore.setState({ authError: e.message, signingIn: false })
      throw e
    }
  }

  // Keyboard: Escape to close overlays
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (playerItem) { useAppStore.getState().closePlayer(); return }
        if (detailItem) { useAppStore.getState().closeDetail(); return }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playerItem, detailItem])

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
          {detailItem?.kind === 'MOVIE' && <MovieDetail item={detailItem} />}
          {detailItem?.kind === 'SERIES' && <SeriesDetail item={detailItem} />}
          {!detailItem && mode === 'Home' && <HomeContent />}
          {!detailItem && mode === 'TV' && <TVGuide contentType="CHANNEL" />}
          {!detailItem && mode === 'Events' && <EventsContent />}
          {!detailItem && mode === 'Discover' && <DiscoverContent />}
          {!detailItem && mode === 'Search' && <SearchContent />}
          {!detailItem && mode === 'Settings' && <SettingsContent onSignOut={signOut} />}
        </main>
        {playerItem && <Player />}
      </div>
    </div>
  )
}
