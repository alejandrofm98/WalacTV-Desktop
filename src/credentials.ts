import { LazyStore } from '@tauri-apps/plugin-store'

const store = new LazyStore('credentials.dat', { defaults: {}, autoSave: 1000 })

let _username = ''
let _password = ''

export async function saveCredentials(username: string, password: string): Promise<void> {
  _username = username
  _password = password
  await store.set('username', username)
  await store.set('password', password)
}

export async function loadCredentials(): Promise<{ username: string; password: string } | null> {
  const username = await store.get<string>('username')
  const password = await store.get<string>('password')
  if (username && password) {
    _username = username
    _password = password
    return { username, password }
  }
  return null
}

export async function clearCredentials(): Promise<void> {
  _username = ''
  _password = ''
  await store.delete('username')
  await store.delete('password')
}

export function getUsername(): string {
  return _username
}

export function getPassword(): string {
  return _password
}
