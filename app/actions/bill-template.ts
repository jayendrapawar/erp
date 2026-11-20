'use server'

// Master → Bill template: details printed on sale bills. Read: 1 query; save: 1 transaction (audited).
import { db } from '@/lib/db'
import { requirePermission, requireUser } from '@/lib/authz'
import { getSetting, setSetting } from '@/lib/settings'
import { SETTING_BILL_TEMPLATE, checkBillTemplate, normalizeBillTemplate, type BillTemplate } from '@/lib/bill-template'

export async function getBillTemplate(): Promise<BillTemplate> {
  await requireUser()
  const row = await getSetting<BillTemplate>(db, SETTING_BILL_TEMPLATE)
  return normalizeBillTemplate(row?.value)
}

export async function saveBillTemplate(input: BillTemplate): Promise<BillTemplate> {
  const u = await requirePermission('settings.bill')
  const t = normalizeBillTemplate(input)
  const problems = checkBillTemplate(t)
  if (problems.length) throw new Error(problems.join(' '))
  await setSetting(db, { id: u.id, name: u.name }, SETTING_BILL_TEMPLATE, t)
  return t
}
