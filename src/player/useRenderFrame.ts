import { useEffect, useRef, type RefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'



/**
 * Reads the frame header from mpv_get_render_frame.
 * Layout: [width:u32 LE][height:u32 LE][counter:u32 LE][RGBA8 pixels...]
 */
function parseHeader(buf: ArrayBuffer): { width: number; height: number; counter: number } {
  const view = new DataView(buf)
  return {
    width: view.getUint32(0, true),
    height: view.getUint32(4, true),
    counter: view.getUint32(8, true),
  }
}

/**
 * Views the frame pixels without copying. The invoke transport may hand back
 * a SharedArrayBuffer (which ImageData rejects), so callers must copy into a
 * reusable ImageData via `.set()` instead of constructing one over this view.
 */
function framePixels(
  buf: ArrayBuffer,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBufferLike> | null {
  if (width === 0 || height === 0) return null
  const pixelLen = width * height * 4
  if (buf.byteLength < 12 + pixelLen) return null
  return new Uint8ClampedArray(buf, 12, pixelLen)
}

/**
 * Describe the wire shape of an invoke binary result (used in errors).
 * Tauri may resolve ArrayBuffer, SharedArrayBuffer, or (postMessage
 * fallback) a plain number array — handle all of them.
 */
function describeWire(v: unknown): string {
  const tag = Object.prototype.toString.call(v)
  const anyV = v as { byteLength?: unknown; length?: unknown }
  const size =
    typeof anyV?.byteLength === 'number'
      ? `bytes=${anyV.byteLength}`
      : typeof anyV?.length === 'number'
        ? `len=${anyV.length}`
        : 'nosize'
  return `${tag} ${size}`
}

/**
 * Normalize any invoke binary shape to a fresh ArrayBuffer copy.
 * Throws with shape info when the value is unusable.
 */
function toFrameBuffer(v: unknown): ArrayBuffer {
  if (v instanceof ArrayBuffer) {
    // SharedArrayBuffer is NOT instanceof ArrayBuffer — handled below.
    return v
  }
  const tag = Object.prototype.toString.call(v)
  if (tag === '[object SharedArrayBuffer]') {
    const src = new Uint8Array(v as SharedArrayBuffer)
    const out = new Uint8Array(src.byteLength)
    out.set(src)
    return out.buffer
  }
  if (Array.isArray(v)) {
    return new Uint8Array(v as number[]).buffer
  }
  throw new Error(`frame wire shape unsupported: ${describeWire(v)}`)
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
  // Reusable ImageData sized to the current frame: avoids allocating and
  // copying an 8MB buffer on every frame (~100ms/s saved at 1080p).
  const imageDataRef = useRef<ImageData | null>(null)

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

        // invoke returns ArrayBuffer when the Rust command returns Response,
        // but be tolerant (postMessage fallback may hand other shapes).
        const raw = (await invoke('mpv_get_render_frame')) as unknown
        const buf = toFrameBuffer(raw)
        const { width, height } = parseHeader(buf)
        const pixels = framePixels(buf, width, height)

        const canvas = canvasRef.current
        if (!canvas || !pixels) {
          rafId.current = requestAnimationFrame(poll)
          return
        }

        const ctx = canvas.getContext('2d')
        if (!ctx) {
          rafId.current = requestAnimationFrame(poll)
          return
        }

        // Resize canvas (and the reusable ImageData) if dimensions changed
        if (width !== lastSize.current.w || height !== lastSize.current.h) {
          canvas.width = width
          canvas.height = height
          lastSize.current = { w: width, h: height }
          imageDataRef.current = new ImageData(width, height)
        }
        if (!imageDataRef.current) {
          imageDataRef.current = new ImageData(width, height)
        }

        {
          // Copy into the reusable ImageData (single copy; no per-frame
          // ArrayBuffer/ImageData allocation) and blit to the canvas.
          const imageData = imageDataRef.current
          imageData.data.set(pixels)
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
      imageDataRef.current = null
      if (observer && wrapperEl) {
        observer.unobserve(wrapperEl)
        observer.disconnect()
      }
    }
  }, [playerItemId, canvasRef, isActive])
}
