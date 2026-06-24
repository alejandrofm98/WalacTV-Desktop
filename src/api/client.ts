import { fetch } from '@tauri-apps/plugin-http'
import type { CatalogItem, WatchProgressItem, BrowseSection, StreamOption, CalendarResponse } from './types'
import { useAppStore } from '../store/useAppStore'
import { getUsername, getPassword, saveCredentials } from '../credentials'
import { BASE, API_URL } from '../config'

let _token = ''

export const HARDCODED_COUNTRIES = [
  { value: 'ES', label: 'España' },
  { value: 'UK', label: 'Reino Unido' },
  { value: 'US', label: 'Estados Unidos' },
  { value: 'WO', label: 'Mundial' },
]

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
    return trimmed.replace(/^http:\/\/image\.tmdb\.org/, 'https://image.tmdb.org')
  }
  return `${IPTV_BASE}/${trimmed}`
}

function resolveUrl(url: string): string {
  return url
    .replace(/\{\{USERNAME\}\}/g, getUsername())
    .replace(/\{\{PASSWORD\}\}/g, getPassword())
}

export function getMpvUrl(url: string): string {
  const u = getUsername()
  const p = getPassword()
  let resolved = url.replace(/\{\{USERNAME\}\}/g, encodeURIComponent(u)).replace(/\{\{PASSWORD\}\}/g, encodeURIComponent(p))
  if (resolved.startsWith('/')) resolved = `${API_URL}${resolved}`
  return resolved
}

function mapStreamOptions(raw: any[]): StreamOption[] {
  if (!raw?.length) return []
  return raw.map((o) => ({
    label: o.label ?? o.quality ?? 'Default',
    url: resolveUrl(o.url ?? ''),
    rawUrl: o.url ?? '',
    providerId: o.provider_id ?? o.providerId ?? undefined,
    quality: o.quality ?? null,
  }))
}

function mapKind(type: string): CatalogItem['kind'] {
  const t = (type ?? '').toLowerCase()
  if (t === 'movie') return 'MOVIE'
  if (t === 'series' || t === 'series_group') return 'SERIES'
  if (t === 'channel') return 'CHANNEL'
  if (t === 'event') return 'EVENT'
  return 'MOVIE'
}

function mapItem(raw: any): CatalogItem {
  const streamOpts = mapStreamOptions(raw.stream_options)
  // ponytail: fallback live URL when backend omits stream_options
  const kind = mapKind(raw.type)
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
    providerId: raw.provider_id != null ? String(raw.provider_id) : null,
    title: raw.title ?? '',
    subtitle: raw.subtitle ?? raw.series_name ?? '',
    description: raw.overview || raw.overview_es || raw.tmdb_overview || raw.tmdb_overview_es || raw.overview_en || raw.tmdb_overview_en || raw.description || raw.subtitle || '',
    imageUrl,
    kind: mapKind(raw.type),
    group: raw.group ?? raw.normalized_group ?? '',
    badgeText: raw.badge_text ?? '',
    channelNumber: raw.channel_number ?? null,
    languageLabel: raw.language_label ?? null,
    normalizedTitle: raw.normalized_title ?? null,
    normalizedGroup: raw.normalized_group ?? null,
    seriesName: raw.series_name ?? null,
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
  }
}

function mapSection(raw: any, contentType: string): BrowseSection {
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

function mapWatchProgress(raw: any): WatchProgressItem {
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
  const raw = await get<{ movie_sections?: any[]; series_sections?: any[] }>(`/api/home${q}`)
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
  const raw = await get<{ items: any[]; total: number; page: number; has_next: boolean }>(`/api/content?${q}`)
  return {
    items: (raw.items ?? []).map(mapItem),
    total: raw.total,
    page: raw.page,
    has_next: raw.has_next,
  }
}

// Series
export async function getSeriesEpisodes(identifier: string, page = 1) {
  const raw = await get<{ episodes: any[]; total: number }>(`/api/series/${encodeURIComponent(identifier)}/episodes?page=${page}&page_size=100`)
  return {
    episodes: (raw.episodes ?? []).map(mapItem),
    total: raw.total,
  }
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
  const raw = await get<{ items: any[]; total: number }>(`/api/search?${qs}`)
  return {
    results: (raw.items ?? []).map(mapItem),
    total: raw.total,
  }
}

// Favorites
export async function getFavorites() {
  const raw = await get<any[]>('/api/channel-favorites')
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
export async function getContentById(contentId: string): Promise<CatalogItem | null> {
  try {
    const raw = await get<any>(`/api/content/${contentId}`)
    return raw ? mapItem(raw) : null
  } catch {
    return null
  }
}

// Watch Progress
export async function getWatchProgress(limit = 20) {
  const raw = await get<{ items: any[] }>(`/api/watch-progress?limit=${limit}`)
  return {
    items: (raw.items ?? []).map(mapWatchProgress),
  }
}

export async function saveWatchProgress(id: string, body: { position_ms: number; duration_ms: number }) {
  return put<WatchProgressItem>(`/api/watch-progress/${id}`, body)
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
  return get<CalendarResponse>(`/api/calendar/${date}?client=desktop`)
}

export function getPreferredLanguage(): string {
  return localStorage.getItem('walactv_language') || 'ES'
}

export function setPreferredLanguage(lang: string) {
  localStorage.setItem('walactv_language', lang)
}
