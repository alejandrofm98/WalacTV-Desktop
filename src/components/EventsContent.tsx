import { useState, useEffect } from 'react'
import type { CalendarEvent, CatalogItem } from '../api/types'
import { getCalendarEvents, getMpvUrl, normalizeRemoteImageUrl, IPTV_BASE } from '../api/client'
import { useAppStore } from '../store/useAppStore'
import { MediaCard } from './MediaCard'
import { SearchInput } from './SearchInput'
import styles from './EventsContent.module.css'

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ponytail: map calendar event to CatalogItem so MediaCard renders images
function mapEventToItem(ev: CalendarEvent): CatalogItem {
  const img = normalizeRemoteImageUrl(ev.imagen_evento)
  const streamOptions = (ev.canales_resueltos ?? [])
    .filter((c) => c.stream_url || c.provider_id || c.channel_id)
    .map((c) => {
      const rawUrl = c.stream_url ||
        `${IPTV_BASE}/live/{{USERNAME}}/{{PASSWORD}}/${c.provider_id || c.channel_id}`
      return { label: c.source_name || c.display_name || 'Ver', url: getMpvUrl(rawUrl), rawUrl, providerId: c.provider_id }
    })

  return {
    stableId: ev.id || `event_${ev.hora}_${ev.equipos}`,
    providerId: ev.id || null,
    title: ev.equipos || ev.competicion || 'Evento',
    subtitle: [ev.categoria, ev.subtitulo_competicion].filter(Boolean).join(' | '),
    description: (ev.canales_original ?? []).join(' | '),
    imageUrl: img,
    kind: 'EVENT',
    group: ev.competicion || '',
    badgeText: ev.hora || '',
    streamOptions,
    genres: [],
  }
}

export function EventsContent() {
  const [events, setEvents] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const openPlayer = useAppStore((s) => s.openPlayer)

  useEffect(() => {
    setLoading(true)
    getCalendarEvents(todayStr())
      .then((r) => setEvents((r.eventos ?? []).map(mapEventToItem)))
      .catch((e) => setError(e.message ?? 'Error cargando eventos'))
      .finally(() => setLoading(false))
  }, [])

  const filteredEvents = query.trim()
    ? events.filter((ev) => {
        const q = query.toLowerCase()
        return (
          ev.title.toLowerCase().includes(q) ||
          ev.subtitle?.toLowerCase().includes(q) ||
          ev.description?.toLowerCase().includes(q) ||
          ev.badgeText?.toLowerCase().includes(q) ||
          ev.group?.toLowerCase().includes(q)
        )
      })
    : events

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Eventos de hoy</h2>
        <span className={styles.date}>{todayStr()}</span>
        <SearchInput placeholder="Buscar eventos..." value={query} onChange={setQuery} />
      </div>

      {loading ? (
        <div className={styles.center}>Cargando eventos...</div>
      ) : error ? (
        <div className={styles.center}>{error}</div>
      ) : events.length === 0 ? (
        <div className={styles.center}>No hay eventos para hoy</div>
      ) : filteredEvents.length === 0 ? (
        <div className={styles.center}>Sin resultados</div>
      ) : (
        <div className={styles.grid}>
          {filteredEvents.map((item) => (
            <MediaCard
              key={item.stableId}
              item={item}
              width={280}
              height={200}
              showText
              onClick={() => openPlayer(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
