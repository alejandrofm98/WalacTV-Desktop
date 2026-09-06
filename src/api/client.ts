import { fetch } from '@tauri-apps/plugin-http'
import type { CatalogItem, WatchProgressItem, BrowseSection, StreamOption, CalendarResponse, PlaybackTrackPreference, SkipSegment, SkipSegments } from './types'
import { useAppStore } from '../store/useAppStore'
import { getUsername, getPassword, saveCredentials } from '../credentials'
import { BASE, API_URL } from '../config'

interface RawStreamOption {
  label?: string | null
  url?: string | null
  provider_id?: string | number | null
  providerId?: string | number | null
  quality?: string | null
  source?: string | null
  provider?: string | null
  language?: string | null
  playable?: boolean
  requires_resolution?: boolean
  info_hash?: string | null
  file_idx?: number | null
  seeders?: number | null
  size_bytes?: number | null
  title?: string | null
}

interface RawCatalogItem {
  [key: string]: unknown
  id?: string | number | null
  provider_id?: string | number | null
  type?: string | null
  title?: string | null
  subtitle?: string | null
  description?: string | null
  series_name?: string | null
  series_key?: string | null
  series_provider_id?: string | number | null
  stream_options?: RawStreamOption[] | null
  poster_path?: string | null
  backdrop_path?: string | null
  still_path?: string | null
  image_url?: string | null
  group?: string | null
  normalized_group?: string | null
  badge_text?: string | null
  channel_number?: number | null
  language_label?: string | null
  normalized_title?: string | null
  season_number?: number | null
  episode_number?: number | null
  rating?: number | null
  vote_average?: number | null
  vote_count?: number | null
  runtime_minutes?: number | null
  genres?: string[] | null
  countries?: string[] | null
  overview?: string | null
  overview_es?: string | null
  overview_en?: string | null
  tmdb_overview?: string | null
  tmdb_overview_es?: string | null
  tmdb_overview_en?: string | null
  tagline?: string | null
  release_date?: string | null
  year?: number | null
  tmdb_title?: string | null
  total_seasons?: number | null
  imdb_id?: string | null
  skip_segments?: RawSkipSegments | null
  air_date?: string | null
  episode_type?: string | null
  is_watched?: boolean | null
  content_id?: string | number | null
  content_type?: string | null
  position_ms?: number | null
  duration_ms?: number | null
  last_watched_at?: string | null
  has_iptv_source?: boolean | null
  has_torrent_source?: boolean | null
}

interface RawSkipSegment {
  start_ms?: number
  startMs?: number
  end_ms?: number
  endMs?: number
}

interface RawSkipSegments {
  intro?: RawSkipSegment | null
  recap?: RawSkipSegment | null
  outro?: RawSkipSegment | null
}

interface RawSection {
  title?: string | null
  items?: RawCatalogItem[] | null
  group_name?: string | null
  section_title?: string | null
  year?: number | null
  page?: number
  has_next?: boolean
}

interface RawReplaySource {
  label?: string | null
  stream_url?: string | null
  provider?: string | null
  provider_video_id?: string | null
  source_index?: number
  button_index?: number
}

interface RawReplayGroup {
  group?: string | null
  sources?: RawReplaySource[] | null
}

interface RawReplay {
  slug: string
  title?: string | null
  event_date?: string | null
  description?: string | null
  match_card?: string[] | null
  featured_image_url?: string | null
  video_sources?: RawReplayGroup[] | null
}

let _token = ''

export const HARDCODED_COUNTRIES = [
  { value: 'ES', label: 'España' },
  { value: 'UK', label: 'Reino Unido' },
  { value: 'US', label: 'Estados Unidos' },
  { value: 'WO', label: 'Mundial' },
]

export function countryLabelFor(code: string | null | undefined): string | null {
  if (!code) return null
  const found = HARDCODED_COUNTRIES.find(
    (c) => c.value.toLowerCase() === code.toLowerCase() || c.label.toLowerCase() === code.toLowerCase(),
  )
  return found ? found.label : code
}

export function setToken(t: string) { _token = t }
export function getToken() { return _token }

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (_token) h['Authorization'] = `Bearer ${_token}`
  return h
}

function handleAuthError(r: Response) {
  if (r.status === 401) {
    useAppStore.getState().signOut()
    throw new Error('Sesion expirada')
  }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: headers() })
  handleAuthError(r)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

async function post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  })
  handleAuthError(r)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

async function put<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  })
  handleAuthError(r)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

async function del(path: string): Promise<void> {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: headers() })
  handleAuthError(r)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
}

// --- Mapping functions ---

// --- Image URL helpers (replicating Android approach) ---

export const IPTV_BASE = BASE

function isTmdbImagePath(path: string): boolean {
  if (!path) return false
  if (path.startsWith('http://image.tmdb.org') || path.startsWith('https://image.tmdb.org')) return true
  const trimmed = path.replace(/^\//, '')
  return trimmed.length > 0 && !trimmed.includes('/')
}

function buildTmdbImageUrl(path: string | null | undefined, size: string): string {
  const clean = path?.trim()
  if (!clean || clean.toLowerCase() === 'null') return ''
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean.replace(/^http:\/\/image\.tmdb\.org/, 'https://image.tmdb.org')
  }
  const normalized = clean.startsWith('/') ? clean : `/${clean}`
  return `https://image.tmdb.org/t/p/${size}${normalized}`
}

export function normalizeRemoteImageUrl(url: string | null | undefined): string {
  if (!url || url === 'null') return ''
  const trimmed = url.trim()
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('/')) return `${IPTV_BASE}${trimmed}`
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/^http:\/\//, 'https://')
  }
  return `${IPTV_BASE}/${trimmed}`
}

function resolveUrl(url: string): string {
  if ((url.includes('{{USERNAME}}') || url.includes('{{PASSWORD}}')) && (!getUsername() || !getPassword())) {
    console.warn('[api] URL con credenciales vacias (keyring sin credenciales): el stream fallara. Forzar login.')
  }
  return url
    .replace(/\{\{USERNAME\}\}/g, encodeURIComponent(getUsername()))
    .replace(/\{\{PASSWORD\}\}/g, encodeURIComponent(getPassword()))
}

export function getStreamUrl(url: string): string {
  const u = getUsername()
  const p = getPassword()
  let resolved = url.replace(/\{\{USERNAME\}\}/g, encodeURIComponent(u)).replace(/\{\{PASSWORD\}\}/g, encodeURIComponent(p))
  if (resolved.startsWith('/')) resolved = `${API_URL}${resolved}`
  return resolved
}

function mapStreamOptions(raw: RawStreamOption[]): StreamOption[] {
  if (!raw?.length) return []
  return raw.map((o) => ({
    label: o.label ?? o.quality ?? 'Default',
    url: resolveUrl(o.url ?? ''),
    rawUrl: o.url ?? '',
    providerId: o.provider_id != null || o.providerId != null
      ? String(o.provider_id ?? o.providerId)
      : undefined,
    quality: o.quality ?? null,
    source: o.source ?? undefined,
    provider: o.provider ?? undefined,
    language: o.language ?? null,
    playable: o.playable ?? true,
    requiresResolution: o.requires_resolution ?? false,
    infoHash: o.info_hash ?? null,
    fileIdx: o.file_idx ?? null,
    seeders: o.seeders ?? null,
    sizeBytes: o.size_bytes ?? null,
    torrentTitle: o.title ?? null,
  }))
}

function mapKind(raw: RawCatalogItem): CatalogItem['kind'] {
  const t = (raw.type ?? '').toLowerCase()
  if (t === 'movie') return 'MOVIE'
  if (t === 'series' || t === 'series_group') return 'SERIES'
  if (t === 'channel') return 'CHANNEL'
  if (t === 'event') return 'EVENT'
  // Raw catalog rows (e.g. TENDENCIAS sections) can omit `type`. Infer series
  // from series-specific fields so they open SeriesDetail instead of MovieDetail.
  if (raw.series_key || raw.series_name || raw.total_seasons != null || raw.total_episodes != null) {
    return 'SERIES'
  }
  return 'MOVIE'
}

export function mapItem(raw: RawCatalogItem): CatalogItem {
  const streamOpts = mapStreamOptions(raw.stream_options ?? [])
  // ponytail: fallback live URL when backend omits stream_options
  const kind = mapKind(raw)
  const streamId = raw.provider_id != null ? String(raw.provider_id) : String(raw.id ?? '')
  if (streamOpts.length === 0 && (kind === 'CHANNEL' || kind === 'EVENT') && streamId) {
    const fallbackRaw = `${IPTV_BASE}/live/{{USERNAME}}/{{PASSWORD}}/${streamId}`
    streamOpts.push({ label: 'Directo', url: resolveUrl(fallbackRaw), rawUrl: fallbackRaw })
  }
  const tmdbPosterUrlVal = buildTmdbImageUrl(raw.poster_path, 'w500')
  const imageUrl = normalizeRemoteImageUrl(raw.image_url) || tmdbPosterUrlVal
  const backdropUrl = raw.backdrop_path ? buildTmdbImageUrl(raw.backdrop_path, 'w1280') : null
  const tmdbPosterUrl = tmdbPosterUrlVal || null
  const stillPath = raw.still_path
    ? (isTmdbImagePath(raw.still_path) ? buildTmdbImageUrl(raw.still_path, 'w780') : normalizeRemoteImageUrl(raw.still_path))
    : null
  return {
    stableId: String(raw.id ?? raw.provider_id ?? ''),
    catalogId: raw.id != null ? String(raw.id) : null,
    providerId: raw.provider_id != null ? String(raw.provider_id) : null,
    title: raw.title ?? '',
    subtitle: raw.subtitle ?? raw.series_name ?? '',
    description: raw.overview || raw.overview_es || raw.tmdb_overview || raw.tmdb_overview_es || raw.overview_en || raw.tmdb_overview_en || raw.description || raw.subtitle || '',
    imageUrl,
    kind,
    group: raw.group ?? raw.normalized_group ?? '',
    badgeText: raw.badge_text ?? '',
    channelNumber: raw.channel_number ?? null,
    languageLabel: raw.language_label ?? null,
    normalizedTitle: raw.normalized_title ?? null,
    normalizedGroup: raw.normalized_group ?? null,
    seriesName: raw.series_name ?? null,
    seriesKey: raw.series_key ?? null,
    seriesProviderId: raw.series_provider_id != null ? String(raw.series_provider_id) : null,
    seasonNumber: raw.season_number ?? null,
    episodeNumber: raw.episode_number ?? null,
    streamOptions: streamOpts,
    voteAverage: raw.rating ?? raw.vote_average ?? null,
    voteCount: raw.vote_count ?? null,
    runtimeMinutes: raw.runtime_minutes ?? null,
    genres: raw.genres ?? [],
    countries: raw.countries ?? [],
    backdropUrl,
    tmdbPosterUrl,
    tagline: raw.tagline ?? null,
    releaseDate: raw.release_date ?? null,
    year: raw.year ?? null,
    tmdbTitle: raw.tmdb_title ?? null,
    totalSeasons: raw.total_seasons ?? null,
    stillPath: stillPath || null,
    imdbId: raw.imdb_id ?? null,
    hasIptvSource: raw.has_iptv_source ?? false,
    hasTorrentSource: raw.has_torrent_source ?? false,
    skipSegments: raw.skip_segments === undefined ? undefined : mapSkipSegments(raw.skip_segments),
    airDate: raw.air_date ?? null,
    episodeType: raw.episode_type ?? null,
    isWatched: raw.is_watched != null ? Boolean(raw.is_watched) : undefined,
    // Posicion de reproduccion guardada (episodios): permite reanudar a mitad.
    positionMs: raw.position_ms != null && raw.position_ms > 0 ? raw.position_ms : undefined,
    durationMs: raw.duration_ms != null && raw.duration_ms > 0 ? raw.duration_ms : undefined,
  }
}

function mapSection(raw: RawSection, contentType: string): BrowseSection {
  return {
    title: raw.title ?? '',
    items: (raw.items ?? []).map(mapItem),
    contentType,
    groupName: raw.group_name ?? null,
    sectionTitle: raw.section_title ?? null,
    year: raw.year ?? null,
    currentPage: raw.page ?? 1,
    hasNextPage: raw.has_next ?? false,
  }
}

function mapWatchProgress(raw: RawCatalogItem): WatchProgressItem {
  const tmdbPosterUrlVal = buildTmdbImageUrl(raw.poster_path, 'w500')
  return {
    contentId: String(raw.content_id ?? ''),
    contentType: raw.content_type ?? '',
    positionMs: raw.position_ms ?? 0,
    durationMs: raw.duration_ms ?? 0,
    normalizedTitle: raw.normalized_title ?? raw.series_name ?? '',
    title: raw.title ?? '',
    imageUrl: normalizeRemoteImageUrl(raw.image_url) || tmdbPosterUrlVal || '',
    tmdbPosterUrl: tmdbPosterUrlVal || null,
    backdropUrl: raw.backdrop_path ? buildTmdbImageUrl(raw.backdrop_path, 'w1280') : null,
    seriesName: raw.series_name ?? null,
    seasonNumber: raw.season_number ?? null,
    episodeNumber: raw.episode_number ?? null,
    lastWatchedAt: raw.last_watched_at ?? '',
    isWatched: raw.is_watched ?? false,
    overview: raw.overview || raw.overview_es || raw.overview_en || null,
    voteAverage: raw.rating ?? raw.vote_average ?? null,
    voteCount: raw.vote_count ?? null,
    runtimeMinutes: raw.runtime_minutes ?? null,
    genres: raw.genres ?? [],
    year: raw.year ?? null,
    tmdbTitle: raw.tmdb_title ?? null,
    totalSeasons: raw.total_seasons ?? null,
    tagline: raw.tagline ?? null,
    releaseDate: raw.release_date ?? null,
    imdbId: raw.imdb_id ?? null,
  }
}

function mapReplay(raw: RawReplay): CatalogItem {
  const streamOptions: StreamOption[] = (raw.video_sources ?? []).flatMap((group, sourceIndex) =>
    (group.sources ?? []).map((source, buttonIndex) => {
      const replaySourceIndex = source.source_index ?? sourceIndex
      const replayButtonIndex = source.button_index ?? buttonIndex
      const proxyUrl = `${BASE}/api/replays/${encodeURIComponent(raw.slug)}/stream/${replaySourceIndex}/${replayButtonIndex}?token=${encodeURIComponent(_token)}`
      const rawUrl = source.stream_url || proxyUrl
      return {
        label: group.group ? `${group.group} · ${source.label ?? 'Fuente'}` : source.label ?? 'Fuente',
        url: rawUrl,
        rawUrl,
        provider: source.provider ?? undefined,
        providerVideoId: source.provider_video_id ?? undefined,
      }
    }),
  )

  return {
    stableId: `replay:${raw.slug}`,
    title: raw.title ?? '',
    subtitle: raw.event_date ?? '',
    description: raw.description || (raw.match_card ?? []).join('\n'),
    imageUrl: normalizeRemoteImageUrl(raw.featured_image_url),
    kind: 'EVENT',
    group: 'UFC',
    badgeText: 'UFC',
    streamOptions,
    genres: [],
    year: raw.event_date ? Number(String(raw.event_date).slice(0, 4)) || null : null,
  }
}

export async function resolveReplayStreamUrl(option: StreamOption): Promise<string> {
  if (option.provider !== 'dailymotion' || !option.providerVideoId) return option.url

  try {
    const metadataUrl = new URL(`https://www.dailymotion.com/player/metadata/video/${option.providerVideoId}`)
    metadataUrl.searchParams.set('embedder', 'https://dailywrestling.cc/')
    const response = await fetch(metadataUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!response.ok) return option.url
    const metadata = await response.json() as { qualities?: Record<string, Array<{ url?: string }>> }
    const qualities = metadata.qualities ?? {}
    const numericQuality = Object.keys(qualities)
      .filter((quality) => /^\d+$/.test(quality))
      .sort((a, b) => Number(b) - Number(a))[0]
    return qualities[numericQuality]?.[0]?.url ?? qualities.auto?.[0]?.url ?? option.url
  } catch {
    return option.url
  }
}

// Auth
export async function login(username: string, password: string) {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!r.ok) throw new Error('Credenciales incorrectas')
  const data = await r.json()
  _token = data.access_token ?? data.token ?? ''
  await saveCredentials(username, password)
  return data
}

// Home
export async function getHomeCatalog(country?: string) {
  const q = country ? `?country=${encodeURIComponent(country)}` : ''
  const raw = await get<{ movie_sections?: RawSection[]; series_sections?: RawSection[] }>(`/api/home${q}`)
  const sections: BrowseSection[] = [
    ...(raw.movie_sections ?? []).map((s) => mapSection(s, 'movies')),
    ...(raw.series_sections ?? []).map((s) => mapSection(s, 'series')),
  ]
  return { sections }
}

// Content
export async function getCatalogPage(params: {
  content_type: string
  country?: string
  group?: string
  genre?: string
  year?: number
  section_title?: string
  page?: number
  page_size?: number
}) {
  const q = new URLSearchParams()
  q.set('content_type', params.content_type)
  if (params.country) q.set('country', params.country)
  if (params.group) q.set('group', params.group)
  if (params.genre) q.set('genre', params.genre)
  if (params.year) q.set('year', String(params.year))
  if (params.section_title) q.set('section_title', params.section_title)
  q.set('page', String(params.page ?? 1))
  q.set('page_size', String(params.page_size ?? 24))
  const raw = await get<{ items: RawCatalogItem[]; total: number; page: number; has_next: boolean }>(`/api/content?${q}`)
  return {
    items: (raw.items ?? []).map(mapItem),
    total: raw.total,
    page: raw.page,
    has_next: raw.has_next,
  }
}

export async function getUfcReplays(page = 1, search?: string) {
  const q = new URLSearchParams({ page: String(page), page_size: '48', event_type: 'UFC' })
  if (search) q.set('search', search)
  const raw = await get<{ items: RawReplay[]; has_next: boolean }>(`/api/replays?${q}`)
  return {
    items: (raw.items ?? []).map(mapReplay),
    has_next: raw.has_next,
  }
}

// Series
export async function getSeriesEpisodes(identifier: string, page = 1) {
  const raw = await get<{ episodes: RawCatalogItem[]; total: number }>(
    `/api/series/by-id/${encodeURIComponent(identifier)}/episodes?page=${page}&page_size=100`,
  )
  return {
    episodes: (raw.episodes ?? []).map(mapItem),
    total: raw.total,
  }
}

export async function getAllSeriesEpisodes(identifier: string): Promise<CatalogItem[]> {
  const first = await getSeriesEpisodes(identifier, 1)
  if (first.total <= first.episodes.length) return first.episodes
  const pages = Math.ceil(first.total / 100)
  const rest: CatalogItem[] = []
  for (let p = 2; p <= pages; p++) {
    const r = await getSeriesEpisodes(identifier, p)
    rest.push(...r.episodes)
  }
  return [...first.episodes, ...rest]
}

// Search
export async function search(q: string, page = 1, filters?: { country?: string; group?: string; types?: string; genre?: string }) {
  const qs = new URLSearchParams()
  qs.set('q', q)
  qs.set('page', String(page))
  qs.set('page_size', '50')
  if (filters?.country) qs.set('country', filters.country)
  if (filters?.group) qs.set('group', filters.group)
  if (filters?.types) qs.set('types', filters.types)
  if (filters?.genre) qs.set('genre', filters.genre)
  const raw = await get<{ items: RawCatalogItem[]; total: number }>(`/api/search?${qs}`)
  return {
    results: (raw.items ?? []).map(mapItem),
    total: raw.total,
  }
}

// Favorites
export async function getFavorites() {
  const raw = await get<RawCatalogItem[]>('/api/channel-favorites')
  return (raw ?? []).map(mapItem)
}

export async function addFavorite(channelId: string) {
  const form = new URLSearchParams()
  form.append('channel_id', channelId)
  const r = await fetch(`${BASE}/api/channel-favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers() },
    body: form.toString(),
  })
  handleAuthError(r)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
}

export async function removeFavorite(channelId: string) {
  await del(`/api/channel-favorites/${channelId}`)
}

// Content by ID (for continue watching refetch)
export async function getContentById(contentType: string, contentId: string): Promise<CatalogItem | null> {
  try {
    const url = `/api/content/${contentType}/${contentId}`
    console.log(`[getContentById] fetching: ${url}`)
    const raw = await get<RawCatalogItem>(url)
    if (!raw) {
      console.warn(`[getContentById] empty response for: ${url}`)
      return null
    }
    const mapped = mapItem(raw)
    console.log(`[getContentById] mapped item: id=${mapped.stableId} kind=${mapped.kind} streamOptions=${mapped.streamOptions.length}`)
    return mapped
  } catch (err) {
    console.warn(`[getContentById] failed for ${contentType}/${contentId}:`, err)
    return null
  }
}

// ── Torrentio directo desde el cliente (sin pasar por iptv-api) ─────────
// Evita el proxy caido del servidor (181.177.103.211:9613) y el 400 "Ruta no valida".
// Replica la logica de iptv-api/src/iptv_api/services/torrentio_service.py

const TORRENTIO_BASE_URL = (import.meta.env.VITE_TORRENTIO_BASE_URL as string | undefined)?.replace(/\/$/, '') || 'https://torrentio.strem.fun'
const TORRENTIO_PROVIDERS = (import.meta.env.VITE_TORRENTIO_PROVIDERS as string | undefined) ?? 'wolfmax4k,comando,yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,torrentproject,ibit,filelist'
const TORRENTIO_LANGUAGES = (import.meta.env.VITE_TORRENTIO_LANGUAGES as string | undefined) ?? 'spanish,english'
const TORRENTIO_TIMEOUT_MS = 15_000
const TORRENTIO_CACHE_TTL_MS = 60_000

const _IMDB_RE = /^tt\d+$/i
const _SEEDERS_RE = /[👤]\s*([\d,.]+)/
const _SIZE_RE = /💾\s*([\d,.]+)\s*(KB|MB|GB|TB)/i
const _QUALITY_RE = /\b(4k|2160p|1080p|720p|480p)\b/i

const _LANG_FLAGS: Record<string, string> = { '🇪🇸': 'ES', '🇬🇧': 'EN', '🇯🇵': 'JP' }
const _EXCLUDED_MARKERS = ['🇲🇽', 'latino']
const _FOREIGN_FLAGS = ['🇮🇹', '🇵🇹', '🇷🇺', '🇫🇷', '🇩🇪', '🇵🇱', '🇨🇳', '🇯🇵']

const torrentioCache = new Map<string, { expiresAt: number; items: StreamOption[] }>()

function torrentioConfigPath(): string {
  const parts: string[] = []
  if (TORRENTIO_PROVIDERS) parts.push(`providers=${TORRENTIO_PROVIDERS}`)
  if (TORRENTIO_LANGUAGES) parts.push(`language=${TORRENTIO_LANGUAGES}`)
  return parts.join('|')
}

function torrentioDetectLanguage(title: string): string | null {
  const lowered = title.toLowerCase()
  if (_EXCLUDED_MARKERS.some((m) => lowered.includes(m.toLowerCase()) || title.includes(m))) return null
  const hasForeign = _FOREIGN_FLAGS.some((f) => title.includes(f))
  const hasKnown = Object.keys(_LANG_FLAGS).some((f) => title.includes(f))
  if (hasForeign && !hasKnown) return null
  if (title.includes('🇪🇸')) return 'ES'
  if (title.includes('🇬🇧')) return 'EN'
  if (title.includes('🇯🇵') || /\b(japanese|japonesa?|japon(?:es|és)?)\b/i.test(lowered)) return 'JP'
  if (title.includes('日本語') || title.includes('日本')) return 'JP'
  if (/\b(spanish|castellano)\b/i.test(lowered)) return 'ES'
  if (/\benglish\b/i.test(lowered)) return 'EN'
  for (const [flag, code] of Object.entries(_LANG_FLAGS)) {
    if (title.includes(flag)) return code
  }
  return 'EN'
}

function torrentioProviderLabel(title: string): string {
  const marker = '⚙️'
  if (title.includes(marker)) {
    const after = title.slice(title.indexOf(marker) + marker.length).trim()
    const label = after.split('\n')[0]?.trim()
    if (label) return label
  }
  return 'Torrentio'
}

function torrentioParseSeeders(title: string): number | null {
  const m = _SEEDERS_RE.exec(title)
  if (!m) return null
  const n = parseInt(m[1].replace(/[,.]/g, ''), 10)
  return Number.isNaN(n) ? null : n
}

function torrentioParseSizeBytes(title: string): number | null {
  const m = _SIZE_RE.exec(title)
  if (!m) return null
  const v = parseFloat(m[1].replace(',', '.'))
  if (Number.isNaN(v)) return null
  const mult: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
  const k = m[2].toUpperCase()
  return Math.round(v * (mult[k] ?? 0)) || null
}

function torrentioNormalize(raw: Record<string, unknown>): StreamOption | null {
  const infoHash = String((raw['infoHash'] as string | undefined) ?? '').trim()
  if (!/^[a-fA-F0-9]{40}$/.test(infoHash)) return null
  const title = String((raw['title'] as string | undefined) ?? '').trim()
  const lang = torrentioDetectLanguage(title)
  if (lang == null) return null
  const name = String((raw['name'] as string | undefined) ?? '').trim()
  const qm = _QUALITY_RE.exec(name) ?? _QUALITY_RE.exec(title)
  const quality = qm ? qm[1].toUpperCase() : null
  const providerLabel = torrentioProviderLabel(title)
  return {
    label: providerLabel,
    url: '',
    rawUrl: '',
    quality,
    source: 'torrentio',
    provider: providerLabel,
    language: lang,
    playable: false,
    requiresResolution: true,
    infoHash,
    fileIdx: (raw['fileIdx'] as number | null) ?? null,
    seeders: torrentioParseSeeders(title),
    sizeBytes: torrentioParseSizeBytes(title),
    torrentTitle: title,
  }
}

async function fetchTorrentioStreams(contentType: 'movie' | 'series', contentId: string): Promise<StreamOption[]> {
  if (!_IMDB_RE.test(contentId.split(':')[0] ?? '')) {
    throw new Error('imdb_id debe tener formato tt1234567')
  }
  const config = torrentioConfigPath()
  const cacheKey = `${config}/${contentType}/${contentId}`
  const now = Date.now()
  const cached = torrentioCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return [...cached.items]

  const encodedConfig = encodeURIComponent(config).replace(/%7C/g, '|').replace(/%3D/g, '=').replace(/%2C/g, ',')
  // El addon espera el config sin encodear el separador | y = , (igual que en el servicio python)
  // Usamos la forma que funciona en produccion: providers=wolfmax4k|language=spanish,english
  // quote(..., safe="=,") en python deja | encodeado como %7C, ambas formas funcionan.
  const url = `${TORRENTIO_BASE_URL}/${config}/stream/${contentType}/${contentId}.json`
  // Fallback: si el servidor responde 400 por el | sin encodear, el fetch directo con | funciona (probado con curl)
  void encodedConfig

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TORRENTIO_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'WalacTV-Desktop/Torrentio' },
      signal: controller.signal,
    } as unknown as RequestInit)
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`)
    const payload = (await resp.json()) as { streams?: unknown }
    const rawStreams = Array.isArray(payload?.streams) ? payload.streams as Record<string, unknown>[] : []
    const items = rawStreams.map((r) => torrentioNormalize(r)).filter((x): x is StreamOption => x != null)
    // trim cache
    for (const [k, v] of torrentioCache.entries()) if (v.expiresAt <= now) torrentioCache.delete(k)
    torrentioCache.set(cacheKey, { expiresAt: now + TORRENTIO_CACHE_TTL_MS, items })
    return [...items]
  } finally {
    clearTimeout(timer)
  }
}

// Solo torrents cuyo idioma declarado coincide con el preferido del usuario
// (espejo del filtro filterByPreferredLanguage del cliente Android). Si no
// hay ninguno, no se ofrece opcion torrent.
function filterByPreferredLanguage(streams: StreamOption[]): StreamOption[] {
  const target = getPreferredLanguage().toUpperCase()
  return streams.filter((s) => s.language?.toUpperCase() === target)
}

/** ¿La opción es del idioma indicado (ES/EN…)? Mira primero el campo
 * language y si no los tokens del label ("ES", "ES HD", "Audio EN"…).
 * Conservador: sin subcadenas ("ENGLISH" no vale para "EN"). */
export function streamOptionMatchesLanguage(option: StreamOption, target: string): boolean {
  const code = (target ?? '').toUpperCase()
  if (!code) return false
  if ((option.language ?? '').toUpperCase() === code) return true
  const tokens = (option.label ?? '').toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  return tokens.includes(code)
}

/** Orden de reproducción para capítulos: IPTV del proveedor en el idioma
 * preferido, Torrentio en el idioma preferido, IPTV en otro idioma y por
 * último Torrentio en otro idioma. Estable dentro de cada grupo. */
export function orderEpisodeStreams(
  iptv: StreamOption[],
  torrents: StreamOption[],
  preferredLanguage?: string,
): StreamOption[] {
  const target = (preferredLanguage ?? getPreferredLanguage()).toUpperCase()
  const isTorrent = (o: StreamOption) => Boolean(o.infoHash)
  const options = [...iptv, ...torrents].filter(isPlayableOption)
  const bucket = (torrent: boolean, sameLang: boolean) =>
    options.filter((o) => isTorrent(o) === torrent && streamOptionMatchesLanguage(o, target) === sameLang)
  return [...bucket(false, true), ...bucket(true, true), ...bucket(false, false), ...bucket(true, false)]
}

/** Título principal durante la reproducción: TMDB/IMDb antes que el proveedor.
 * En capítulos se usa el nombre TMDB de la serie (seriesTmdbTitle, inyectado al
 * reproducir); el tmdbTitle del item de un capítulo es el del capítulo, no el
 * de la serie. Sin dato TMDB se recurre al nombre del proveedor. */
export function playbackTitle(item: CatalogItem): string {
  if (item.kind === 'SERIES') {
    if (item.seasonNumber != null && item.episodeNumber != null) {
      return item.seriesTmdbTitle ?? item.seriesName ?? item.tmdbTitle ?? item.title
    }
    return item.tmdbTitle ?? item.seriesTmdbTitle ?? item.seriesName ?? item.title
  }
  return item.tmdbTitle ?? item.title
}

/** Subtítulo durante la reproducción: T/E más el nombre TMDB del capítulo.
 *  En canales en directo, línea de identidad: país, grupo y número de canal. */
export function playbackSubtitle(item: CatalogItem): string {
  if (item.kind === 'SERIES' && item.seasonNumber != null && item.episodeNumber != null) {
    const epTag = `T${item.seasonNumber}:E${item.episodeNumber}`
    const epName = item.tmdbTitle ?? item.title
    const title = playbackTitle(item)
    return epName && epName !== title ? `${epTag} · ${epName}` : epTag
  }
  if (item.kind === 'CHANNEL') {
    const parts = [
      countryLabelFor(item.countries?.[0]),
      item.group || null,
      item.channelNumber != null ? `Canal ${item.channelNumber}` : null,
    ].filter((p): p is string => p != null)
    if (parts.length > 0) return parts.join(' · ')
  }
  return item.subtitle ?? ''
}

export async function getTorrentioMovieStreams(movieId: string): Promise<StreamOption[]> {
  console.log(`[Torrentio] movie lookup (direct): ${movieId}`)
  if (!_IMDB_RE.test(movieId)) throw new Error('La pelicula no tiene imdb_id para consultar Torrentio')
  const streams = filterByPreferredLanguage(await fetchTorrentioStreams('movie', movieId))
  console.log(`[Torrentio] movie streams: ${streams.length}`)
  return streams
}

export async function getTorrentioEpisodeStreams(
  seriesId: string,
  season: number,
  episode: number,
): Promise<StreamOption[]> {
  console.log(`[Torrentio] episode lookup (direct): ${seriesId} S${season}E${episode}`)
  if (!_IMDB_RE.test(seriesId)) throw new Error('La serie no tiene imdb_id para consultar Torrentio')
  if (season < 0 || episode < 0) throw new Error('season y episode deben ser positivos')
  const streams = filterByPreferredLanguage(await fetchTorrentioStreams('series', `${seriesId}:${season}:${episode}`))
  console.log(`[Torrentio] episode streams: ${streams.length}`)
  return streams
}

/** Un stream es reproducible si tiene URL real o infoHash de torrent. */
export function isPlayableOption(o: StreamOption): boolean {
  return Boolean((o.url ?? '').trim() || o.infoHash)
}

function qualityRankOf(o: StreamOption): number {
  const q = (o.quality ?? '').toLowerCase()
  if (q.includes('2160') || q === '4k') return 4
  if (q.includes('1080')) return 3
  if (q.includes('720')) return 2
  const hay = `${o.label} ${o.torrentTitle ?? ''}`.toLowerCase()
  if (hay.includes('2160') || hay.includes('4k')) return 4
  if (hay.includes('1080')) return 3
  if (hay.includes('720')) return 2
  return 1
}

/** Indice del mejor stream reproducible para auto-play. Orden exigido:
 *  1) directo del proveedor en el idioma del home, 2) torrentio en ese idioma,
 *  3) directo en otro idioma, 4) torrentio en otro idioma. Dentro de cada
 *  grupo decide la calidad (y seeds como desempate en torrents). */
export function pickBestStreamIndex(options: StreamOption[], preferredLanguage?: string): number {
  const target = (preferredLanguage ?? getPreferredLanguage()).toUpperCase()
  let best = -1
  let bestScore = -1
  options.forEach((o, i) => {
    if (!isPlayableOption(o)) return
    // Grupo 0: directo+idioma, 1: torrent+idioma, 2: directo+otro, 3: torrent+otro.
    // Menor grupo = mejor: el peso del grupo (3000/2000/1000/0) domina siempre
    // sobre calidad y seeds, que solo desempatan dentro del mismo grupo.
    const group = (o.infoHash ? 1 : 0) + (streamOptionMatchesLanguage(o, target) ? 0 : 2)
    const score = (3 - group) * 1000 + qualityRankOf(o) * 10 + Math.min(o.seeders ?? 0, 9)
    if (score > bestScore) { bestScore = score; best = i }
  })
  return best >= 0 ? best : 0
}

// Watch Progress
export async function getWatchProgress(limit = 20) {
  const raw = await get<{ items: RawCatalogItem[] }>(`/api/watch-progress?limit=${limit}`)
  return {
    items: (raw.items ?? []).map(mapWatchProgress),
  }
}

export async function getHomeContinueWatching(limit = 20) {
  const raw = await get<{ items: any[] }>(`/api/watch-progress/continue?limit=${limit}`)
  return {
    items: (raw.items ?? []).map(mapWatchProgress),
  }
}

// Watched items (marcadas como vistas, no solo en progreso)
export async function getWatchedItems(limit = 500) {
  const all: RawCatalogItem[] = []
  let offset = 0
  const MAX_WATCHED_ITEMS = 10_000
  while (offset < MAX_WATCHED_ITEMS) {
    const raw = await get<{ items: RawCatalogItem[]; total?: number }>(`/api/watch-progress/watched?limit=${limit}&offset=${offset}`)
    const items = raw.items ?? []
    all.push(...items)
    const total = raw.total ?? offset + items.length
    offset += items.length
    if (items.length === 0 || offset >= total) break
  }
  return {
    items: all.map(mapWatchProgress),
  }
}

function normKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/**
 * Construye un matcher que dice si un item de catalogo esta visto, usando la
 * lista global de contenidos marcados como vistos. Solo marca (nunca desmarca).
 */
export function buildWatchedMatcher(watched: WatchProgressItem[]): (item: CatalogItem) => boolean {
  const movieIds = new Set<string>()
  const movieTitles = new Set<string>()
  const seriesIds = new Set<string>()
  const seriesNames = new Set<string>()
  for (const w of watched) {
    const id = w.contentId
    if (w.contentType === 'series') {
      seriesIds.add(id)
      if (w.seriesName) seriesNames.add(normKey(w.seriesName))
      if (w.title) seriesNames.add(normKey(w.title))
      if (w.tmdbTitle) seriesNames.add(normKey(w.tmdbTitle))
    } else {
      movieIds.add(id)
      if (w.title) movieTitles.add(normKey(w.title))
      if (w.tmdbTitle) movieTitles.add(normKey(w.tmdbTitle))
    }
  }

  return (item: CatalogItem): boolean => {
    if (item.kind === 'MOVIE') {
      const byId = [item.stableId, item.catalogId, item.providerId]
        .some((v) => v != null && movieIds.has(String(v)))
      return byId || movieTitles.has(normKey(item.title))
    }
    if (item.kind === 'SERIES') {
      const byId = [item.stableId, item.seriesKey, item.seriesProviderId]
        .some((v) => v != null && seriesIds.has(String(v)))
      const byName = [item.seriesName, item.title, item.tmdbTitle]
        .some((v) => v != null && seriesNames.has(normKey(String(v))))
      return byId || byName
    }
    return false
  }
}

/**
 * Aplica el estado "visto" a los items de las secciones usando la lista global
 * de contenidos marcados como vistos. Solo marca (nunca desmarca), asi que es
 * seguro aplicarla encima de un is_watched que ya venga del backend.
 */
export function applyWatchedState(
  sections: BrowseSection[],
  watched: WatchProgressItem[],
): BrowseSection[] {
  if (watched.length === 0) return sections
  const isWatched = buildWatchedMatcher(watched)
  return sections.map((section) => {
    if (!section.items.some(isWatched)) return section
    return {
      ...section,
      items: section.items.map((item) => (isWatched(item) ? { ...item, isWatched: true } : item)),
    }
  })
}

/** Version para listas planas de items (Discover, Search). */
export function applyWatchedToItems(
  items: CatalogItem[],
  watched: WatchProgressItem[],
): CatalogItem[] {
  if (watched.length === 0) return items
  const isWatched = buildWatchedMatcher(watched)
  return items.map((item) => (isWatched(item) ? { ...item, isWatched: true } : item))
}

/** Stable group key for continue-watching entries. Mirrors Android WalacTV:
 *  series collapse to one tile per series (grouped by series_name); movies keep
 *  their own content_id. Used both in the store Map and in the SectionRow lookups
 *  so catalog cards and synthetic CW tiles all hit the same key. */
export function cwGroupKey(
  contentType: string,
  seriesName: string | null | undefined,
  contentId: string,
): string {
  if (contentType === 'series' && seriesName && seriesName.trim() !== '') {
    return 'series:' + seriesName
  }
  return 'content:' + contentId
}

export interface WatchProgressUpsertBody {
  content_type: 'movie' | 'series'
  position_ms: number
  duration_ms: number
  series_name?: string | null
  season_number?: number | null
  episode_number?: number | null
  title?: string
  image_url?: string
}

export async function saveWatchProgress(id: string, body: WatchProgressUpsertBody) {
  return put<WatchProgressItem>(`/api/watch-progress/${id}`, body as unknown as Record<string, unknown>)
}

export async function removeWatchProgress(id: string): Promise<void> {
  await del(`/api/watch-progress/${encodeURIComponent(id)}`)
}

export async function markWatched(
  contentId: string,
  season?: number | null,
  episode?: number | null,
  completed = false,
): Promise<void> {
  const params = new URLSearchParams()
  if (season != null) params.set('season', String(season))
  if (episode != null) params.set('episode', String(episode))
  if (completed) params.set('completed', 'true')
  const qs = params.toString() ? `?${params}` : ''
  await post(`/api/watch-progress/${encodeURIComponent(contentId)}/mark-watched${qs}`)
}

export async function markSeriesEpisodesWatched(
  contentId: string,
  episodes: Array<{ seasonNumber?: number | null; episodeNumber?: number | null }>,
): Promise<void> {
  await Promise.all(episodes.map((episode) =>
    markWatched(contentId, episode.seasonNumber, episode.episodeNumber),
  ))
}

function playbackPreferencePath(item: CatalogItem): string | null {
  if (item.kind !== 'MOVIE' && item.kind !== 'SERIES') return null
  const catalogId = item.kind === 'SERIES' ? item.seriesKey : item.catalogId
  if (!catalogId) return null
  return `/api/playback-preferences/${item.kind.toLowerCase()}/${encodeURIComponent(catalogId)}`
}

export async function getPlaybackTrackPreference(
  item: CatalogItem,
): Promise<PlaybackTrackPreference | null> {
  const path = playbackPreferencePath(item)
  if (!path) return null
  const response = await fetch(`${BASE}${path}`, { headers: headers() })
  handleAuthError(response)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const raw = await response.json() as Record<string, unknown>
  return {
    audioLanguage: raw.audio_language as string | undefined,
    audioLabel: raw.audio_label as string | undefined,
    subtitleLanguage: raw.subtitle_language as string | undefined,
    subtitleLabel: raw.subtitle_label as string | undefined,
    subtitlesDisabled: raw.subtitles_disabled as boolean | undefined,
  }
}

export async function updatePlaybackTrackPreference(
  item: CatalogItem,
  patch: Partial<PlaybackTrackPreference>,
): Promise<void> {
  const path = playbackPreferencePath(item)
  if (!path) return
  const body: Record<string, unknown> = {}
  if ('audioLanguage' in patch) body.audio_language = patch.audioLanguage ?? null
  if ('audioLabel' in patch) body.audio_label = patch.audioLabel ?? null
  if ('subtitleLanguage' in patch) body.subtitle_language = patch.subtitleLanguage ?? null
  if ('subtitleLabel' in patch) body.subtitle_label = patch.subtitleLabel ?? null
  if ('subtitlesDisabled' in patch) body.subtitles_disabled = patch.subtitlesDisabled ?? null
  await put(path, body)
}

// Countries, Groups
export async function getCountries(contentType: string) {
  return get<{ countries: string[] }>(`/api/content/countries?content_type=${contentType}`)
}

export async function getGroups(contentType: string, country?: string) {
  const q = new URLSearchParams({ content_type: contentType })
  if (country) q.set('countries', country)
  return get<{ groups: string[] }>(`/api/content/groups?${q}`)
}

export async function getGenres(contentType: string, country?: string) {
  const q = new URLSearchParams({ content_type: contentType })
  if (country) q.set('countries', country)
  return get<{ genres: string[] }>(`/api/content/genres?${q}`)
}

export async function getCalendarEvents(date: string) {
  const params = new URLSearchParams({ client: 'android' })
  const pwd = getPassword()
  if (pwd) params.set('password', pwd)
  return get<CalendarResponse>(`/api/calendar/${date}?${params}`)
}

export function getPreferredLanguage(): string {
  return localStorage.getItem('walactv_language') || 'ES'
}

export function setPreferredLanguage(lang: string) {
  localStorage.setItem('walactv_language', lang)
}

// ── IntroDB skip segments ─────────────────────────

export type IntroDbSegments = SkipSegments

function mapSkipSegments(raw: RawSkipSegments | null | undefined): SkipSegments | null {
  if (raw == null) return null
  const mapSegment = (segment: RawSkipSegment | null | undefined): SkipSegment | null => {
    if (!segment) return null
    return {
      startMs: segment.start_ms ?? segment.startMs ?? 0,
      endMs: segment.end_ms ?? segment.endMs ?? 0,
    }
  }
  return {
    intro: mapSegment(raw.intro),
    recap: mapSegment(raw.recap),
    outro: mapSegment(raw.outro),
  }
}

export async function fetchIntroDbSegments(
  imdbId: string,
  season: number,
  episode: number,
): Promise<IntroDbSegments | null> {
  try {
    const resp = await globalThis.fetch(
      `https://api.introdb.app/segments?imdb_id=${imdbId}&season=${season}&episode=${episode}`,
    )
    if (!resp.ok) return null
    return mapSkipSegments(await resp.json())
  } catch {
    return null
  }
}
