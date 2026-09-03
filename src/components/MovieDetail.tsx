import { useEffect, useState, useMemo, type ReactNode } from 'react'
import type { CatalogItem, StreamOption, WatchProgressItem } from '../api/types'
import { cwGroupKey, getTorrentioMovieStreams, isPlayableOption } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import styles from './MovieDetail.module.css'

interface Props {
  item: CatalogItem
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${m}min`
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  return `${Math.round(mb)} MB`
}

function qualityOf(opt: StreamOption): string {
  const q = opt.quality?.toLowerCase() ?? ''
  if (q) return q
  const hay = `${opt.label} ${opt.torrentTitle ?? ''}`.toLowerCase()
  if (hay.includes('2160') || hay.includes('4k')) return '2160p'
  if (hay.includes('1080')) return '1080p'
  if (hay.includes('720')) return '720p'
  return 'SD'
}

function computeCwEntry(item: CatalogItem, entries: Map<string, WatchProgressItem>): WatchProgressItem | undefined {
  return entries.get(cwGroupKey('movie', null, item.stableId))
    ?? entries.get(item.stableId)
    ?? entries.get(item.providerId ?? '')
}

export function MovieDetail({ item }: Props) {
  const { closeDetail, openPlayer, continueWatchingEntries } = useAppStore()
  const [selectedStream, setSelectedStream] = useState(0)
  const [torrentStreams, setTorrentStreams] = useState<StreamOption[]>([])
  const [torrentLoading, setTorrentLoading] = useState(false)
  const [torrentError, setTorrentError] = useState(false)

  useEffect(() => {
    let active = true
    setTorrentStreams([])
    setTorrentError(false)
    // Torrentio directo requiere imdb_id (tt...). Si no hay, no se consulta.
    const imdb = item.imdbId?.trim() ?? ''
    if (!/^tt\d+$/i.test(imdb)) {
      setTorrentLoading(false)
      return () => { active = false }
    }
    setTorrentLoading(true)
    getTorrentioMovieStreams(imdb)
      .then((streams) => { if (active) setTorrentStreams(streams) })
      .catch((error) => {
        console.warn('[Torrentio] movie lookup failed:', error)
        const isMissingImdb = String((error as Error)?.message ?? '').includes('imdb_id')
        if (active) { setTorrentStreams([]); setTorrentError(!isMissingImdb) }
      })
      .finally(() => { if (active) setTorrentLoading(false) })
    return () => { active = false }
  }, [item.imdbId])

  const iptvStreams = useMemo(
    () => item.streamOptions.filter((o) => isPlayableOption(o) && !o.infoHash),
    [item.streamOptions],
  )
  const torrents = useMemo(
    () => [...torrentStreams, ...item.streamOptions.filter((o) => !!o.infoHash)],
    [torrentStreams, item.streamOptions],
  )

  const allStreams = [...iptvStreams, ...torrents]

  const bestTorrent = useMemo(() => {
    if (torrents.length === 0) return null
    const byQuality = (q: string) =>
      q === '2160p' ? 4 : q === '1080p' ? 3 : q === '720p' ? 2 : 1
    return [...torrents].sort(
      (a, b) =>
        byQuality(qualityOf(b)) - byQuality(qualityOf(a)) ||
        (b.seeders ?? 0) - (a.seeders ?? 0),
    )[0]
  }, [torrents])

  const bestIndex = useMemo(() => {
    if (bestTorrent) return allStreams.indexOf(bestTorrent)
    return iptvStreams.length > 0 ? 0 : -1
  }, [bestTorrent, allStreams, iptvStreams])

  const selectedOption = allStreams[selectedStream]
  const selectedPlayable = Boolean(selectedOption?.url || selectedOption?.infoHash)

  const cwEntry = computeCwEntry(item, continueWatchingEntries)
  const isResume = cwEntry && !cwEntry.isWatched && cwEntry.positionMs > 0
  const resumePercent = isResume ? Math.round((cwEntry.positionMs * 100) / cwEntry.durationMs) : 0

  const displayTitle = item.tmdbTitle ?? item.title
  const isTorrentStream = (o: StreamOption) => !!o.infoHash

  const metaPieces: ReactNode[] = []
  if ((item.voteAverage ?? 0) > 0) {
    metaPieces.push(
      <span className={styles.ratingBadge}>★ {item.voteAverage!.toFixed(1)}</span>
    )
  }
  if (item.year) {
    metaPieces.push(<span className={styles.metaText}>{item.year}</span>)
  }
  if (item.runtimeMinutes) {
    metaPieces.push(<span className={styles.metaText}>{formatRuntime(item.runtimeMinutes)}</span>)
  }
  if (item.genres.length > 0) {
    metaPieces.push(<span className={styles.metaText}>{item.genres.slice(0, 3).join(', ')}</span>)
  }
  if (item.languageLabel) {
    metaPieces.push(<span className={styles.metaText}>{item.languageLabel}</span>)
  }

  const sourceCount = useMemo(() => allStreams.length, [allStreams])
  const torrentCount = useMemo(() => torrents.length, [torrents])
  const iptvCount = useMemo(() => iptvStreams.length, [iptvStreams])

  return (
    <div className={styles.container}>
      <div className={styles.backdrop}>
        {(item.backdropUrl || item.tmdbPosterUrl || item.imageUrl) ? (
          <img
            src={item.backdropUrl || item.tmdbPosterUrl || item.imageUrl}
            alt=""
            className={styles.backdropImage}
          />
        ) : (
          <div className={styles.backdropFallback} />
        )}
        <div className={styles.backdropOverlay} />
      </div>

      <button onClick={closeDetail} aria-label="Volver" className={styles.backBtn}>
        ← Volver
      </button>

      <div className={styles.content}>
        {item.tagline && (
          <p className={styles.tagline}>{item.tagline}</p>
        )}

        <h1 className={styles.title}>{displayTitle}</h1>

        {metaPieces.length > 0 && (
          <div className={styles.metaRow}>
            {metaPieces.map((piece, i) => (
              <span key={i} className={styles.metaItem}>
                {i > 0 && <span className={styles.metaSep} aria-hidden="true">·</span>}
                {piece}
              </span>
            ))}
          </div>
        )}

        {item.description && (
          <p className={styles.synopsis}>{item.description}</p>
        )}

        <div className={styles.statusRow}>
          {item.isWatched && (
            <span className={styles.statusWatched}>
              <span className={styles.statusCheck}>✓</span>
              Visto
            </span>
          )}
          {isResume && (
            <span className={styles.statusResume}>
              Continuar desde {resumePercent}%
            </span>
          )}
        </div>

        {(allStreams.length > 0 || torrentLoading || torrentError) && (
          <section className={styles.streamSection}>
            <div className={styles.streamHead}>
              <h3 className={styles.streamTitle}>Fuentes de reproducción</h3>
              {!torrentLoading && (
                <span className={styles.streamCount}>
                  {sourceCount} fuentes · mejores por calidad
                </span>
              )}
            </div>

            {torrentLoading && (
              <p className={styles.statusText}>Buscando en Torrentio...</p>
            )}
            {torrentError && !torrentLoading && (
              <p className={styles.statusText}>No se pudo consultar Torrentio.</p>
            )}

            {bestIndex >= 0 && !torrentLoading && (
              <button
                className={styles.autoRow}
                onClick={() => setSelectedStream(bestIndex)}
                aria-pressed={selectedStream === bestIndex}
              >
                <span className={styles.autoMagic}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
                <span className={styles.autoBody}>
                  <span className={styles.autoLabel}>
                    {bestTorrent ? (bestTorrent.torrentTitle ?? bestTorrent.label) : (selectedOption?.label ?? 'Directo')}
                  </span>
                  <span className={styles.autoSub}>
                    {qualityOf(bestTorrent ?? selectedOption!).toUpperCase()} ·{' '}
                    {bestTorrent?.seeders != null ? `${bestTorrent.seeders} seeds · ` : ''}
                    {bestTorrent?.sizeBytes != null ? formatSize(bestTorrent.sizeBytes) : (bestTorrent ? '' : 'EN DIRECTO')}
                  </span>
                </span>
                <span className={`${styles.sourceTag} ${bestTorrent ? styles.sourceTagTorrent : styles.sourceTagIptv}`}>
                  <span className={styles.tagDot} />
                  {isTorrentStream(bestTorrent ?? selectedOption!) ? 'Torrent' : 'IPTV'}
                </span>
                <span className={styles.autoPlay}>
                  {selectedStream === bestIndex && (isResume ? 'Reanudar' : 'Reproducir')}
                </span>
              </button>
            )}

            {iptvCount > 0 && (
              <>
                <div className={`${styles.groupLabel} ${styles.groupLabelIptv}`}>
                  <span className={styles.groupBar} />
                  Directo IPTV
                </div>
                {iptvStreams.map((opt, i) => (
                  <StreamRow
                    key={`iptv-${i}`}
                    opt={opt}
                    variant="iptv"
                    selected={selectedStream === i}
                    onPlay={() => { setSelectedStream(i); openPlayer({ ...item, streamOptions: allStreams }, i) }}
                    onSelect={() => setSelectedStream(i)}
                  />
                ))}
              </>
            )}

            {torrentCount > 0 && (
              <>
                <div className={`${styles.groupLabel} ${styles.groupLabelTorrent}`}>
                  <span className={styles.groupBar} />
                  Torrent
                </div>
                {torrents.map((opt, i) => {
                  const idx = iptvCount + i
                  return (
                    <StreamRow
                      key={`tor-${i}`}
                      opt={opt}
                      variant="torrent"
                      selected={selectedStream === idx}
                      onPlay={() => { setSelectedStream(idx); openPlayer({ ...item, streamOptions: allStreams }, idx) }}
                      onSelect={() => setSelectedStream(idx)}
                    />
                  )
                })}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function StreamRow({
  opt,
  variant,
  selected,
  onPlay,
  onSelect,
}: {
  opt: StreamOption
  variant: 'iptv' | 'torrent'
  selected: boolean
  onPlay: () => void
  onSelect: () => void
}) {
  const quality = qualityOf(opt)
  const isTorrent = variant === 'torrent'

  return (
    <div
      className={`${styles.streamRow} ${selected ? styles.streamRowSelected : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPlay() }
      }}
    >
      <span className={`${styles.srcIco} ${isTorrent ? styles.srcIcoTorrent : styles.srcIcoIptv}`}>
        {isTorrent ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M16 3v4M8 3v4" /></svg>
        )}
      </span>

      <span className={styles.siTitle}>{opt.torrentTitle ?? opt.label ?? 'Directo'}</span>

      <span className={styles.siMeta}>
        {opt.language && !isTorrent && (
          <span className={styles.langTag}>{opt.language}</span>
        )}
        {opt.seeders != null && (
          <span className={styles.seeds}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12v8M8 8v12M12 4v16M16 8v12M20 12v8" /></svg>
            {opt.seeders}
          </span>
        )}
        {opt.sizeBytes != null && (
          <span className={styles.size}>{formatSize(opt.sizeBytes)}</span>
        )}
        {!isTorrent && (
          <span className={styles.liveTag}>EN DIRECTO</span>
        )}
      </span>

      <span className={styles.rowPlay} onClick={(e) => { e.stopPropagation(); onPlay() }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
      </span>
    </div>
  )
}