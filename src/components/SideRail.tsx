import { useRef, useEffect } from 'react'
import type { MainMode } from '../api/types'
import styles from './SideRail.module.css'

/* ── SVG icons (Lucide paths, MIT license) ─────────────────── */
function IconSearch() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}
function IconHome() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}
function IconTV() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="15" rx="2" />
      <polyline points="17 2 12 7 7 2" />
    </svg>
  )
}
function IconStar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}
function IconCompass() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}
function IconSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

interface RailItem {
  icon: React.ReactNode
  label: string
  mode?: MainMode
}

const items: RailItem[] = [
  { icon: <IconSearch />,  label: 'Buscar',    mode: 'Search' },
  { icon: <IconHome />,    label: 'Inicio',    mode: 'Home' },
  { icon: <IconTV />,      label: 'TV',        mode: 'TV' },
  { icon: <IconStar />,    label: 'Eventos',   mode: 'Events' },
  { icon: <IconCompass />, label: 'Descubrir', mode: 'Discover' },
]

interface Props {
  mode: MainMode
  onModeChange: (m: MainMode) => void
  expanded: boolean
  onSetExpanded: (e: boolean) => void
}

export function SideRail({ mode, onModeChange, expanded, onSetExpanded }: Props) {
  const navRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    function onFocusIn() {
      if (!expanded) onSetExpanded(true)
    }
    function onFocusOut(e: FocusEvent) {
      if (expanded && !nav!.contains(e.relatedTarget as Node)) {
        onSetExpanded(false)
      }
    }
    nav.addEventListener('focusin', onFocusIn)
    nav.addEventListener('focusout', onFocusOut)
    return () => {
      nav.removeEventListener('focusin', onFocusIn)
      nav.removeEventListener('focusout', onFocusOut)
    }
  }, [expanded, onSetExpanded])

  return (
    <nav
      className={`${styles.rail} ${expanded ? styles.railExpanded : styles.railCollapsed}`}
      onMouseEnter={() => onSetExpanded(true)}
      onMouseLeave={() => onSetExpanded(false)}
    >
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.logoMark}>W</div>
        <span className={`${styles.brand} ${expanded ? '' : styles.hiddenText}`}>WalacTV</span>
      </div>

      {/* Nav items */}
      <div className={styles.nav} ref={navRef}>
        {items.map((item) => {
          const selected = item.mode === mode
          return (
            <button
              key={item.label}
              onClick={() => item.mode && onModeChange(item.mode)}
              className={`${styles.navBtn} ${selected ? styles.navBtnSelected : ''} ${expanded ? styles.navBtnExpanded : ''}`}
              title={!expanded ? item.label : undefined}
            >
              {selected && <span className={styles.activeBar} />}
              <span className={styles.icon}>{item.icon}</span>
              <span className={`${styles.label} ${expanded ? '' : styles.hiddenText}`}>{item.label}</span>
            </button>
          )
        })}
      </div>

      {/* Separator */}
      <div className={styles.separator} />

      {/* Settings */}
      <div className={styles.footer}>
        <button
          onClick={() => onModeChange('Settings')}
          className={`${styles.navBtn} ${mode === 'Settings' ? styles.navBtnSelected : ''} ${expanded ? styles.navBtnExpanded : ''}`}
          title={!expanded ? 'Ajustes' : undefined}
        >
          {mode === 'Settings' && <span className={styles.activeBar} />}
          <span className={styles.icon}><IconSettings /></span>
          <span className={`${styles.label} ${expanded ? '' : styles.hiddenText}`}>Ajustes</span>
        </button>
      </div>
    </nav>
  )
}
