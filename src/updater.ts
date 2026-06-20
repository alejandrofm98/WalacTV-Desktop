import { APP_VERSION } from './version'
import { GITHUB_REPO } from './config'

export interface UpdateInfo {
  available: boolean
  version?: string
  body?: string
  downloadUrl?: string
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github.v3+json' } },
    )
    if (!r.ok) return { available: false }
    const release = await r.json()
    const latest = (release.tag_name ?? '').replace(/^v/, '')
    if (latest && latest !== APP_VERSION) {
      const asset = (release.assets ?? []).find((a: { name: string }) =>
        a.name.includes('.deb') || a.name.includes('.exe') || a.name.includes('.AppImage'),
      )
      return {
        available: true,
        version: latest,
        body: release.body ?? '',
        downloadUrl: asset?.browser_download_url ?? release.html_url,
      }
    }
    return { available: false }
  } catch {
    return { available: false }
  }
}

export { APP_VERSION }
