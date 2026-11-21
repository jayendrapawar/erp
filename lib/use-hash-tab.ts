'use client'

// A page's tab kept in the address hash (/inventory#stock), so the sidebar's sub-items can open it
// and a reload stays on the same tab (redesign, owner 21 Nov 2026). No server request.

import { useCallback, useEffect, useState } from 'react'

export function useHashTab(ids: readonly string[], fallback: string): [string, (tab: string) => void] {
  const [tab, setTabState] = useState(fallback)
  const key = ids.join(',')
  useEffect(() => {
    const read = () => {
      const h = window.location.hash.replace('#', '')
      if (key.split(',').includes(h)) setTabState(h)
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [key])
  const setTab = useCallback((t: string) => {
    setTabState(t)
    window.history.replaceState(null, '', `#${t}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }, [])
  return [tab, setTab]
}
