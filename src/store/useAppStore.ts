import { create } from 'zustand'
import type { CatalogItem, WatchProgressItem, BrowseSection, MainMode } from '../api/types'
import { setToken } from '../api/client'
import { clearCredentials } from '../credentials'
import type { UpdateInfo } from '../updater'

interface AppState {
  mode: MainMode
  previousMode: MainMode
  setMode: (m: MainMode) => void

  signedIn: boolean
  username: string
  token: string
  authError: string | null
  signingIn: boolean
  signOut: () => void

  loading: boolean
  error: string | null
  setError: (e: string | null) => void

  homeSections: BrowseSection[]
  continueWatchingEntries: Map<string, WatchProgressItem>
  selectedHero: CatalogItem | null

  setHomeSections: (s: BrowseSection[]) => void
  setContinueWatching: (entries: Map<string, WatchProgressItem>) => void
  setSelectedHero: (h: CatalogItem | null) => void

  playerItem: CatalogItem | null
  playerStreamIndex: number
  playerStartPosition: number
  playerOpening: boolean
  openPlayer: (item: CatalogItem, streamIndex?: number, startPosition?: number) => void
  closePlayer: () => void

  detailItem: CatalogItem | null
  openDetail: (item: CatalogItem) => void
  closeDetail: () => void

  railExpanded: boolean
  setRailExpanded: (e: boolean) => void

  updateInfo: UpdateInfo | null
  updateChecking: boolean
  updateDismissed: boolean
  setUpdateInfo: (info: UpdateInfo | null) => void
  setUpdateChecking: (v: boolean) => void
  dismissUpdate: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: 'Home',
  previousMode: 'Home',
  setMode: (mode) => set((state) => ({ mode, previousMode: state.mode, detailItem: null })),

  signedIn: false,
  username: '',
  token: '',
  authError: null,
  signingIn: false,
  signOut: () => {
    localStorage.removeItem('walactv_token')
    localStorage.removeItem('walactv_username')
    clearCredentials().catch(() => {})
    setToken('')
    set({ signedIn: false, token: '', username: '', mode: 'Home' })
  },

  loading: false,
  error: null,
  setError: (error) => set({ error }),

  homeSections: [],
  continueWatchingEntries: new Map(),
  selectedHero: null,

  setHomeSections: (homeSections) => set({ homeSections }),
  setContinueWatching: (continueWatchingEntries) => set({ continueWatchingEntries }),
  setSelectedHero: (selectedHero) => set({ selectedHero }),

  playerItem: null,
  playerStreamIndex: 0,
  playerStartPosition: 0,
  playerOpening: false,
  openPlayer: (item, streamIndex = 0, startPosition = 0) => {
    const { playerOpening } = get()
    if (playerOpening) return
    set({ playerOpening: true, playerItem: item, playerStreamIndex: streamIndex, playerStartPosition: startPosition })
  },
  closePlayer: () => set({ playerItem: null, playerOpening: false }),

  detailItem: null,
  openDetail: (item) => {
    const currentMode = get().mode
    set({ detailItem: item, previousMode: currentMode })
  },
  closeDetail: () => {
    const prev = get().previousMode
    set({ detailItem: null, mode: prev })
  },

  railExpanded: true,
  setRailExpanded: (railExpanded) => set({ railExpanded }),

  updateInfo: null,
  updateChecking: false,
  updateDismissed: false,
  setUpdateInfo: (updateInfo) => set({ updateInfo }),
  setUpdateChecking: (updateChecking) => set({ updateChecking }),
  dismissUpdate: () => set({ updateDismissed: true }),
}))
