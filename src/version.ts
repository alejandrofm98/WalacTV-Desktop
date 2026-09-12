// Version inyectada en build desde package.json (vite.config.ts define
// __APP_VERSION__). No hardcodear: se sincroniza sola con tauri.conf.json.
declare const __APP_VERSION__: string | undefined

const injected = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined

export const APP_VERSION: string = injected ?? '0.0.0-dev'
