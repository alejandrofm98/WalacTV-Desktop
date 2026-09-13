import { fetch } from '@tauri-apps/plugin-http'

/**
 * Cliente minimo del engine Acestream local (spike de prueba).
 *
 * El engine expone su HTTP API en 127.0.0.1:6878. Flujo:
 *  1. checkAcestreamEngine() -> verifica que el engine corre (get_version).
 *  2. resolveAcestreamPlayback() -> manifest.m3u8?format=json -> playback_url.
 *  3. Esa playback_url se pasa a libmpv como cualquier otro stream HTTP.
 *  4. stopAcestreamSession() -> libera la sesion en el engine (best effort).
 *
 * Requiere el permiso http para http://127.0.0.1:6878 en
 * src-tauri/capabilities/default.json.
 */

export const ACESTREAM_ENGINE_BASE =
  (import.meta.env.VITE_ACESTREAM_URL as string | undefined)?.replace(/\/$/, '') ||
  'http://127.0.0.1:6878'

export type AcestreamIdKind = 'content_id' | 'infohash'

export interface AcestreamRef {
  kind: AcestreamIdKind
  value: string
}

export interface AcestreamSession {
  playbackUrl: string
  statUrl: string | null
  commandUrl: string | null
  isLive: boolean
}

/**
 * Acepta content_id en hex (40), enlace acestream://, magnet con btih o
 * el valor tal cual para dejar que el engine lo interprete.
 */
export function parseAcestreamInput(raw: string): AcestreamRef | null {
  const text = raw.trim()
  if (!text) return null

  const aceLink = /^acestream:\/\/?([^/?#]+)/i.exec(text)
  if (aceLink) return { kind: 'content_id', value: aceLink[1].toLowerCase() }

  const magnet = /xt=urn:btih:([a-f0-9]{40})/i.exec(text)
  if (magnet) return { kind: 'infohash', value: magnet[1].toLowerCase() }

  if (/^[a-f0-9]{40}$/i.test(text)) return { kind: 'content_id', value: text.toLowerCase() }

  return null
}

export async function checkAcestreamEngine(timeoutMs = 5000): Promise<{
  running: boolean
  version?: string
  error?: string
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${ACESTREAM_ENGINE_BASE}/webui/api/service?method=get_version`, {
      signal: controller.signal,
    } as unknown as RequestInit)
    if (!response.ok) {
      return { running: false, error: `Engine respondio ${response.status} ${response.statusText}` }
    }
    const data = (await response.json()) as { result?: { version?: string } }
    return { running: true, version: data?.result?.version }
  } catch (err) {
    return {
      running: false,
      error: err instanceof Error ? err.message : 'Engine no accesible en 127.0.0.1:6878',
    }
  } finally {
    clearTimeout(timer)
  }
}

interface ManifestJsonResponse {
  response?: {
    playback_url?: string
    stat_url?: string
    command_url?: string
    is_live?: number | boolean
  }
  error?: string | null
}

async function requestManifest(ref: AcestreamRef, timeoutMs: number): Promise<AcestreamSession> {
  const url =
    `${ACESTREAM_ENGINE_BASE}/ace/manifest.m3u8` +
    `?format=json&${ref.kind}=${encodeURIComponent(ref.value)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    } as unknown as RequestInit)
    if (!response.ok) {
      throw new Error(`Engine respondio ${response.status} ${response.statusText}`)
    }
    const data = (await response.json()) as ManifestJsonResponse
    if (data?.error) {
      throw new Error(typeof data.error === 'string' ? data.error : 'Error del engine')
    }
    const playbackUrl = data?.response?.playback_url?.trim()
    if (!playbackUrl) {
      throw new Error('El engine no devolvio playback_url (sin peers o id desconocido)')
    }
    const isLive = data.response?.is_live === 1 || data.response?.is_live === true
    return {
      playbackUrl,
      statUrl: data.response?.stat_url ?? null,
      commandUrl: data.response?.command_url ?? null,
      isLive,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resuelve un ID a URL reproducible. Si falla como content_id reintenta
 * como infohash (muchas listas mezclan ambos formatos en 40 hex).
 */
export async function resolveAcestreamPlayback(
  ref: AcestreamRef,
  timeoutMs = 25000,
): Promise<AcestreamSession> {
  const attempts: AcestreamRef[] =
    ref.kind === 'content_id'
      ? [ref, { kind: 'infohash', value: ref.value }]
      : [ref]
  let lastError = 'No se pudo resolver el stream Acestream'
  for (const attempt of attempts) {
    try {
      return await requestManifest(attempt, timeoutMs)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(lastError)
}

/** Libera la sesion en el engine. Best effort: nunca debe romper el unload. */
export async function stopAcestreamSession(commandUrl: string): Promise<void> {
  try {
    const separator = commandUrl.includes('?') ? '&' : '?'
    await fetch(`${commandUrl}${separator}method=stop`)
  } catch {
    // El engine limpia sesiones inactivas solo; ignorar errores aqui.
  }
}

export interface AcestreamStatsSnapshot {
  peers: number
  /** KB/s de bajada. */
  speedDown: number
  /** KB/s de subida. */
  speedUp: number
  status: string
  downloadedBytes: number
}

interface StatJsonResponse {
  response?: {
    peers?: number
    speed_down?: number
    speed_up?: number
    status?: string
    downloaded?: number
  }
}

/** Lee /ace/stat una vez. Lanza si el engine no responde o no hay sesion. */
export async function fetchAcestreamStats(
  statUrl: string,
  timeoutMs = 5000,
): Promise<AcestreamStatsSnapshot> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(statUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    } as unknown as RequestInit)
    if (!response.ok) {
      throw new Error(`stat respondio ${response.status}`)
    }
    const data = (await response.json()) as StatJsonResponse
    const resp = data?.response
    if (!resp) throw new Error('stat sin respuesta')
    return {
      peers: resp.peers ?? 0,
      speedDown: resp.speed_down ?? 0,
      speedUp: resp.speed_up ?? 0,
      status: resp.status ?? '',
      downloadedBytes: resp.downloaded ?? 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Veredicto rapido para decidir si cambiar de canal (spike).
 * Umbrales empiricos: <3 peers o <300 KB/s sostenidos = parones seguros.
 */
export function acestreamHealth(stats: AcestreamStatsSnapshot): {
  ok: boolean
  label: string
} {
  if (stats.peers >= 5 && stats.speedDown >= 800) {
    return { ok: true, label: 'Saludable' }
  }
  if (stats.peers >= 3 || stats.speedDown >= 300) {
    return { ok: true, label: 'Justo' }
  }
  return { ok: false, label: 'Debil: cambia de canal' }
}

/** Formatea KB/s a "850 KB/s" o "1.2 MB/s". */
export function formatAcestreamSpeed(kbPerSec: number): string {
  if (kbPerSec >= 1024) return `${(kbPerSec / 1024).toFixed(1)} MB/s`
  return `${Math.round(kbPerSec)} KB/s`
}
