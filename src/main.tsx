import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { OverlayApp } from './overlay/OverlayApp'
import { loadSettings } from './settings'
import { devWarn } from './utils/logger'
import './styles/global.css'

// One-time init
loadSettings().catch(() => {
  devWarn('Failed to load settings, using defaults')
})

// Dos webviews comparten este bundle: la ventana overlay transparente
// (Windows wid nativo) carga con ?surface=overlay y renderiza solo los
// controles del player, nunca la app.
const isOverlaySurface =
  new URLSearchParams(window.location.search).get('surface') === 'overlay'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isOverlaySurface ? <OverlayApp /> : <App />}
  </React.StrictMode>,
)
