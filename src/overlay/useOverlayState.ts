import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type {
  MpvEvent,
  MpvMute,
  MpvTimeUpdate,
  MpvVolume,
} from '../player/types'
import {
  OVERLAY_CTL_EVENT,
  OVERLAY_STATE_EVENT,
  type OverlayCtl,
  type OverlayItemSnapshot,
} from '../player/overlayBridge'

export interface OverlayPlaybackState {
  item: OverlayItemSnapshot | null
  isPlaying: boolean
  isBuffering: boolean
  time: number
  duration: number
  estFps: number
  volume: number
  muted: boolean
}

/**
 * Espejo de estado para la webview overlay (runtime JS separado del main).
 * - Estado de reproduccion: eventos mpv://event (broadcast a todas las ventanas).
 * - Metadatos del item: overlay://state emitido por el Player de la main.
 * - Acciones a nivel app (zapear, cerrar, fullscreen): overlay://ctl.
 * El transporte (pause/seek/volumen/mute) va por invoke directo: los comandos
 * Tauri son globales y mpv notifica el cambio via eventos.
 */
export function useOverlayState(): OverlayPlaybackState {
  const [item, setItem] = useState<OverlayItemSnapshot | null>(null)
  const [isPlaying, setPlaying] = useState(false)
  const [isBuffering, setBuffering] = useState(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [estFps, setFps] = useState(-1)
  const [volume, setVolume] = useState(0.5)
  const [muted, setMuted] = useState(false)

  // Al llegar un item nuevo (de null a item) se siembran volumen/mute desde
  // mpv: los eventos solo llegan en cambios y la overlay arranca sin estado.
  useEffect(() => {
    if (!item) return
    let cancelled = false
    const seed = async () => {
      try {
        const vol = await invoke<unknown>('mpv_get_property', { name: 'volume' })
        if (!cancelled) {
          const n = typeof vol === 'string' ? Number(vol) : Number(vol)
          if (Number.isFinite(n) && n >= 0) setVolume(Math.min(1, n / 100))
        }
        const mute = await invoke<unknown>('mpv_get_property', { name: 'mute' })
        if (!cancelled) {
          setMuted(mute === true || mute === 'yes' || mute === 'true')
        }
      } catch {
        // mpv puede no estar listo todavia; los eventos cubren el resto.
      }
    }
    void seed()
    return () => {
      cancelled = true
    }
  }, [item])

  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = []

    unlisteners.push(
      listen<{ item: OverlayItemSnapshot | null }>(OVERLAY_STATE_EVENT, (e) => {
        const next = e.payload?.item ?? null
        setItem(next)
        if (!next) {
          setPlaying(false)
          setBuffering(true)
          setTime(0)
          setDuration(0)
          setFps(-1)
        }
      }),
    )

    unlisteners.push(
      listen<MpvEvent>('mpv://event', (e) => {
        const payload = e.payload
        switch (payload.type) {
          case 'time-update': {
            const t = payload as MpvTimeUpdate
            setTime(t.position)
            setDuration(t.duration)
            if (typeof t.estimatedFps === 'number') setFps(t.estimatedFps)
            break
          }
          case 'state-change': {
            setPlaying(!payload.pause)
            setBuffering(payload.buffering)
            break
          }
          case 'end-file': {
            setPlaying(false)
            break
          }
          case 'file-loaded': {
            setBuffering(false)
            break
          }
          case 'volume': {
            const v = (payload as MpvVolume).volume
            setVolume(Math.min(1, Math.max(0, v)))
            break
          }
          case 'mute': {
            setMuted((payload as MpvMute).muted)
            break
          }
        }
      }),
    )

    return () => {
      for (const p of unlisteners) {
        p.then((un) => un()).catch(() => {})
      }
    }
  }, [])

  return { item, isPlaying, isBuffering, time, duration, estFps, volume, muted }
}

/** Envia una accion de control a la webview principal. */
export function sendOverlayCtl(ctl: OverlayCtl): void {
  void emit(OVERLAY_CTL_EVENT, ctl)
}

/** Transporte directo via comandos mpv (globales a la app). */
export const overlayTransport = {
  setPaused(paused: boolean): void {
    invoke('mpv_set_property', { name: 'pause', value: paused }).catch(() => {})
  },
  seekAbs(seconds: number): void {
    invoke('mpv_command', {
      args: ['seek', String(seconds), 'absolute'],
    }).catch(() => {})
  },
  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume))
    invoke('mpv_set_property', { name: 'volume', value: v * 100 }).catch(() => {})
  },
  setMuted(muted: boolean): void {
    invoke('mpv_set_property', { name: 'mute', value: muted }).catch(() => {})
  },
}
