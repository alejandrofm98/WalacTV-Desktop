import type { CatalogItem } from '../api/types'

/**
 * Find the first unwatched episode after (fromSeason, fromEpisode).
 * Searches same season first, then falls back to subsequent seasons.
 * If all episodes are watched, returns null.
 */
export function pickFirstUnwatched(
  episodes: CatalogItem[],
  fromSeason: number,
  fromEpisode: number,
): CatalogItem | null {
  // Same season, after current episode
  const sameSeason = episodes
    .filter(ep => ep.seasonNumber === fromSeason && (ep.episodeNumber ?? 0) > fromEpisode && !ep.isWatched)
    .sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0))
  if (sameSeason.length > 0) return sameSeason[0]

  // Subsequent seasons, first unwatched in each
  const laterSeasons = episodes
    .filter(ep => (ep.seasonNumber ?? 0) > fromSeason && !ep.isWatched)
    .sort((a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0))
  if (laterSeasons.length > 0) return laterSeasons[0]

  return null
}
