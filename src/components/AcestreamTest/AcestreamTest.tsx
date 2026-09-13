import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { playerService } from '../../player/PlayerService'
import { checkAcestreamEngine, parseAcestreamInput } from '../../acestream/acestream'
import { ensureAcestreamEngine, getAcestreamEngineStatus, installAcestreamEngine } from '../../acestream/sidecar'
import type { CatalogItem } from '../../api/types'
import styles from './AcestreamTest.module.css'

/**
 * Panel flotante SOLO para el spike de Acestream (worktree acestream-spike).
 * Se monta cuando la URL trae ?acestream. Permite pegar un content_id,
 * enlace acestream:// o magnet y reproducirlo en libmpv via el engine local.
 * Con VITE_ACESTREAM_TEST_ID definido, reproduce ese ID automaticamente
 * (para pruebas automatizadas con captura de pantalla).
 */
const AUTO_PLAY_ID =
  (import.meta.env.VITE_ACESTREAM_TEST_ID as string | undefined)?.trim() || null

// Una sola vez por sesion de la app: al cerrar el player el panel se
// desmonta/remonta y sin esto el auto-play se redispararia en bucle.
let autoPlayedThisSession = false

function buildTestItem(raw: string): CatalogItem | null {
  const ref = parseAcestreamInput(raw)
  if (!ref) return null
  return {
    stableId: `acestream:${ref.value}`,
    title: 'Acestream (prueba)',
    subtitle: ref.value,
    description: '',
    imageUrl: '',
    kind: 'CHANNEL',
    group: 'Acestream',
    badgeText: 'TEST',
    streamOptions: [
      {
        label: 'Acestream',
        url: '',
        rawUrl: raw.trim(),
        source: 'acestream',
        acestreamId: ref.kind === 'content_id' ? ref.value : null,
        infoHash: ref.kind === 'infohash' ? ref.value : null,
      },
    ],
    genres: [],
  }
}
export function AcestreamTest() {
  const [input, setInput] = useState('')
  const [engine, setEngine] = useState<string>('Comprobando engine...')
  const [engineOk, setEngineOk] = useState(false)
  const [engineMode, setEngineMode] = useState<string>('sidecar: ...')
  const [canInstallEngine, setCanInstallEngine] = useState(false)
  const [installingEngine, setInstallingEngine] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    checkAcestreamEngine()
      .then((result) => {
        if (cancelled) return
        if (result.running) {
          setEngineOk(true)
          setEngine(`Engine OK${result.version ? ` (v${result.version})` : ''}`)
        } else {
          setEngineOk(false)
          setEngine(`Engine NO detectado: ${result.error ?? 'sin respuesta'}`)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEngineOk(false)
          setEngine('Engine NO detectado')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    refreshEngineStatus()
  }, [])

  function refreshEngineStatus() {
    getAcestreamEngineStatus()
      .then((status) => {
        setEngineMode(
          status.mode === 'managed'
            ? 'sidecar: engine gestionado por la app'
            : status.mode === 'external'
              ? 'sidecar: engine externo en uso'
              : 'sidecar: engine apagado',
        )
        setCanInstallEngine(status.mode === 'off' && status.canInstall)
      })
      .catch(() => setEngineMode('sidecar: sin estado'))
  }

  async function handleInstallEngine() {
    setInstallingEngine(true)
    setError(null)
    try {
      await installAcestreamEngine()
      // Reintenta el arranque gestionado tras instalar.
      await ensureAcestreamEngine()
      refreshEngineStatus()
      // Revalida el check HTTP del panel.
      const result = await checkAcestreamEngine()
      setEngineOk(result.running)
      setEngine(
        result.running
          ? `Engine OK${result.version ? ` (v${result.version})` : ''}`
          : `Engine NO detectado: ${result.error ?? 'sin respuesta'}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La instalacion fallo')
    } finally {
      setInstallingEngine(false)
    }
  }

  async function handlePlay() {
    const item = buildTestItem(input)
    if (!item) {
      setError('ID no valido. Pega un content_id (40 hex), un enlace acestream:// o un magnet.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      useAppStore.getState().openPlayer(item, 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar la reproduccion')
    } finally {
      setBusy(false)
    }
  }

  // Auto-play para pruebas automatizadas (VITE_ACESTREAM_TEST_ID).
  useEffect(() => {
    if (!AUTO_PLAY_ID || !engineOk || autoPlayedThisSession) return
    autoPlayedThisSession = true
    const item = buildTestItem(AUTO_PLAY_ID)
    if (!item) return
    const timer = setTimeout(() => {
      useAppStore.getState().openPlayer(item, 0)
    }, 500)
    return () => clearTimeout(timer)
  }, [engineOk])

  function handleStop() {
    playerService.unload().catch(() => {})
    useAppStore.getState().closePlayer()
  }

  if (collapsed) {
    return (
      <button className={styles.fab} onClick={() => setCollapsed(false)} title="Abrir prueba Acestream">
        Ace
      </button>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <strong>Prueba Acestream</strong>
        <button className={styles.link} onClick={() => setCollapsed(true)}>ocultar</button>
      </div>
      <p className={engineOk ? styles.ok : styles.bad}>{engine}</p>
      <p className={styles.hint}>{engineMode}</p>
      {!engineOk && canInstallEngine && (
        <button
          className={styles.primary}
          onClick={handleInstallEngine}
          disabled={installingEngine}
        >
          {installingEngine ? 'Instalando engine (~250 MB)...' : 'Instalar engine (una vez, ~250 MB)'}
        </button>
      )}
      {!engineOk && !canInstallEngine && (
        <p className={styles.hint}>
          Instala el engine (escucha en 127.0.0.1:6878): snap, AUR o instalador de
          acestream.org. Luego reabre con ?acestream.
        </p>
      )}
      <input
        className={styles.input}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="content_id, acestream://... o magnet"
        spellCheck={false}
      />
      {error && <p className={styles.bad}>{error}</p>}
      <div className={styles.row}>
        <button className={styles.primary} onClick={handlePlay} disabled={busy || !engineOk}>
          {busy ? 'Abriendo...' : 'Reproducir'}
        </button>
        <button className={styles.secondary} onClick={handleStop}>
          Detener
        </button>
      </div>
    </div>
  )
}
