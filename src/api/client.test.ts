import { describe, expect, it } from 'vitest'
import { mapItem, normalizeRemoteImageUrl } from './client'

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
