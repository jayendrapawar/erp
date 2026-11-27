'use client'

import { ProfileMenu } from '@/components/profile-menu'

interface PageNavProps {
  /** Kept for callers; the Home button moved to the sidebar / bottom bar. */
  hideHome?: boolean
}

/** Top right of each screen on phones: the profile menu. Computers use the sidebar (redesign, 21 Nov 2026). */
export function PageNav(props: PageNavProps) {
  void props
  return (
    <div className="flex items-center gap-2 flex-shrink-0 md:hidden">
      <ProfileMenu />
    </div>
  )
}
