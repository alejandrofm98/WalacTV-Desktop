import { useState, useEffect } from 'react'
import styles from './LoginScreen.module.css'

interface Props {
  onLogin: (u: string, p: string) => Promise<void>
}

export function LoginScreen({ onLogin }: Props) {
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!user.trim() || !pass.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onLogin(user, pass)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    document.querySelector<HTMLInputElement>('#login-user')?.focus()
  }, [])

  return (
    <div className={styles.container}>
      <form onSubmit={submit} className={styles.form}>
        <div className={styles.formHeader}>
          <div className={styles.logoRow}>
            <img src="/logo.png" alt="WalacTV" className={styles.logoMark} width={36} height={19} />
          </div>
          <h1 className={styles.title}>Iniciar sesion</h1>
          <p className={styles.subtitle}>Ingresa tu usuario y contrasena para continuar.</p>
        </div>

        <Field id="login-user" label="Usuario" value={user} onChange={setUser} />
        <Field id="login-pass" label="Contrasena" value={pass} onChange={setPass} hidden />

        {error && <p className={styles.error}>{error}</p>}

        <button
          type="submit"
          disabled={busy || !user.trim() || !pass.trim()}
          className={styles.submitBtn}
        >
          {busy ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

function Field({ id, label, value, onChange, hidden }: {
  id: string; label: string; value: string; onChange: (v: string) => void; hidden?: boolean
}) {
  return (
    <div>
      <label htmlFor={id} className={styles.fieldLabel}>{label}</label>
      <input
        id={id}
        type={hidden ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={styles.fieldInput}
        autoComplete={hidden ? 'current-password' : 'username'}
      />
    </div>
  )
}
