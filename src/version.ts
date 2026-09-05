// Version inyectada en build desde package.json (vite.config.ts define
// __APP_VERSION__). No hardcodear: se sincroniza sola con tauri.conf.json.
declare const __APP_VERSION__: string

export const APP_VERSION: string = __APP_VERSION__
