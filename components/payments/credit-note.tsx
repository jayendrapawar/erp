'use client'

// The party's balance / credit hold, shown when a party is chosen on the order form and on Direct
// bill (payments steps 7–9). A held party (unpaid past its credit days) cannot get a new order or
// Direct bill; an admin can tick "Allow" (audited on the server).

import { useEffect, useState } from 'react'
import { getCreditStatus } from '@/app/actions/payments'
import { formatRs } from '@/lib/billing/bill-amounts'

export type CreditInfo = NonNullable<Awaited<ReturnType<typeof getCreditStatus>>>

/** Credit status of the chosen party (1 query when the party changes). */
export function useCreditStatus(party: { retailerId?: string; name?: string } | null): CreditInfo | null {
  const [info, setInfo] = useState<CreditInfo | null>(null)
  const key = party ? `${party.retailerId ?? ''}|${party.name ?? ''}` : ''
  useEffect(() => {
    setInfo(null)
    if (!key) return
    let live = true
    const [retailerId, name] = key.split('|')
    getCreditStatus({ retailerId: retailerId || undefined, name: name || undefined })
      .then((s) => { if (live) setInfo(s) }).catch(() => { /* the save still checks on the server */ })
    return () => { live = false }
  }, [key])
  return info
}

/** True for the server's credit-hold refusal. */
export const isCreditHold = (e: unknown) => e instanceof Error && /^Credit hold:/.test(e.message)

export function CreditNote({ info, allow, onAllow, compact }: { info: CreditInfo | null; allow?: boolean; onAllow?: (v: boolean) => void; compact?: boolean }) {
  if (!info) return null
  const o = info.overdue[0]
  if (info.blocked) {
    return (
      <div role="alert" className={`rounded-xl border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200 ${compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'}`}>
        <p><b>Credit hold.</b>{` ${formatRs(info.overduePaise)} unpaid for more than ${info.creditDays} days`}{o ? ` (oldest ${o.refNo || o.kind}, ${o.days} days)` : ''}{`. Balance ${formatRs(info.balancePaise)}.`}</p>
        {info.canOverride && onAllow ? (
          <label className="mt-1 flex items-center gap-2 font-medium">
            <input type="checkbox" checked={!!allow} onChange={(e) => onAllow(e.target.checked)} /> Allow anyway (admin)
          </label>
        ) : <p className="mt-0.5 text-xs">Record the payment first, or ask an admin.</p>}
      </div>
    )
  }
  if (info.balancePaise === 0 && !info.overLimit) return null
  return (
    <p className={`rounded-xl px-3 py-1.5 ${compact ? 'text-xs' : 'text-sm'} ${info.overLimit ? 'bg-amber-500/10 text-amber-900 dark:text-amber-200' : 'bg-muted/50 text-muted-foreground'}`}>
      {info.balancePaise < 0 ? `Advance held ${formatRs(-info.balancePaise)}` : `Balance ${formatRs(info.balancePaise)}`}
      {info.overLimit && info.creditLimitPaise != null && ` — over the credit limit of ${formatRs(info.creditLimitPaise)}`}
    </p>
  )
}
