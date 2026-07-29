import { LazyStore } from '@tauri-apps/plugin-store'

const store = new LazyStore('settings.dat', { defaults: {}, autoSave: 1000 })

// ── Module-level cache (sync access) ─────────────────────────────────
let _volume = 1
let _preferredQuality: 'auto' | number = 'auto'
let _language = 'ES'

// ── Volume ───────────────────────────────────────────────────────────
export async function loadSettings(): Promise<void> {
  const vol = await store.get<number>('volume')
  if (typeof vol === 'number' && vol >= 0 && vol <= 1) _volume = vol

  const qual = await store.get<string | number>('preferredQuality')
  if (qual === 'auto' || typeof qual === 'number') _preferredQuality = qual

  const lang = await store.get<string>('language')
  if (lang) _language = lang
}

export function getVolume(): number {
  return _volume
}

export async function setVolume(v: number): Promise<void> {
  _volume = Math.max(0, Math.min(1, v))
  await store.set('volume', _volume)
}

// ── Preferred quality ────────────────────────────────────────────────
export function getPreferredQuality(): 'auto' | number {
  return _preferredQuality
}

export async function setPreferredQuality(q: 'auto' | number): Promise<void> {
  _preferredQuality = q
  await store.set('preferredQuality', q)
}

// ── Language ─────────────────────────────────────────────────────────
export function getLanguage(): string {
  return _language
}

export async function setLanguage(l: string): Promise<void> {
  _language = l
  await store.set('language', l)
}
