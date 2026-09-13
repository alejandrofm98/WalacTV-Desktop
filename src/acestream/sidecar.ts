import { invoke } from '@tauri-apps/api/core'

/** Origen del engine: externo (del usuario), gestionado (hijo de la app) u off. Spike. */
export type AcestreamEngineMode = 'external' | 'managed' | 'off'

export interface AcestreamEngineStatus {
  mode: AcestreamEngineMode
  managed: boolean
  port: number
  canInstall: boolean
}

/** Reutiliza el engine externo o lanza uno gestionado (puede tardar ~25s). */
export function ensureAcestreamEngine(): Promise<AcestreamEngineStatus> {
  return invoke<AcestreamEngineStatus>('acestream_engine_ensure')
}

export function getAcestreamEngineStatus(): Promise<AcestreamEngineStatus> {
  return invoke<AcestreamEngineStatus>('acestream_engine_status')
}

/** Detiene el engine solo si lo lanzamos nosotros. Best effort al cerrar. */
export function releaseAcestreamEngine(): Promise<void> {
  return invoke<void>('acestream_engine_release')
}

/** Auto-instala el bundle user-space (Linux). Tarda minutos; con aviso. */
export function installAcestreamEngine(): Promise<string> {
  return invoke<string>('acestream_engine_install')
}
