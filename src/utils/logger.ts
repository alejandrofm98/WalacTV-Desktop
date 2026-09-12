/** Logger centralizado: debug solo en dev, avisos/errores siempre (sin PII). */
export const isDev = import.meta.env.DEV

export function devLog(...args: unknown[]): void {
  if (isDev) console.log(...args)
}

export function devWarn(...args: unknown[]): void {
  if (isDev) console.warn(...args)
}

export function devError(...args: unknown[]): void {
  if (isDev) console.error(...args)
}
