'use client'

import Link from 'next/link'
import { ProfileMenu } from '@/components/profile-menu'

interface PageNavProps {
  /** Hide the Home button on the /home page itself */
  hideHome?: boolean
}

/** Top right of each screen: "← Home" (computer only; phones use the bottom bar) and the profile menu. */
export function PageNav({ hideHome }: PageNavProps) {
  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      {!hideHome && (
        <Link
          href="/home"
          className="hidden md:inline-flex items-center rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
        >
          <span aria-hidden>←</span>
          <span className="ml-1">Home</span>
        </Link>
      )}
      <ProfileMenu />
    </div>
  )
}
