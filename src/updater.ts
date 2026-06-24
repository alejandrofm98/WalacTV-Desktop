import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { APP_VERSION } from './version'

export { APP_VERSION }

export interface UpdateInfo {
  available: boolean
  version?: string
  body?: string
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  try {
    const update = await check()
    if (!update) return { available: false }
    return {
      available: true,
      version: update.version,
      body: update.body,
    }
  } catch {
    return { available: false }
  }
}

export async function downloadAndInstall(
  onProgress?: (event: { event: string; data?: unknown }) => void
): Promise<void> {
  const update = await check()
  if (!update) return
  await update.downloadAndInstall(onProgress)
  await relaunch()
}
