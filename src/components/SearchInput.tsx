import styles from './SearchInput.module.css'

interface SearchInputProps {
  placeholder: string
  value: string
  onChange: (value: string) => void
}

export function SearchInput({ placeholder, value, onChange }: SearchInputProps) {
  return (
    <div className={styles.searchBox}>
      <svg className={styles.searchIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        className={styles.searchInput}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button className={styles.searchClear} onClick={() => onChange('')} aria-label="Limpiar busqueda">
          ✕
        </button>
      )}
    </div>
  )
}
