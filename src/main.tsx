import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { loadSettings } from './settings'
import { devWarn } from './utils/logger'
import './styles/global.css'

// One-time init
loadSettings().catch(() => {
  devWarn('Failed to load settings, using defaults')
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
