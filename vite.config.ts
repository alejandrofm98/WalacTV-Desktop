import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiUrl = env.VITE_API_URL || ''

  const proxy = apiUrl
    ? {
        '/api': {
          target: apiUrl,
          changeOrigin: true,
          secure: true,
        },
      }
    : undefined

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: false,
      proxy,
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
      target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
      minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
      sourcemap: !!process.env.TAURI_DEBUG,
    },
  }
})
