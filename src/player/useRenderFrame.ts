import { useEffect, useRef, type RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface FrameInfo {
  width: number
  height: number
  counter: number
  pixels: Uint8ClampedArray<ArrayBuffer> | null
}

/**
 * Parses the raw binary frame from mpv_get_render_frame.
 * Layout: [width:u32 LE][height:u32 LE][counter:u32 LE][RGBA8 pixels...]
 */
function parseFrame(buf: ArrayBuffer): FrameInfo {
  const view = new DataView(buf)
  const width = view.getUint32(0, true)
  const height = view.getUint32(4, true)
  const counter = view.getUint32(8, true)

  if (width === 0 || height === 0) {
    return { width: 0, height: 0, counter: 0, pixels: null }
  }

  const pixelLen = width * height * 4
  // Allocate fresh buffer; ImageData<ArrayBuffer> rejects SharedArrayBuffer
  const ab = new ArrayBuffer(pixelLen)
  const src = new Uint8Array(buf, 12, pixelLen)
  const dst = new Uint8Array(ab)
  dst.set(src)
  const pixels = new Uint8ClampedArray(ab) as Uint8ClampedArray<ArrayBuffer>
  return { width, height, counter, pixels }
}

/**
 * Debounce helper — returns a function that delays invoking `fn`
 * until `delay` ms have elapsed since the last call.
 */
function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: Parameters<T>) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }
}

/**
 * Hook that runs a requestAnimationFrame loop while the player is active,
 * pulling frames from the Rust backend via `mpv_get_render_frame` and
 * rendering them onto the provided `<canvas>` element.
 *
 * Also observes the canvas wrapper element (parentElement) via ResizeObserver
 * and tells the Rust backend the new render size (container CSS size ×
 * devicePixelRatio) so the offscreen FBO matches the display area.
 *
 * The loop stops automatically when:
 * - The component unmounts (cleanup)
 * - No item is loaded (playerItemId is null)
 * - `isActive` is false (all platforms now use wid embedding, not canvas render)
 */
export function useRenderFrame(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  playerItemId: string | null,
  isActive: boolean = true,
  onFps?: (fps: number) => void,
): void {
  const lastCounter = useRef(0)
  const rafId = useRef<number>(0)
  const lastSize = useRef({ w: 0, h: 0 })
  const fpsState = useRef({ count: 0, start: 0 })

  useEffect(() => {
    if (!playerItemId || !isActive) return

    let running = true

    // ── ResizeObserver: tell Rust backend the target render size ──
    const reportSize = debounce(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const wrapper = canvas.parentElement
      if (!wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const w = Math.round(rect.width * devicePixelRatio)
      const h = Math.round(rect.height * devicePixelRatio)
      if (w > 0 && h > 0) {
        invoke('mpv_set_render_size', { width: w, height: h }).catch(() => {
          // Ignore errors — player may not be initialized yet
        })
      }
    }, 150)

    // Wire up ResizeObserver on the wrapper
    const wrapperEl = canvasRef.current?.parentElement ?? null
    let observer: ResizeObserver | null = null
    if (wrapperEl) {
      observer = new ResizeObserver(reportSize)
      observer.observe(wrapperEl)
    }

    // Report initial size once
    reportSize()

    // ── Render loop ──
    async function poll() {
      if (!running) return

      try {
        // Cheap counter poll first: only fetch the full frame when a new one
        // has been rendered. Avoids transferring frame bytes on every rAF
        // while the Rust render loop only advances on new mpv frames.
        const counter = (await invoke('mpv_get_frame_counter')) as number
        if (counter === 0 || counter === lastCounter.current) {
          rafId.current = requestAnimationFrame(poll)
          return
        }
        lastCounter.current = counter

        // invoke returns ArrayBuffer when the Rust command returns Response
        const buf = (await invoke('mpv_get_render_frame')) as ArrayBuffer
        const { width, height, pixels } = parseFrame(buf)

        const canvas = canvasRef.current
        if (!canvas) {
          rafId.current = requestAnimationFrame(poll)
          return
        }

        const ctx = canvas.getContext('2d')
        if (!ctx) {
          rafId.current = requestAnimationFrame(poll)
          return
        }

        // Resize canvas if the frame dimensions changed
        if (width !== lastSize.current.w || height !== lastSize.current.h) {
          canvas.width = width
          canvas.height = height
          lastSize.current = { w: width, h: height }
        }

        if (pixels) {
          const imageData = new ImageData(pixels, width, height)
          ctx.putImageData(imageData, 0, 0)

          // Report frames-per-second once per second to the caller.
          const now = performance.now()
          if (fpsState.current.start === 0) fpsState.current.start = now
          fpsState.current.count += 1
          if (onFps && now - fpsState.current.start >= 1000) {
            const elapsed = (now - fpsState.current.start) / 1000
            onFps(Math.round(fpsState.current.count / elapsed))
            fpsState.current.count = 0
            fpsState.current.start = now
          }
        }
      } catch (err) {
        // Silently continue — errors are expected when player is shutting down
        if (running) {
          console.warn('[useRenderFrame] poll error:', err)
        }
      }

      if (running) {
        rafId.current = requestAnimationFrame(poll)
      }
    }

    // Start the loop
    rafId.current = requestAnimationFrame(poll)

    return () => {
      running = false
      cancelAnimationFrame(rafId.current)
      lastCounter.current = 0
      fpsState.current = { count: 0, start: 0 }
      if (observer && wrapperEl) {
        observer.unobserve(wrapperEl)
        observer.disconnect()
      }
    }
  }, [playerItemId, canvasRef, isActive])
}
