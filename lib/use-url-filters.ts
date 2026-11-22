'use client'

// A list opened from Ctrl+K "# " search arrives with its filter in the address
// (/master?f.name=Patel#vendors). This puts "f.<column>" values into the list's column filters once,
// then removes them from the address so a reload or a later filter change is not overridden.
// No server request.

import { useEffect, useLayoutEffect, useRef } from 'react'

export const URL_FILTERS_EVENT = 'shayona:url-filters'

export function readUrlFilters(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  new URLSearchParams(search).forEach((v, k) => { if (k.startsWith('f.') && v.trim()) out[k.slice(2)] = v })
  return out
}

/** keys: the list's column filter keys this list accepts (others are left for another list). */
export function useUrlFilters(keys: readonly string[], apply: (values: Record<string, string>) => void) {
  const applyRef = useRef(apply)
  useLayoutEffect(() => { applyRef.current = apply })
  const keyText = keys.join(',')
  useEffect(() => {
    const read = () => {
      const all = readUrlFilters(window.location.search)
      const mine = Object.fromEntries(Object.entries(all).filter(([k]) => keyText.split(',').includes(k)))
      if (!Object.keys(mine).length) return
      applyRef.current(mine)
      const url = new URL(window.location.href)
      for (const k of Object.keys(mine)) url.searchParams.delete(`f.${k}`)
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
    read()
    window.addEventListener(URL_FILTERS_EVENT, read)
    window.addEventListener('popstate', read)
    return () => { window.removeEventListener(URL_FILTERS_EVENT, read); window.removeEventListener('popstate', read) }
  }, [keyText])
}
