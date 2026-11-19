'use client'

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { translations, type Language, type TranslationKey } from './translations'

interface LanguageContextValue {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

/** The choice is kept on this phone/browser only (per-device preference, no database). */
const STORAGE_KEY = 'shayona.language'

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Server render is always English; the saved choice is applied right after load.
  const [language, setLanguageState] = useState<Language>('en')

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved === 'hi' || saved === 'en') setLanguageState(saved)
    } catch { /* storage blocked (private mode): stay in English */ }
  }, [])

  useEffect(() => { document.documentElement.lang = language }, [language])

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang)
    try { window.localStorage.setItem(STORAGE_KEY, lang) } catch { /* not saved; still switches now */ }
  }, [])

  const t = useCallback(
    (key: TranslationKey): string => translations[language][key],
    [language]
  )

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider')
  return ctx
}
