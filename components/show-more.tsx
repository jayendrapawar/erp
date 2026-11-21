'use client'

// Long lists draw the first rows only, with "Show more" (owner: "the app becomes laggy", 22 Nov 2026).
// Drawing thousands of rows — twice, phone + computer layouts — made every key press in a filter slow.
// Filters still search every row; only the drawing is limited.

import { useEffect, useState, type ReactNode } from 'react'

export function useShowMore<T>(items: T[], step = 100, resetKey: unknown = null): { visible: T[]; more: ReactNode } {
  const [count, setCount] = useState(step)
  const key = JSON.stringify(resetKey)
  useEffect(() => { setCount(step) }, [key, step])
  const visible = items.length > count ? items.slice(0, count) : items
  const left = items.length - visible.length
  const more = left > 0 ? (
    <div className="flex justify-center py-4">
      <button type="button" onClick={() => setCount((c) => c + step)}
        className="h-10 rounded-xl border border-border bg-card px-5 text-sm font-semibold hover:bg-muted">
        {`Show ${Math.min(step, left)} more (${left} not shown)`}
      </button>
    </div>
  ) : null
  return { visible, more }
}
