export const API_URL = import.meta.env.VITE_API_URL || ''

export const IS_DEV = import.meta.env.DEV

export const BASE = IS_DEV ? '' : API_URL

export const GITHUB_REPO = 'alejandrofm98/walactv-desktop'
