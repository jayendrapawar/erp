// Shown the moment a page is opened, while the server prepares it (owner: "switching pages takes time",
// 22 Nov 2026). Before this, the old page stayed on screen with no sign that anything was happening.
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="mb-6 space-y-2">
        <div className="h-7 w-48 animate-pulse rounded-lg bg-muted" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded-lg bg-muted/70" />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-xl border border-border bg-card" />)}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0">
            <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted/70" />
            <div className="ml-auto h-4 w-16 animate-pulse rounded bg-muted/70" />
          </div>
        ))}
      </div>
    </div>
  )
}
