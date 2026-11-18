'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'

/** Local testing only (see lib/dev-login.ts). Never rendered in a production build. */
export function DevPasswordSignIn({ roles }: { roles: readonly string[] }) {
  const [email, setEmail] = useState(`${roles[0]}@test.shayona.local`)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const r = await authClient.signIn.email({ email, password, callbackURL: '/' })
    if (r.error) { setError(r.error.message ?? 'Sign in failed'); setBusy(false); return }
    router.replace('/')
  }

  const box = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, marginTop: 6, background: 'transparent', color: 'inherit' } as const
  return (
    <form onSubmit={submit} style={{ marginTop: 20, paddingTop: 16, borderTop: '1px dashed #d1d5db', textAlign: 'left' }}>
      <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: '#b45309' }}>Test sign-in — this computer only</p>
      <label style={{ display: 'block', fontSize: 12, marginTop: 8, color: '#6b7280' }}>
        Test account
        <select value={email} onChange={(e) => setEmail(e.target.value)} style={box} aria-label="Test account">
          {roles.map((r) => <option key={r} value={`${r}@test.shayona.local`}>{r}</option>)}
        </select>
      </label>
      <label style={{ display: 'block', fontSize: 12, marginTop: 8, color: '#6b7280' }}>
        Password (DEV_TEST_PASSWORD in .env.local)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={box} autoComplete="current-password" />
      </label>
      {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: '#dc2626' }}>{error}</p>}
      <button type="submit" disabled={busy || !password} style={{ ...box, marginTop: 12, cursor: 'pointer', fontWeight: 600, background: '#111827', color: '#fff', border: 'none', opacity: busy || !password ? 0.6 : 1 }}>
        {busy ? 'Signing in…' : 'Sign in as test user'}
      </button>
    </form>
  )
}
