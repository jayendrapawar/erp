'use client'

import { createContext, useContext } from 'react'

/** Signed-in user's display details, loaded once by the root layout (no extra query per page). */
export interface SessionUserInfo { name: string; roleLabel: string }

const SessionUserContext = createContext<SessionUserInfo | null>(null)

export function SessionUserProvider({ user, children }: { user: SessionUserInfo | null; children: React.ReactNode }) {
  return <SessionUserContext.Provider value={user}>{children}</SessionUserContext.Provider>
}

export function useSessionUser(): SessionUserInfo | null {
  return useContext(SessionUserContext)
}
