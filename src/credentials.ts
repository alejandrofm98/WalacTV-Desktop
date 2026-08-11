import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

// Kept only to migrate credentials written by versions before the keyring migration.
const legacyStore = new LazyStore('credentials.dat', { defaults: {}, autoSave: 1000 })

interface StoredCredentials {
  username: string
  password: string
}

let _username = ''
let _password = ''

export async function saveCredentials(username: string, password: string): Promise<void> {
  _username = username
  _password = password
  await invoke('secure_credentials_save', { username, password })
}

export async function loadCredentials(): Promise<{ username: string; password: string } | null> {
  const stored = await invoke<StoredCredentials | null>('secure_credentials_load')
  if (stored?.username && stored.password) {
    _username = stored.username
    _password = stored.password
    return stored
  }

  const legacyUsername = await legacyStore.get<string>('username')
  const legacyPassword = await legacyStore.get<string>('password')
  if (legacyUsername && legacyPassword) {
    await saveCredentials(legacyUsername, legacyPassword)
    await legacyStore.delete('username')
    await legacyStore.delete('password')
    return { username: legacyUsername, password: legacyPassword }
  }
  return null
}

export async function clearCredentials(): Promise<void> {
  _username = ''
  _password = ''
  await invoke('secure_credentials_clear')
  await legacyStore.delete('username')
  await legacyStore.delete('password')
}

export function getUsername(): string {
  return _username
}

export function getPassword(): string {
  return _password
}
