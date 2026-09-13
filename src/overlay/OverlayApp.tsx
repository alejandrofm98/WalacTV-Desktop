import { useEffect } from 'react'
import { useOverlayState } from './useOverlayState'
import { OverlayControls } from './OverlayControls'

/**
 * Raiz de la webview overlay (Windows wid nativo, ?surface=overlay).
 *
 * Es una webview independiente con su propio runtime JS: no toca el
 * PlayerService del main ni las stores de la app. Fondo transparente y
 * sin contenido mientras no haya reproduccion activa, de modo que la
 * ventana (siempre visible y compositeada desde el arranque) sea
 * invisible e inocua fuera del reproductor.
 */
export function OverlayApp() {
  const state = useOverlayState()

  useEffect(() => {
    document.documentElement.classList.add('overlay-surface')
    return () => document.documentElement.classList.remove('overlay-surface')
  }, [])

  if (!state.item) return null
  return <OverlayControls state={state} />
}
