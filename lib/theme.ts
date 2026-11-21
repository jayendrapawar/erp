// Light / dark theme (owner, 21 Nov 2026): dark by default, the choice is remembered per device.
// The class on <html> is set before the first paint by THEME_INIT_SCRIPT (app/layout.tsx).

export type Theme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'shayona.theme'
const THEME_COLOR: Record<Theme, string> = { dark: '#0A0F1C', light: '#F5F7FB' }

/** Inline in <head>: applies the saved theme before paint (no flash). Dark when nothing is saved. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'){var d=document.documentElement;d.classList.remove('dark');d.classList.add('light');}}catch(e){}})();`

export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.classList.contains('light') ? 'light' : 'dark'
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* private window: this visit only */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
  window.dispatchEvent(new CustomEvent('shayona:theme', { detail: theme }))
}
