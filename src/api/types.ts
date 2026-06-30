export type ContentKind = 'CHANNEL' | 'MOVIE' | 'SERIES' | 'EVENT'

export interface StreamOption {
  label: string
  url: string
  rawUrl: string
  providerId?: string
  quality?: string | null
  headers?: Record<string, string>
}

export interface CatalogItem {
  stableId: string
  providerId?: string | null
  title: string
  subtitle: string
  description: string
  imageUrl: string
  kind: ContentKind
  group: string
  badgeText: string
  channelNumber?: number | null
  languageLabel?: string | null
  normalizedTitle?: string | null
  normalizedGroup?: string | null
  seriesName?: string | null
  seriesKey?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
  streamOptions: StreamOption[]
  isWatched?: boolean
  overviewEn?: string | null
  voteAverage?: number | null
  voteCount?: number | null
  runtimeMinutes?: number | null
  genres: string[]
  countries?: string[]
  backdropUrl?: string | null
  tmdbPosterUrl?: string | null
  tagline?: string | null
  releaseDate?: string | null
  year?: number | null
  tmdbTitle?: string | null
  totalSeasons?: number | null
  stillPath?: string | null
  airDate?: string | null
  titleEn?: string | null
  episodeType?: string | null
  imdbId?: string | null
}

export interface WatchProgressItem {
  contentId: string
  contentType: string
  positionMs: number
  durationMs: number
  normalizedTitle: string
  title: string
  imageUrl: string
  tmdbPosterUrl?: string | null
  backdropUrl?: string | null
  seriesName?: string | null
  seriesProviderId?: string | null
  seasonNumber?: number | null
  episodeNumber?: number | null
  lastWatchedAt: string
  isWatched?: boolean
  overview?: string | null
  voteAverage?: number | null
  voteCount?: number | null
  runtimeMinutes?: number | null
  genres?: string[]
  year?: number | null
  tmdbTitle?: string | null
  totalSeasons?: number | null
  tagline?: string | null
  releaseDate?: string | null
  imdbId?: string | null
}

export interface BrowseSection {
  title: string
  items: CatalogItem[]
  contentType?: string | null
  groupName?: string | null
  sectionTitle?: string | null
  year?: number | null
  currentPage: number
  hasNextPage: boolean
}

export interface HomeCatalog {
  sections: BrowseSection[]
}

export interface CalendarEvent {
  id?: string
  fecha?: string
  hora: string
  competicion?: string
  subtitulo_competicion?: string
  categoria?: string
  equipos?: string
  imagen_evento?: string
  canales_original?: string[]
  canales_resueltos: {
    channel_id?: string
    display_name?: string
    source_name?: string
    provider_id?: string
    stream_url?: string
    logo?: string
    quality?: string
    content_type?: string
    priority?: number
  }[]
}

export interface CalendarResponse {
  fecha: string
  eventos: CalendarEvent[]
}

export type MainMode = 'Home' | 'TV' | 'Events' | 'Discover' | 'Search' | 'Settings'
