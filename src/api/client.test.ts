import { describe, expect, it } from 'vitest'
import { mapItem, normalizeRemoteImageUrl, orderEpisodeStreams, playbackSubtitle, playbackTitle, streamOptionMatchesLanguage } from './client'
import type { CatalogItem, StreamOption } from './types'

function opt(label: string, extra: Partial<StreamOption> = {}): StreamOption {
  return { label, url: `https://x.test/${label}`, rawUrl: '', ...extra }
}

function item(extra: Partial<CatalogItem>): CatalogItem {
  return {
    stableId: '1',
    title: 'Provider Title',
    subtitle: '',
    description: '',
    imageUrl: '',
    kind: 'MOVIE',
    group: '',
    badgeText: '',
    genres: [],
    streamOptions: [],
    ...extra,
  }
}

describe('API response mapping', () => {
  it('normalizes relative and insecure image URLs', () => {
    expect(normalizeRemoteImageUrl('//cdn.example.test/poster.jpg')).toBe(
      'https://cdn.example.test/poster.jpg',
    )
    expect(normalizeRemoteImageUrl('http://image.tmdb.org/t/p/w500/poster.jpg')).toBe(
      'https://image.tmdb.org/t/p/w500/poster.jpg',
    )
  })

  it('maps series-specific raw fields to a stable catalog item', () => {
    const item = mapItem({
      id: 42,
      title: 'Episode 1',
      series_name: 'Example Series',
      season_number: 1,
      episode_number: 1,
      stream_options: [{ label: 'HD', url: '/movie/{{USERNAME}}/{{PASSWORD}}/42' }],
    })

    expect(item.kind).toBe('SERIES')
    expect(item.stableId).toBe('42')
    expect(item.seriesName).toBe('Example Series')
    expect(item.seasonNumber).toBe(1)
    expect(item.streamOptions[0]?.rawUrl).toContain('{{USERNAME}}')
  })

  it('preserves explicit event type and provider identifiers', () => {
    const item = mapItem({
      id: 'event-1',
      provider_id: 99,
      type: 'event',
      title: 'Live event',
      stream_options: [],
    })

    expect(item.kind).toBe('EVENT')
    expect(item.providerId).toBe('99')
    expect(item.streamOptions[0]?.url).toContain('/live/')
  })
})

describe('episode stream ordering', () => {
  it('matches language from field or label tokens', () => {
    expect(streamOptionMatchesLanguage(opt('ES'), 'ES')).toBe(true)
    expect(streamOptionMatchesLanguage(opt('EN'), 'ES')).toBe(false)
    expect(streamOptionMatchesLanguage(opt('ES HD'), 'es')).toBe(true)
    expect(streamOptionMatchesLanguage(opt('HD', { language: 'EN' }), 'EN')).toBe(true)
    expect(streamOptionMatchesLanguage(opt('ENGLISH'), 'EN')).toBe(false)
  })

  it('orders direct same-lang, torrent same-lang, direct other, torrent other', () => {
    const iptv = [opt('EN'), opt('ES')]
    const torrents = [opt('SPA 1080p', { infoHash: 'a', language: 'ES' }), opt('ENG 1080p', { infoHash: 'b', language: 'EN' })]
    const ordered = orderEpisodeStreams(iptv, torrents, 'ES')
    expect(ordered.map((o) => o.label)).toEqual(['ES', 'SPA 1080p', 'EN', 'ENG 1080p'])
  })

  it('drops unplayable options', () => {
    const ordered = orderEpisodeStreams([opt('ES', { url: '' })], [], 'ES')
    expect(ordered).toEqual([])
  })
})

describe('playback titles', () => {
  it('prefers tmdb title for movies', () => {
    expect(playbackTitle(item({ kind: 'MOVIE', title: 'Prov', tmdbTitle: 'TMDB' }))).toBe('TMDB')
    expect(playbackTitle(item({ kind: 'MOVIE', title: 'Prov', tmdbTitle: null }))).toBe('Prov')
  })

  it('prefers series tmdb name over provider name for episodes', () => {
    const ep = item({
      kind: 'SERIES',
      title: 'Capitulo proveedor',
      seriesName: 'Serie Proveedor [4K]',
      seriesTmdbTitle: 'Serie TMDB',
      tmdbTitle: 'Capitulo TMDB',
      seasonNumber: 2,
      episodeNumber: 8,
    })
    expect(playbackTitle(ep)).toBe('Serie TMDB')
    expect(playbackSubtitle(ep)).toBe('T2:E8 · Capitulo TMDB')
  })

  it('falls back to provider series name without tmdb data', () => {
    const ep = item({
      kind: 'SERIES',
      title: 'E8',
      seriesName: 'Serie Proveedor',
      seriesTmdbTitle: null,
      tmdbTitle: null,
      seasonNumber: 1,
      episodeNumber: 8,
    })
    expect(playbackTitle(ep)).toBe('Serie Proveedor')
    expect(playbackSubtitle(ep)).toBe('T1:E8 · E8')
  })

  it('collapses subtitle tag when episode name equals title', () => {
    const ep = item({
      kind: 'SERIES',
      title: 'Serie TMDB',
      seriesName: null,
      seriesTmdbTitle: 'Serie TMDB',
      tmdbTitle: 'Serie TMDB',
      seasonNumber: 1,
      episodeNumber: 1,
    })
    expect(playbackSubtitle(ep)).toBe('T1:E1')
  })

  it('uses tmdb title for series-level items', () => {
    expect(
      playbackTitle(item({ kind: 'SERIES', title: 'Prov', seriesName: 'Prov Serie', tmdbTitle: 'TMDB Serie' })),
    ).toBe('TMDB Serie')
  })
})
