import { create } from 'zustand'
import type { CatalogItem, WatchProgressItem, BrowseSection, MainMode } from '../api/types'
import { setToken } from '../api/client'
import { clearCredentials } from '../credentials'
import { usePlayerStore } from '../player/usePlayerStore'
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
  removeContinueWatchingEntry: (key: string) => void
  setSelectedHero: (h: CatalogItem | null) => void

  playerItem: CatalogItem | null
  playerStreamIndex: number
  playerStartPosition: number
  playerOpening: boolean
  openPlayer: (item: CatalogItem, streamIndex?: number, startPosition?: number) => void
  closePlayer: () => void

  guideOpen: boolean
  setGuideOpen: (open: boolean) => void
  guideChannels: CatalogItem[]
  setGuideChannels: (channels: CatalogItem[]) => void
  /** Zapping estilo TV: canal siguiente (1) o anterior (-1) de la guia. */
  zapChannel: (dir: 1 | -1) => void
  /** Cambio de fuente (idioma/calidad) en eventos: siguiente (1) o anterior (-1). */
  zapSource: (dir: 1 | -1) => void

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
  removeContinueWatchingEntry: (key) => set((state) => {
    const next = new Map(state.continueWatchingEntries)
    next.delete(key)
    return { continueWatchingEntries: next }
  }),
  setSelectedHero: (selectedHero) => set({ selectedHero }),

  playerItem: null,
  playerStreamIndex: 0,
  playerStartPosition: 0,
  playerOpening: false,
  openPlayer: (item, streamIndex = 0, startPosition = 0) => {
    const { playerOpening, playerItem, playerStreamIndex } = get()
    // Ignora reaperturas del MISMO item con el MISMO indice (doble clic), pero
    // permite cambiar a otro item (zapping entre canales) o a otra fuente del
    // mismo item (panel de fuentes de eventos).
    if (
      playerOpening &&
      playerItem?.stableId === item.stableId &&
      playerStreamIndex === streamIndex
    ) {
      return
    }
    set({ playerOpening: true, playerItem: item, playerStreamIndex: streamIndex, playerStartPosition: startPosition })
  },
  closePlayer: () => set({ playerItem: null, playerOpening: false, guideOpen: false, guideChannels: [] }),

  guideOpen: false,
  setGuideOpen: (guideOpen) => set({ guideOpen }),
  guideChannels: [],
  setGuideChannels: (guideChannels) => set({ guideChannels }),
  zapChannel: (dir) => {
    const { guideChannels, playerItem: cur, openPlayer } = get()
    if (guideChannels.length === 0) return
    const idx = cur
      ? guideChannels.findIndex((c) => c.stableId === cur.stableId)
      : -1
    const next =
      idx < 0
        ? dir > 0
          ? guideChannels[0]
          : guideChannels[guideChannels.length - 1]
        : guideChannels[(idx + dir + guideChannels.length) % guideChannels.length]
    if (next && next.stableId !== cur?.stableId) openPlayer(next)
  },
  zapSource: (dir) => {
    const { playerItem: cur, openPlayer } = get()
    if (!cur || cur.kind !== 'EVENT') return
    const opts = cur.streamOptions
    if (!opts || opts.length < 2) return
    const curIdx = usePlayerStore.getState().currentSourceIndex ?? 0
    const next = (curIdx + dir + opts.length) % opts.length
    if (next !== curIdx) openPlayer({ ...cur }, next)
  },

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
