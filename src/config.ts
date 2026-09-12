export const API_URL = import.meta.env.VITE_API_URL || ''

export const BASE = API_URL

/** Backend configurado (VITE_API_URL presente). Sin esto los fetch irian contra el dev server. */
export const isApiConfigured = API_URL.trim().length > 0

export const API_MISSING_MESSAGE =
  'Falta VITE_API_URL: configura el backend en .env y reinicia la app.'

export const GITHUB_REPO = 'alejandrofm98/walactv-desktop'
