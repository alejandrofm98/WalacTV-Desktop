import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import type { PlayerItem } from './types'
import { playerService } from './PlayerService'
import { usePlayerStore } from './usePlayerStore'
import { playbackSubtitle, playbackTitle } from '../api/client'
import { useAppStore } from '../store/useAppStore'

/**
 * Puente main <-> overlay (solo Windows wid nativo, dos webviews).
 *
 * La overlay no puede tocar el PlayerService del main (instancia JS aparte),
 * asi que el main le publica un snapshot del item y ella le envia acciones
 * de nivel app por eventos. El transporte fino (pause/seek/volumen) lo hace
 * la overlay via invoke directo de comandos mpv.
 */

export const OVERLAY_STATE_EVENT = 'overlay://state'
export const OVERLAY_CTL_EVENT = 'overlay://ctl'

export interface OverlayItemSnapshot {
  title: string
  subtitle: string
  kind: string
  label: string
}

export type OverlayCtl =
  | { action: 'close' }
  | { action: 'zap'; dir: 1 | -1 }
  | { action: 'fullscreen' }
  | { action: 'escape' }

export function emitOverlayState(item: PlayerItem | null, label: string | null): void {
  const snapshot: OverlayItemSnapshot | null = item
    ? {
        title: playbackTitle(item),
        subtitle: playbackSubtitle(item),
        kind: item.kind,
        label: label ?? '',
      }
    : null
  void emit(OVERLAY_STATE_EVENT, { item: snapshot })
}

/**
 * Escucha overlay://ctl en la webview principal y ejecuta las acciones en
 * el PlayerService/stores locales. Debe montarse solo con el player activo.
 */
export function useOverlayCtlBridge(): void {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null
    let cancelled = false

    listen<OverlayCtl>(OVERLAY_CTL_EVENT, (e) => {
      const ctl = e.payload
      const app = useAppStore.getState()
      switch (ctl.action) {
        case 'close':
          app.closePlayer()
          break
        case 'zap': {
          const item = app.playerItem
          if (!item) break
          if (item.kind === 'CHANNEL') app.zapChannel(ctl.dir)
          else app.zapSource(ctl.dir)
          break
        }
        case 'fullscreen':
          playerService.toggleFullscreen()
          break
        case 'escape':
          if (usePlayerStore.getState().isFullscreen) {
            playerService.exitFullscreen()
          } else {
            app.closePlayer()
          }
          break
      }
    }).then((un) => {
      if (cancelled) {
        un()
      } else {
        unlisten = un
      }
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
