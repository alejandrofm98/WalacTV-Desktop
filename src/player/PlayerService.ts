import { invoke } from '@tauri-apps/api/core'
import { type UnlistenFn, listen } from '@tauri-apps/api/event'
import type { PlayerState, PlayerItem, StreamOption, PlayerError, PlayerQuality, MpvEvent, AudioTrack, SubTrack, VariantTrack } from './types'
import { classifyMpvError } from './PlayerError'
import { usePlayerStore } from './usePlayerStore'
import { API_URL } from '../config'
import { getUsername, getPassword } from '../credentials'
import { getPlaybackTrackPreference, getPreferredLanguage, updatePlaybackTrackPreference } from '../api/client'

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
  private _alternativeAudioLoadedForUrl: string | null = null
  private _streamSwitchInProgress = false
  private _pendingExternalAudioTrack: AudioTrack | null = null
  private _state: PlayerState = 'idle'
  private _unlisteners: UnlistenFn[] = []
  private _currentTime = 0
  private _duration = 0
  private _isLive = false
  private _isPaused = true

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

  /** Returns the mpv rendering mode: "wid" (native embedding) or "render" (canvas). */
  getInitMode(): string {
    return this._initMode
  }

  /** Returns true when mpv renders its own native OSC (Linux with wid embedding). */
  getNativeControls(): boolean {
    return this._nativeControls
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
    this._setState('loading')

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
        const url = this._resolveStreamUrl(option)
        console.log(`[PlayerService] Loading stream: label="${option.label}" url="${url}"`)

        const title = item.kind === 'SERIES' && item.seriesName
          ? item.seriesName
          : item.tmdbTitle ?? item.title
        let subtitle = item.subtitle ?? ''
        if (item.kind === 'SERIES' && item.seasonNumber != null && item.episodeNumber != null) {
          const episode = `T${item.seasonNumber}:E${item.episodeNumber}`
          subtitle = item.title && item.title !== title ? `${episode} · ${item.title}` : episode
        }
        await Promise.all([
          invoke('mpv_set_property', { name: 'user-data/walactv/title', value: title }),
          invoke('mpv_set_property', { name: 'user-data/walactv/subtitle', value: subtitle }),
        ])

        this._currentStreamUrl = url
        await invoke('mpv_loadfile', { url, startPosition: startPosition ?? null })

        usePlayerStore.getState().setOpening(false)
        this._setState('playing')
        return i
      } catch (err: any) {
        console.error(`[PlayerService] Load error #${i}:`, err)
        if (this._currentStreamUrl === this._resolveStreamUrl(option)) {
          this._currentStreamUrl = null
          this._alternativeAudioLoadedForUrl = null
        }

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
    invoke('mpv_set_property', { name: 'pause', value: false }).catch(() => {})
  }

  pause(): void {
    invoke('mpv_set_property', { name: 'pause', value: true }).catch(() => {})
  }

  togglePlay(): void {
    if (this._isPaused) {
      this.play()
    } else {
      this.pause()
    }
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

  enterFullscreen(): void {
    const el = this._containerEl ?? this._videoEl
    if (!el) return
    el.requestFullscreen().catch(() => {})
  }

  exitFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      this.exitFullscreen()
    } else {
      this.enterFullscreen()
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
    this._audioTracks = []
    this._subTracks = []
    this._variantTracks = []
    this._currentTime = 0
    this._duration = 0
    this._currentStreamUrl = null
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
