'use client' // Error boundaries must be Client Components

// Last resort when even the app frame (menu, sign-in check) cannot load. Plain styles: the app's
// stylesheet may not be available here.

export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0a0a0a', color: '#f5f5f5' }}>
        <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Could not load the app</h1>
          <p style={{ margin: 0, color: '#a3a3a3', maxWidth: 360 }}>The connection to the server dropped or is slow. You are still signed in — nothing you saved is lost.</p>
          <button type="button" onClick={() => retry()} style={{ height: 44, padding: '0 20px', borderRadius: 12, border: 0, background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Try again</button>
        </div>
      </body>
    </html>
  )
}
