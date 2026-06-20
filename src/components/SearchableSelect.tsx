import { useState, useRef, useEffect, useMemo } from 'react'
import styles from './SearchableSelect.module.css'

type Option = { value: string; label: string }

interface Props {
  label: string
  options: (string | Option)[]
  value?: string
  onChange: (v: string | undefined) => void
}

function toOption(o: string | Option): Option {
  return typeof o === 'string' ? { value: o, label: o } : o
}

export function SearchableSelect({ label, options, value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const normOptions = useMemo(() => options.map(toOption), [options])

  const displayLabel = normOptions.find((o) => o.value === value)?.label ?? label

  const filtered = useMemo(() => {
    if (!query.trim()) return normOptions
    const q = query.toLowerCase()
    return normOptions.filter((o) => o.label.toLowerCase().includes(q))
  }, [normOptions, query])

  const showTodos = !query.trim()

  const maxIndex = showTodos ? filtered.length : Math.max(0, filtered.length - 1)

  // Reset highlight when the filtered list changes or dropdown opens
  useEffect(() => {
    setHighlightedIndex(0)
  }, [filtered, open])

  // Scroll highlighted option into view
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlightedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex, open])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  function handleOpen() {
    setOpen(true)
    setQuery('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function handleSelect(v: string | undefined) {
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); setQuery('') }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((prev) => Math.min(prev + 1, maxIndex))
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((prev) => Math.max(prev - 1, 0))
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (showTodos && highlightedIndex === 0) {
        handleSelect(undefined)
      } else {
        const offset = showTodos ? 1 : 0
        const option = filtered[highlightedIndex - offset]
        if (option) handleSelect(option.value)
      }
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        onClick={handleOpen}
        className={`${styles.trigger} ${value ? styles.triggerActive : ''}`}
      >
        <span className={styles.triggerLabel}>{displayLabel}</span>
        <span className={styles.triggerArrow}>▼</span>
      </button>
      {open && (
        <div className={styles.dropdown}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Buscar..."
            className={styles.searchInput}
          />
          <div className={styles.optionsList} ref={listRef}>
            {showTodos && (
              <div
                data-index={0}
                onClick={() => handleSelect(undefined)}
                className={`${styles.option} ${highlightedIndex === 0 ? styles.optionHighlighted : ''} ${!value ? styles.optionSelected : ''}`}
              >
                Todos
              </div>
            )}
            {filtered.length === 0 ? (
              <div className={`${styles.option} ${styles.optionMuted}`}>Sin resultados</div>
            ) : (
              filtered.map((o, i) => {
                const idx = showTodos ? i + 1 : i
                return (
                  <div
                    key={o.value}
                    data-index={idx}
                    onClick={() => handleSelect(o.value)}
                    className={`${styles.option} ${highlightedIndex === idx ? styles.optionHighlighted : ''} ${o.value === value ? styles.optionSelected : ''}`}
                  >
                    {o.label}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
