import { invoke } from '@tauri-apps/api/core'
import { type UnlistenFn, listen } from '@tauri-apps/api/event'
import type { PlayerState, PlayerItem, StreamOption, PlayerError, PlayerQuality, MpvEvent, AudioTrack, SubTrack, VariantTrack, TorrentStats } from './types'
import { classifyMpvError } from './PlayerError'
import { usePlayerStore } from './usePlayerStore'
import { API_URL } from '../config'
import { getUsername, getPassword } from '../credentials'
import { getTorrentMaxMb } from '../settings'
import { getPlaybackTrackPreference, getPreferredLanguage, playbackSubtitle, playbackTitle, updatePlaybackTrackPreference } from '../api/client'

type PlayerServiceEvent = 'state' | 'error' | 'trackschanged' | 'fullscreenchange' | 'pipchange' | 'ended'

interface MpvTrackListEntry {
  id?: number
  type?: string
  title?: string
  lang?: string
  selected?: boolean
  forced?: boolean
  external?: boolean
  'external-filename'?: string
  'ff-index'?: number
}

function normalizeTrackLanguage(language: string): string {
  const normalized = language.trim().toLowerCase().split(/[-_]/)[0]
  if (normalized === 'eng' || normalized === 'en') return 'EN'
  if (normalized === 'spa' || normalized === 'es') return 'ES'
  if (normalized === 'lat' || normalized === 'latam') return 'LATAM'
  return normalized.toUpperCase()
}

function externalAudioTitle(label: string): string | null {
  const normalized = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .split(/[\s_-]/)[0]
  if (normalized === 'EN' || normalized === 'ENG' || normalized === 'ENGLISH' || normalized === 'INGLES') {
    return 'Inglés'
  }
  return null
}

/**
 * Singleton service that wraps libmpv via Tauri commands.
 * All playback interactions go through this class.
 */
export class PlayerService extends EventTarget {
  private static _instance: PlayerService | null = null

  private _videoEl: HTMLVideoElement | null = null
  private _pipVideoEl: HTMLVideoElement | null = null
  private _containerEl: HTMLElement | null = null
  private _attached = false
  private _loadGeneration = 0
  private _currentItemId: string | null = null
  private _currentItem: PlayerItem | null = null
  private _currentStreamUrl: string | null = null
  private _activeTorrentHash: string | null = null
  private _activeTorrentSeeders: number | null = null
  private _alternativeAudioLoadedForUrl: string | null = null
  private _streamSwitchInProgress = false
  private _pendingExternalAudioTrack: AudioTrack | null = null
  private _state: PlayerState = 'idle'
  private _unlisteners: UnlistenFn[] = []
  private _currentTime = 0
  private _duration = 0
  private _isLive = false
  private _isPaused = true
  /**
   * Explicit user pause intent (via pause()/play() only — mpv-initiated
   * pauses such as cache stalls never touch this). Guards the file-loaded
   * sync below: if the user paused while the file was loading, the event
   * must not flip the UI back to "playing" while mpv is actually paused.
   */
  private _userPaused = false

  // Cached track data (refreshed via 'tracks-changed' event)
  private _audioTracks: AudioTrack[] = []
  private _subTracks: SubTrack[] = []
  private _variantTracks: VariantTrack[] = []
  private _trackStateInitialized = false
  private _trackPreferenceLoading = false
  private _lastAudioTrackId: number | null = null
  private _lastSubtitleTrackId: number | null = null

  // Bound handlers for cleanup
  private _fullscreenChangeBound: (() => void) | null = null
  private _pipChangeBound: (() => void) | null = null

  // ── Singleton ────────────────────────────────────────────────────

  private constructor() {
    super()
  }

  static getInstance(): PlayerService {
    if (!PlayerService._instance) {
      PlayerService._instance = new PlayerService()
    }
    return PlayerService._instance
  }

  static resetInstance(): void {
    if (PlayerService._instance) {
      PlayerService._instance.destroy()
      PlayerService._instance = null
    }
  }

  // ── DOM ref setters ──────────────────────────────────────────────

  /** Set the container element for fullscreen API. */
  setContainerEl(el: HTMLElement | null): void {
    this._containerEl = el
  }

  /** Set the hidden video element for PiP API. */
  setPipVideoEl(el: HTMLVideoElement | null): void {
    this._pipVideoEl = el
  }

  // ── Init info (from mpv_init return) ───────────────────────────

private _initMode: string = 'wid'
private _nativeControls: boolean = false
private _os: string | null = null

  /** Returns the mpv rendering mode: "wid" (native embedding) or "render" (canvas). */
  getInitMode(): string {
    return this._initMode
  }

  /** Returns true when mpv renders its own native OSC (Linux with wid embedding). */
  getNativeControls(): boolean {
    return this._nativeControls
  }

  /** SO host del mpv inicializado ('windows' | 'linux' | 'darwin' | null). */
  getOs(): string | null {
    return this._os
  }

  // ── Attach / Detach ──────────────────────────────────────────────

  async attach(videoEl?: HTMLVideoElement | null): Promise<void> {
    if (this._attached) return

    this._videoEl = videoEl ?? null

    try {
      // Tauri 2 auto-injects `window: tauri::Window` on the Rust side — no
      // arguments needed from the frontend. Passing a DOM element here would
      // cause "JSON.stringify cannot serialize cyclic structures".
      const result = await invoke<{ mode: string; os: string; useCustom: boolean; nativeControls: boolean }>('mpv_init')
      this._initMode = result.mode
      this._nativeControls = result.nativeControls
      this._os = result.os

      this._unlisteners.push(
        await listen<MpvEvent>('mpv://event', (e) => {
          this._handleMpvEvent(e.payload)
        }),
      )

      this._attached = true
    } catch (err) {
      console.error('[PlayerService] mpv_init fallo:', err)
      const error = classifyMpvError(err)
      usePlayerStore.getState().setError(error)
      this._emit('error', error)
      throw err
    }

    this._bindWindowEvents()
  }

  async detach(): Promise<void> {
    this._unbindWindowEvents()
    this._unlistenTauri()
    if (this._attached) {
      try {
        await invoke('mpv_destroy')
      } catch (err) {
        console.error('[PlayerService] detach fallo:', err)
      }
    }
    this._audioTracks = []
    this._subTracks = []
    this._variantTracks = []
    this._currentTime = 0
    this._duration = 0
    this._currentStreamUrl = null
    await this._stopActiveTorrent()
    this._alternativeAudioLoadedForUrl = null
    this._streamSwitchInProgress = false
    this._pendingExternalAudioTrack = null
    this._currentItemId = null
    this._currentItem = null
    this._videoEl = null
    this._pipVideoEl = null
    this._containerEl = null
    this._attached = false
    this._setState('idle')
  }

  // ── Load / Unload ────────────────────────────────────────────────

  /**
   * Load content with automatic fallback across streamOptions.
   * Returns the index of the successfully loaded stream option, or -1 if all failed.
   */
  async load(
    item: PlayerItem,
    streamOptions: StreamOption[],
    startPosition?: number,
  ): Promise<number> {
    if (!this._attached) {
      console.warn('[PlayerService] load() called before attach() completed — skipping')
      const error: PlayerError = {
        kind: 'unknown',
        message: 'El player no esta inicializado.',
        recoverable: true,
      }
      usePlayerStore.getState().setError(error)
      this._emit('error', error)
      this._setState('error')
      return -1
    }
    this._loadGeneration++
    const gen = this._loadGeneration
    // Corta lo que estuviera sonando ANTES de resolver la nueva fuente: la
    // resolución (magnet torrent, manifests) tarda segundos y si no el
    // capítulo anterior sigue audible/visible hasta el reemplazo.
    try {
      await invoke('mpv_command', { args: ['stop'] })
    } catch {
      // Sin nada cargado mpv rechaza el stop; irrelevante.
    }
    if (gen !== this._loadGeneration) return -1
    this._currentItemId = item.stableId
    this._currentItem = item
    this._alternativeAudioLoadedForUrl = null
    this._streamSwitchInProgress = false
    this._pendingExternalAudioTrack = null
    this._trackStateInitialized = false
    this._trackPreferenceLoading = false
    this._lastAudioTrackId = null
    this._lastSubtitleTrackId = null
    this._isLive = item.kind === 'CHANNEL' || item.kind === 'EVENT'

    console.log(
      `[PlayerService] load() item=${item.stableId} kind=${item.kind} streamOptions=${streamOptions.length} startPosition=${startPosition ?? 'none'}`,
      streamOptions.map((o) => `"${o.label}" url="${o.url.substring(0, 80)}..."`),
    )

    usePlayerStore.getState().setCurrentItem(item.stableId)
    usePlayerStore.getState().setOpening(true)
    usePlayerStore.getState().setError(null)
    usePlayerStore.getState().setTorrentInfo(null)
    usePlayerStore.getState().setTorrentStats(null)
    this._userPaused = false
    this._setState('loading')

    // mpv's native window used to swallow HTML overlays; since the Render
    // API backend (video below the webview) they are visible again. Torrent
    // streams get a rich overlay (poster + progress) driven by rqbit stats;
    // direct streams keep the mpv OSD spinner for the resolve gap.
    if (!streamOptions.some((o) => o.source === 'torrentio' || o.requiresResolution)) {
      void this._showLoadingOsd()
    }

    if (streamOptions.length === 0) {
      const error: PlayerError = {
        kind: 'not_found',
        message: 'No hay opciones de stream disponibles.',
        recoverable: false,
      }
      usePlayerStore.getState().setError(error)
      this._emit('error', error)
      this._setState('error')
      return -1
    }

    // Try each stream option in order
    for (let i = 0; i < streamOptions.length; i++) {
      if (gen !== this._loadGeneration) return -1

      const option = streamOptions[i]
      usePlayerStore.getState().setStreamLabel(option.label)

      try {
        // Título TMDB/IMDb antes que el del proveedor (ver playbackTitle).
        const title = playbackTitle(item)
        const displaySubtitle = playbackSubtitle(item)
        // Pantalla de carga para pelis y series, sea torrent o directo (en
        // directo las stats quedan a null y el overlay no muestra cifras).
        if (item.kind === 'MOVIE' || item.kind === 'SERIES') {
          usePlayerStore.getState().setTorrentInfo({
            title,
            subtitle: displaySubtitle,
            posterUrl: item.tmdbPosterUrl ?? item.imageUrl ?? null,
            backdropUrl: item.backdropUrl ?? null,
          })
        }

        const url = await this._resolvePlaybackUrl(option)
        console.log(`[PlayerService] Loading stream: label="${option.label}" url="${url}"`)

        await Promise.all([
          invoke('mpv_set_property', { name: 'user-data/walactv/title', value: title }),
          invoke('mpv_set_property', { name: 'user-data/walactv/subtitle', value: displaySubtitle }),
        ])

        this._currentStreamUrl = url
        await invoke('mpv_loadfile', { url, startPosition: startPosition ?? null })

        usePlayerStore.getState().setOpening(false)
        // mpv starts playback unpaused and the event loop may have emitted
        // the initial pause=false before listen() was registered (attach
        // awaits mpv_init first). Sync the state explicitly so the render
        // loop and controls don't stay stuck thinking we're paused.
        // Buffering starts true until file-loaded/state-change proves
        // frames flow (same race affects paused-for-cache).
        this._isPaused = false
        usePlayerStore.getState().setPlaying(true)
        usePlayerStore.getState().setBuffering(true)
        this._setState('playing')
        return i
      } catch (err: unknown) {
        console.error(`[PlayerService] Load error #${i}:`, err)
        if (this._currentStreamUrl === this._resolveStreamUrl(option)) {
          this._currentStreamUrl = null
          this._alternativeAudioLoadedForUrl = null
        }

        if (this._activeTorrentHash) {
          await this._stopActiveTorrent()
        }
        this._clearTorrentOverlay()

        const classified = classifyMpvError(err)
        const isLast = i === streamOptions.length - 1

        // Auth errors are terminal — don't retry
        if (classified.kind === 'auth') {
          usePlayerStore.getState().setError(classified)
          this._emit('error', classified)
          this._setState('error')
          return -1
        }

        // NotFound — try next option if available
        if (classified.kind === 'not_found' && !isLast) {
          continue
        }

        // On last option, emit the error
        if (isLast) {
          usePlayerStore.getState().setError(classified)
          this._emit('error', classified)
          this._setState('error')
          return -1
        }

        // Network errors: continue to next option
        continue
      }
    }

    // No options worked
    const error: PlayerError = {
      kind: 'unknown',
      message: 'Ninguna opcion de stream funciono.',
      recoverable: true,
    }
    usePlayerStore.getState().setError(error)
    this._emit('error', error)
    this._setState('error')
    return -1
  }

  async unload(): Promise<void> {
    this._loadGeneration++
    this._currentStreamUrl = null
    this._userPaused = false
    this._clearLoadingOsd()
    await this._stopActiveTorrent()
    this._alternativeAudioLoadedForUrl = null
    this._streamSwitchInProgress = false
    this._pendingExternalAudioTrack = null
    this._currentItemId = null
    this._currentItem = null
    usePlayerStore.getState().setCurrentItem(null)
    try {
      await invoke('mpv_command', { args: ['stop'] })
    } catch {
      // Ignore stop errors
    }
    this._setState('idle')
  }

  // ── Playback controls ────────────────────────────────────────────

  play(): void {
    this._userPaused = false
    invoke('mpv_set_property', { name: 'pause', value: false }).catch(() => {})
  }

  pause(): void {
    this._userPaused = true
    invoke('mpv_set_property', { name: 'pause', value: true }).catch(() => {})
  }

  togglePlay(): void {
    // Never trust the cached flag alone: a missed pause event (e.g. the
    // listen() race at attach) would desync it and every toggle would send
    // the wrong command forever. mpv is the source of truth.
    invoke<unknown>('mpv_get_property', { name: 'pause' })
      .then((value) => {
        const paused = value === true || value === 'yes' || value === 'true' || value === 1
        if (paused) {
          this.play()
        } else {
          this.pause()
        }
      })
      .catch(() => {
        if (this._isPaused) {
          this.play()
        } else {
          this.pause()
        }
      })
  }

  seek(seconds: number): void {
    invoke('mpv_command', { args: ['seek', seconds.toString(), 'absolute'] }).catch(() => {})
  }

  setVolume(volume: number): void {
    const vol = Math.max(0, Math.min(1, volume))
    if (this._videoEl) {
      this._videoEl.volume = vol
    }
    usePlayerStore.getState().setVolume(vol)
    // mpv uses 0..100 range, frontend uses 0..1
    invoke('mpv_set_property', { name: 'volume', value: vol * 100 }).catch(() => {})
  }

  setMuted(muted: boolean): void {
    if (this._videoEl) {
      this._videoEl.muted = muted
    }
    usePlayerStore.getState().setMuted(muted)
    invoke('mpv_set_property', { name: 'mute', value: muted }).catch(() => {})
  }

  // ── Fullscreen ───────────────────────────────────────────────────
  // Tauri webviews don't reliably honor the DOM Fullscreen API, so the
  // window is toggled through the Tauri window API (with DOM as fallback).

  private async _setWindowFullscreen(on: boolean): Promise<boolean> {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      await win.setFullscreen(on)
      usePlayerStore.getState().setFullscreen(on)
      return true
    } catch {
      return false
    }
  }

  enterFullscreen(): void {
    void this._setWindowFullscreen(true).then((ok) => {
      if (ok) return
      const el = this._containerEl ?? this._videoEl
      if (!el) return
      el.requestFullscreen().catch(() => {})
    })
  }

  exitFullscreen(): void {
    void this._setWindowFullscreen(false).then((ok) => {
      if (ok) return
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      } else {
        usePlayerStore.getState().setFullscreen(false)
      }
    })
  }

  toggleFullscreen(): void {
    const show = !usePlayerStore.getState().isFullscreen
    if (show) {
      this.enterFullscreen()
    } else {
      this.exitFullscreen()
    }
  }

  // ── Picture-in-Picture ───────────────────────────────────────────

  enterPip(): void {
    const el = this._pipVideoEl ?? this._videoEl
    if (!el || !document.pictureInPictureEnabled) return
    el.requestPictureInPicture().catch(() => {})
  }

  exitPip(): void {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {})
    }
  }

  togglePip(): void {
    if (document.pictureInPictureElement) {
      this.exitPip()
    } else {
      this.enterPip()
    }
  }

  // ── Audio / Text tracks ──────────────────────────────────────────

  getAudioTracks(): AudioTrack[] {
    return this._audioTracks
  }

  getTextTracks(): SubTrack[] {
    return this._subTracks
  }

  selectAudioTrack(track: AudioTrack): void {
    if (this._switchToExternalAudioTrack(track)) return

    invoke('mpv_set_property', { name: 'aid', value: track.id }).catch(() => {})
    this._lastAudioTrackId = track.id
    const item = this._currentItem
    if (item && !this._isLive) {
      updatePlaybackTrackPreference(item, {
        audioLanguage: normalizeTrackLanguage(track.language),
        audioLabel: track.label,
      }).catch(() => {})
    }
  }

  selectAudioLanguage(lang: string, _role?: string): void {
    const tracks = this._audioTracks
    const match = tracks.find((t) => t.language === lang && (!_role || t.roles.includes(_role)))
    if (match) {
      this.selectAudioTrack(match)
    }
  }

  selectTextTrack(track: SubTrack | null): void {
    invoke('mpv_set_property', { name: 'sid', value: track?.id ?? 0 }).catch(() => {})
    this._lastSubtitleTrackId = track?.id ?? 0
    const item = this._currentItem
    if (item && !this._isLive) {
      updatePlaybackTrackPreference(item, track ? {
        subtitleLanguage: normalizeTrackLanguage(track.language),
        subtitleLabel: track.label,
        subtitlesDisabled: false,
      } : {
        subtitleLanguage: undefined,
        subtitleLabel: undefined,
        subtitlesDisabled: true,
      }).catch(() => {})
    }
  }

  setTextVisibility(visible: boolean): void {
    if (visible && this._subTracks.length > 0) {
      invoke('mpv_set_property', { name: 'sid', value: this._subTracks[0].id }).catch(() => {})
    } else {
      invoke('mpv_set_property', { name: 'sid', value: 0 }).catch(() => {})
    }
  }

  // ── Variant tracks (quality) ────────────────────────────────────

  getVariantTracks(): VariantTrack[] {
    return this._variantTracks
  }

  selectVariantTrack(track: VariantTrack, _clearBuffer?: boolean, _safeMargin?: number): void {
    // mpv handles quality selection internally — this is a best-effort hint
    if (track.height > 0) {
      invoke('mpv_set_property', { name: 'video-quality', value: track.height }).catch(() => {})
    }
  }

  // ── Time / duration ──────────────────────────────────────────────

  getCurrentTime(): number {
    return this._currentTime
  }

  getDuration(): number {
    return this._duration
  }

  getSeekableRange(): { start: number; end: number } | null {
    if (this._duration <= 0) return null
    return { start: 0, end: this._duration }
  }

  isLive(): boolean {
    return this._isLive
  }

  getState(): PlayerState {
    return this._state
  }

  getPlayer(): null {
    return null
  }

  getVideoElement(): HTMLVideoElement | null {
    return this._videoEl
  }

  // ── Quality ──────────────────────────────────────────────────────

  setQuality(quality: PlayerQuality): void {
    usePlayerStore.getState().setQuality(quality)

    if (quality === 'auto') {
      invoke('mpv_set_property', { name: 'video-quality', value: 'auto' }).catch(() => {})
    } else {
      invoke('mpv_set_property', { name: 'video-quality', value: quality }).catch(() => {})
    }
  }

  // ── Stream URL resolution ────────────────────────────────────────

  private _resolveStreamUrl(option: StreamOption): string {
    let resolvedUrl = option.url
    const raw = option.rawUrl || option.url
    if (raw.includes('{{USERNAME}}') || raw.includes('{{PASSWORD}}')) {
      resolvedUrl = raw
        .replace(/\{\{USERNAME\}\}/g, encodeURIComponent(getUsername()))
        .replace(/\{\{PASSWORD\}\}/g, encodeURIComponent(getPassword()))
    }
    if (resolvedUrl.startsWith('/')) {
      resolvedUrl = `${API_URL}${resolvedUrl}`
    }
    return resolvedUrl
  }

  private async _resolvePlaybackUrl(option: StreamOption): Promise<string> {
    if (option.source === 'torrentio' || option.requiresResolution) {
      if (!option.infoHash) {
        throw new Error('El stream Torrentio no contiene infoHash')
      }

      if (this._activeTorrentHash && this._activeTorrentHash !== option.infoHash) {
        await this._stopActiveTorrent()
      }

      const result = await invoke<{ url: string; infoHash: string }>('torrent_start', {
        request: {
          infoHash: option.infoHash,
          fileIdx: option.fileIdx ?? null,
          maxDownloadMb: getTorrentMaxMb(),
        },
      })
      this._activeTorrentHash = result.infoHash
      this._activeTorrentSeeders = option.seeders ?? null
      this._startTorrentStatsPolling(result.infoHash)
      return result.url
    }
    await this._stopActiveTorrent()
    return this._resolveStreamUrl(option)
  }

  private _torrentStatsTimer: ReturnType<typeof setInterval> | null = null

  private _startTorrentStatsPolling(infoHash: string): void {
    this._stopTorrentStatsPolling()
    this._torrentStatsTimer = setInterval(() => {
      invoke<TorrentStats>('torrent_stats', { infoHash })
        .then((stats) =>
          usePlayerStore.getState().setTorrentStats({ ...stats, seeds: this._activeTorrentSeeders }),
        )
        .catch(() => {})
    }, 1000)
  }

  private _stopTorrentStatsPolling(): void {
    if (this._torrentStatsTimer) {
      clearInterval(this._torrentStatsTimer)
      this._torrentStatsTimer = null
    }
  }

  private _clearTorrentOverlay(): void {
    this._stopTorrentStatsPolling()
    usePlayerStore.getState().setTorrentInfo(null)
    usePlayerStore.getState().setTorrentStats(null)
  }

  private async _stopActiveTorrent(): Promise<void> {
    this._stopTorrentStatsPolling()
    const hash = this._activeTorrentHash
    this._activeTorrentHash = null
    this._activeTorrentSeeders = null
    if (!hash) return
    await invoke('torrent_stop', { infoHash: hash }).catch(() => {})
  }

  /**
   * Show an animated loading spinner through mpv's OSD. The native mpv
   * window is stacked above the webview on Linux/Windows, so HTML loading
   * overlays are invisible while a stream resolves/buffers; the OSD renders
   * inside mpv's own window and is always visible.
   *
   * Cycles a spinner glyph via `show-text` until `_clearLoadingOsd` runs.
   */
  private _loadingOsdFrame = 0
  private _loadingOsdTimer: ReturnType<typeof setInterval> | null = null
  private _loadingOsdFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

  private _showLoadingOsd(message = 'Cargando'): void {
    this._clearLoadingOsdTimer()
    this._loadingOsdFrame = 0
    const draw = () => {
      const glyph = this._loadingOsdFrames[this._loadingOsdFrame % this._loadingOsdFrames.length]
      this._loadingOsdFrame++
      const text = `{\\fs72}${glyph}\\N{\\fs40}${message}`
      invoke('mpv_command', { args: ['show-text', text, '160'] }).catch(() => {})
    }
    draw()
    this._loadingOsdTimer = setInterval(draw, 160)
  }

  private _clearLoadingOsdTimer(): void {
    if (this._loadingOsdTimer) {
      clearInterval(this._loadingOsdTimer)
      this._loadingOsdTimer = null
    }
  }

  /** Clear any loading OSD message (called once the file is loaded). */
  private _clearLoadingOsd(): void {
    this._clearLoadingOsdTimer()
    invoke('mpv_command', { args: ['show-text', '', '1'] }).catch(() => {})
  }

  private _switchToExternalAudioTrack(track: AudioTrack): boolean {
    const item = this._currentItem
    const targetUrl = track.externalFilename
    if (!item || !targetUrl || this._isLive) return false
    if (this._streamSwitchInProgress) return true

    const option = item.streamOptions.find((candidate) => this._resolveStreamUrl(candidate) === targetUrl)
    if (!option || targetUrl === this._currentStreamUrl) return false

    const previousUrl = this._currentStreamUrl
    const previousAudioTrackId = this._lastAudioTrackId
    this._streamSwitchInProgress = true
    this._pendingExternalAudioTrack = track
    this._currentStreamUrl = targetUrl
    this._alternativeAudioLoadedForUrl = null
    usePlayerStore.getState().setStreamLabel(option.label)
    usePlayerStore.getState().setOpening(true)
    this._setState('loading')

    invoke('mpv_loadfile', {
      url: targetUrl,
      startPosition: Math.max(0, this._currentTime * 1000),
    }).catch((err) => {
      console.warn(`[PlayerService] No se pudo cambiar al stream "${option.label}":`, err)
      this._currentStreamUrl = previousUrl
      this._alternativeAudioLoadedForUrl = null
      this._streamSwitchInProgress = false
      this._pendingExternalAudioTrack = null
      usePlayerStore.getState().setOpening(false)
      this._setState(this._isPaused ? 'paused' : 'playing')
      if (previousAudioTrackId != null) {
        invoke('mpv_set_property', { name: 'aid', value: previousAudioTrackId }).catch(() => {})
      }
    })
    return true
  }

  private async _restorePendingAudioTrack(): Promise<void> {
    const pending = this._pendingExternalAudioTrack
    if (!pending) return

    await this._refreshTracks()
    const embeddedTracks = this._audioTracks.filter((track) => !track.external)
    const target = (pending.ffIndex != null
      ? embeddedTracks.find((track) => track.ffIndex === pending.ffIndex)
      : undefined)
      ?? embeddedTracks.find((track) =>
        track.language === pending.language && track.label === pending.label
      )

    if (!target) {
      console.warn('[PlayerService] No se encontro la pista seleccionada en el nuevo stream')
      return
    }

    await invoke('mpv_set_property', { name: 'aid', value: target.id })
    this._lastAudioTrackId = target.id
    const item = this._currentItem
    if (item) {
      updatePlaybackTrackPreference(item, {
        audioLanguage: normalizeTrackLanguage(target.language),
        audioLabel: target.label,
      }).catch(() => {})
    }
  }

  private async _loadAlternativeAudioTracks(): Promise<void> {
    const item = this._currentItem
    const currentUrl = this._currentStreamUrl
    if (!item || this._isLive || !currentUrl) return
    if (this._alternativeAudioLoadedForUrl === currentUrl) return

    this._alternativeAudioLoadedForUrl = currentUrl
    const seenUrls = new Set([currentUrl])
    for (const option of item.streamOptions) {
      if (option.source === 'torrentio' || option.requiresResolution) continue
      const url = this._resolveStreamUrl(option)
      if (seenUrls.has(url)) continue
      seenUrls.add(url)
      try {
        const title = externalAudioTitle(option.label)
        const args = title
          ? ['audio-add', url, 'auto', title]
          : ['audio-add', url, 'auto']
        await invoke('mpv_command', { args })
      } catch (err) {
        console.warn(`[PlayerService] No se pudo agregar audio alternativo "${option.label}":`, err)
      }
    }
  }

  // ── mpv event handling ───────────────────────────────────────────

  private async _handleMpvEvent(payload: MpvEvent): Promise<void> {
    switch (payload.type) {
      case 'time-update':
        this._currentTime = payload.position
        this._duration = payload.duration
        break

      case 'state-change':
        this._isPaused = payload.pause
        usePlayerStore.getState().setPlaying(!payload.pause)
        usePlayerStore.getState().setBuffering(payload.buffering)
        if (payload.pause) {
          this._setState('paused')
        } else if (payload.buffering) {
          this._setState('buffering')
        } else {
          // Video is actually rendering: the torrent overlay's job is done.
          this._clearTorrentOverlay()
          this._setState('playing')
        }
        break

      case 'tracks-changed':
        await this._refreshTracks()
        await this._syncTrackPreferences()
        this._emit('trackschanged')
        break

      case 'end-file': {
        const reason = payload.reason ?? 'unknown'
        console.debug(`[PlayerService] end-file: reason="${reason}"`)
        void this._clearLoadingOsd()
        if (reason === 'error') {
          this._streamSwitchInProgress = false
          this._pendingExternalAudioTrack = null
          usePlayerStore.getState().setOpening(false)
          const error: PlayerError = {
            kind: 'network',
            message: 'No se pudo cargar el stream.',
            recoverable: true,
          }
          usePlayerStore.getState().setPlaying(false)
          usePlayerStore.getState().setError(error)
          this._emit('error', error)
          this._setState('error')
        } else if (reason === 'eof') {
          usePlayerStore.getState().setPlaying(false)
          this._setState('ended')
          this._emit('ended')
        } else {
          usePlayerStore.getState().setPlaying(false)
          this._setState('idle')
        }
        break
      }

      case 'file-loaded':
        console.debug('[PlayerService] file-loaded: el archivo se cargo correctamente')
        void this._clearLoadingOsd()
        // Sync point: a newly loaded file plays (unless the user paused
        // while it was loading — pause() already sent pause=true to mpv, so
        // forcing "playing" here would desync the UI from mpv forever).
        // Covers the same listen() registration race as load().
        if (this._userPaused) {
          this._isPaused = true
          usePlayerStore.getState().setPlaying(false)
          usePlayerStore.getState().setBuffering(false)
          this._setState('paused')
        } else {
          this._isPaused = false
          usePlayerStore.getState().setPlaying(true)
          usePlayerStore.getState().setBuffering(false)
        }
        if (this._streamSwitchInProgress) {
          try {
            await this._restorePendingAudioTrack()
          } catch (err) {
            console.warn('[PlayerService] No se pudo restaurar la pista del nuevo stream:', err)
          } finally {
            this._streamSwitchInProgress = false
            this._pendingExternalAudioTrack = null
            usePlayerStore.getState().setOpening(false)
            this._setState(this._isPaused ? 'paused' : 'playing')
          }
        }
        await this._loadAlternativeAudioTracks()
        break

      case 'playback-restart':
        console.debug('[PlayerService] playback-restart: la reproduccion se reanudo')
        break

      case 'error': {
        const classified = classifyMpvError(payload)
        usePlayerStore.getState().setError(classified)
        this._emit('error', classified)
        this._setState('error')
        break
      }
    }
  }

  private async _refreshTracks(): Promise<void> {
    try {
      const [trackListJson, variant] = await Promise.all([
        invoke<string>('mpv_get_property', { name: 'track-list' }),
        invoke<VariantTrack[]>('mpv_get_variant_tracks'),
      ])
      const tracks = JSON.parse(trackListJson) as MpvTrackListEntry[]
      this._audioTracks = tracks
        .filter((track) => track.type === 'audio' && typeof track.id === 'number')
        .map((track) => ({
          id: track.id as number,
          language: track.lang?.trim() || 'und',
          label: track.title?.trim() || track.lang?.trim() || `Track ${track.id}`,
          active: track.selected === true,
          roles: [],
          external: track.external === true,
          externalFilename: track['external-filename'],
          ffIndex: track['ff-index'],
        }))
      this._subTracks = tracks
        .filter((track) => track.type === 'sub' && typeof track.id === 'number')
        .map((track) => ({
          id: track.id as number,
          language: track.lang?.trim() || 'und',
          label: track.title?.trim() || track.lang?.trim() || `Track ${track.id}`,
          active: track.selected === true,
          forced: track.forced === true,
        }))
      this._variantTracks = variant
    } catch {
      // Tracks not yet available — keep previous cache
    }
  }

  private async _syncTrackPreferences(): Promise<void> {
    const item = this._currentItem
    if (!item || this._isLive) return
    if (this._audioTracks.length === 0 && this._subTracks.length === 0) return
    if (this._trackPreferenceLoading) return

    const activeAudio = this._audioTracks.find((track) => track.active) ?? null
    const activeSubtitle = this._subTracks.find((track) => track.active) ?? null

    if (activeAudio?.external && activeAudio.externalFilename) {
      if (this._streamSwitchInProgress || this._switchToExternalAudioTrack(activeAudio)) return
    }

    if (!this._trackStateInitialized) {
      this._trackStateInitialized = true
      this._trackPreferenceLoading = true
      const preference = await getPlaybackTrackPreference(item).catch(() => null)
      const preferredAudioLanguage = preference?.audioLanguage || getPreferredLanguage()
      const audioMatch = this._audioTracks.find((track) =>
        normalizeTrackLanguage(track.language) === normalizeTrackLanguage(preferredAudioLanguage) ||
        (!!preference?.audioLabel && track.label.toLowerCase() === preference.audioLabel.toLowerCase())
      )
      if (audioMatch) {
        await invoke('mpv_set_property', { name: 'aid', value: audioMatch.id }).catch(() => {})
      }
      this._lastAudioTrackId = audioMatch?.id ?? activeAudio?.id ?? null

      if (preference?.subtitlesDisabled === true) {
        await invoke('mpv_set_property', { name: 'sid', value: 0 }).catch(() => {})
        this._lastSubtitleTrackId = 0
      } else if (preference?.subtitlesDisabled === false) {
        const subtitleMatch = this._subTracks.find((track) =>
          (!!preference.subtitleLanguage &&
            normalizeTrackLanguage(track.language) === normalizeTrackLanguage(preference.subtitleLanguage)) ||
          (!!preference.subtitleLabel && track.label.toLowerCase() === preference.subtitleLabel.toLowerCase())
        )
        if (subtitleMatch) {
          await invoke('mpv_set_property', { name: 'sid', value: subtitleMatch.id }).catch(() => {})
        }
        this._lastSubtitleTrackId = subtitleMatch?.id ?? activeSubtitle?.id ?? 0
      } else {
        this._lastSubtitleTrackId = activeSubtitle?.id ?? 0
      }
      this._trackPreferenceLoading = false
      return
    }

    const activeAudioId = activeAudio?.id ?? null
    if (activeAudioId !== this._lastAudioTrackId) {
      this._lastAudioTrackId = activeAudioId
      if (activeAudio) {
        await updatePlaybackTrackPreference(item, {
          audioLanguage: normalizeTrackLanguage(activeAudio.language),
          audioLabel: activeAudio.label,
        })
      }
    }

    const activeSubtitleId = activeSubtitle?.id ?? 0
    if (activeSubtitleId !== this._lastSubtitleTrackId) {
      this._lastSubtitleTrackId = activeSubtitleId
      await updatePlaybackTrackPreference(item, activeSubtitle ? {
        subtitleLanguage: normalizeTrackLanguage(activeSubtitle.language),
        subtitleLabel: activeSubtitle.label,
        subtitlesDisabled: false,
      } : {
        subtitleLanguage: undefined,
        subtitleLabel: undefined,
        subtitlesDisabled: true,
      })
    }
  }

  // ── Window event binding ─────────────────────────────────────────

  private _bindWindowEvents(): void {
    this._fullscreenChangeBound = () => {
      const isFs = !!document.fullscreenElement
      usePlayerStore.getState().setFullscreen(isFs)
      this._emit('fullscreenchange', isFs)
    }

    this._pipChangeBound = () => {
      const isPip = !!document.pictureInPictureElement
      usePlayerStore.getState().setPip(isPip)
      this._emit('pipchange', isPip)
    }

    document.addEventListener('fullscreenchange', this._fullscreenChangeBound)
    document.addEventListener('enterpictureinpicture', this._pipChangeBound)
    document.addEventListener('leavepictureinpicture', this._pipChangeBound)
  }

  private _unbindWindowEvents(): void {
    if (this._fullscreenChangeBound) {
      document.removeEventListener('fullscreenchange', this._fullscreenChangeBound)
    }
    if (this._pipChangeBound) {
      document.removeEventListener('enterpictureinpicture', this._pipChangeBound)
      document.removeEventListener('leavepictureinpicture', this._pipChangeBound)
    }
    this._fullscreenChangeBound = null
    this._pipChangeBound = null
  }

  private _unlistenTauri(): void {
    for (const unlisten of this._unlisteners) {
      unlisten()
    }
    this._unlisteners = []
  }

  // ── State management ─────────────────────────────────────────────

  private _setState(state: PlayerState): void {
    if (this._state === state) return
    this._state = state
    this._emit('state', state)
  }

  // ── Custom events via EventTarget ─────────────────────────────────

  private _emit(type: PlayerServiceEvent, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  destroy(): void {
    this._unbindWindowEvents()
    this._unlistenTauri()
    this._clearLoadingOsdTimer()
    this._audioTracks = []
    this._subTracks = []
    this._variantTracks = []
    this._currentTime = 0
    this._duration = 0
    this._currentStreamUrl = null
    void this._stopActiveTorrent()
    this._alternativeAudioLoadedForUrl = null
    this._streamSwitchInProgress = false
    this._pendingExternalAudioTrack = null
    this._currentItemId = null
    this._currentItem = null
    this._videoEl = null
    this._pipVideoEl = null
    this._containerEl = null
    this._attached = false
    this._setState('idle')
    usePlayerStore.getState().reset()
  }
}

// Convenience accessor
export const playerService = PlayerService.getInstance()
