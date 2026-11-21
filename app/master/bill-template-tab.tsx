'use client'

// Master → Bill template (admin): shop, bank, QR, terms and footer printed on sale bills, with a live
// preview of a sample bill. Loads the saved template once; Save = 1 transaction (audited).

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { getBillTemplate, saveBillTemplate } from '@/app/actions/bill-template'
import { buildInvoiceHtml, type PageSize } from '@/lib/bill-html'
import { DEFAULT_BILL_TEMPLATE, checkBillTemplate, type BillTemplate } from '@/lib/bill-template'
import { BillEmailSettings } from '@/components/master/bill-email-settings'

const SAMPLE = {
  vendor: { name: 'Sample Footwear', phone: '98250 00000', area: 'Udhna', address: 'Main Road, Surat' },
  order: { orderNumber: 'DB-0001', billedAt: new Date() },
  lines: [
    { artNumber: 'SS-101', mrp: 649, qty: 4 }, { artNumber: 'SS-101', mrp: 699, qty: 2 },
    { artNumber: 'FL-48', mrp: 299, qty: 6 }, { artNumber: 'PXL-05', mrp: 399, qty: 3 },
  ],
}

const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring'

/** Picture → small PNG data URL (QR codes stay sharp at 240 px). */
async function toQrDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url })
    const size = 240
    const c = document.createElement('canvas'); c.width = size; c.height = size
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size)
    const s = Math.min(size / img.width, size / img.height)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, (size - img.width * s) / 2, (size - img.height * s) / 2, img.width * s, img.height * s)
    return c.toDataURL('image/png')
  } finally { URL.revokeObjectURL(url) }
}

export function BillTemplateTab() {
  const [t, setT] = useState<BillTemplate | null>(null)
  const [saved, setSaved] = useState<BillTemplate | null>(null)
  const [pageSize, setPageSize] = useState<PageSize>('A4')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, start] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getBillTemplate().then((v) => { setT(v); setSaved(v); setPageSize(v.defaultPageSize) }).catch(() => setMsg({ ok: false, text: 'Could not load the bill template.' }))
  }, [])

  const preview = useMemo(() => (t ? buildInvoiceHtml({ ...SAMPLE, lineDiscPct: 30, pageSize, template: t }) : ''), [t, pageSize])
  if (!t) return <p className="py-10 text-center text-sm text-muted-foreground">{msg?.text ?? 'Loading…'}</p>

  const problems = checkBillTemplate(t)
  const dirty = JSON.stringify(t) !== JSON.stringify(saved)
  const set = <K extends keyof BillTemplate>(k: K, v: BillTemplate[K]) => setT({ ...t, [k]: v })
  const text = (k: keyof BillTemplate, label: string, ph = '') => (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <input value={String(t[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} placeholder={ph} className={`${inputCls} mt-1 text-foreground`} />
    </label>
  )
  const check = (k: 'showQr' | 'showBank' | 'showHindiName', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={t[k]} onChange={(e) => set(k, e.target.checked)} className="h-4 w-4 accent-foreground" />
      {label}
    </label>
  )

  function save() {
    setMsg(null)
    start(async () => {
      try { const v = await saveBillTemplate(t!); setT(v); setSaved(v); setMsg({ ok: true, text: 'Saved. Bills printed from now on use these details.' }) }
      catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }) }
    })
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start">
      <div className="space-y-4">
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold">Shop</h3>
          {text('tagline', 'Line above the shop name', '!! JAY SHREE SWAMINARAYAN !!')}
          {text('shopName', 'Shop name')}
          {text('address', 'Address')}
          <div className="grid grid-cols-2 gap-3">{text('gstin', 'GSTIN')}{text('phone', 'Phone')}</div>
          {text('email', 'Email (optional)')}
        </section>
        <section className="space-y-3 rounded-xl border border-border p-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Payment</h3>{check('showBank', 'Show bank details')}</div>
          <div className="grid grid-cols-2 gap-3">{text('bankName', 'Bank')}{text('accountNo', 'Account no.')}{text('ifsc', 'IFSC')}{text('branch', 'Branch')}</div>
          {text('upiId', 'UPI ID (optional)', 'name@bank')}
          <div className="flex flex-wrap items-center gap-3">
            {check('showQr', 'Show payment QR')}
            <img src={t.qrImage || undefined} alt="" className={`h-14 w-14 rounded border border-border bg-white object-contain ${t.qrImage ? '' : 'hidden'}`} />
            <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden"
              onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) set('qrImage', await toQrDataUrl(f)) }} />
            <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">Upload a new QR</button>
            {t.qrImage && <button type="button" onClick={() => set('qrImage', '')} className="text-xs underline">Use the standard QR</button>}
          </div>
        </section>
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold">Bottom of the bill</h3>
          <label className="block text-xs font-medium text-muted-foreground">
            Terms (one per line)
            <textarea rows={3} value={t.terms} onChange={(e) => set('terms', e.target.value)} className={`${inputCls} mt-1 text-foreground`} />
          </label>
          {text('footer', 'Last line', 'Thank you for your business')}
          {check('showHindiName', 'Print the retailer name in Hindi too')}
          <label className="flex items-center gap-2 text-sm">
            Default paper
            <select value={t.defaultPageSize} onChange={(e) => set('defaultPageSize', e.target.value as PageSize)} className="rounded-lg border border-border bg-background px-2 py-1 text-sm">
              <option value="A4">Big bill (A4)</option><option value="A5">Small bill (A5)</option>
            </select>
          </label>
          <p className="text-[11px] text-muted-foreground">Discount (4.75%) and GST rates are fixed for now: bills do not store their rates yet, so changing them here would change old bills when reprinted.</p>
        </section>
        {problems.length > 0 && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{problems.join(' ')}</p>}
        {msg && <p className={`rounded-lg px-3 py-2 text-xs ${msg.ok ? 'bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'}`}>{msg.text}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={save} disabled={busy || !dirty || problems.length > 0} className="flex-1 rounded-lg bg-foreground px-4 py-2.5 text-sm font-semibold text-background disabled:opacity-50">
            {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
          <button type="button" onClick={() => saved && setT(saved)} disabled={!dirty || busy} className="rounded-lg border border-border px-4 py-2.5 text-sm disabled:opacity-50">Undo changes</button>
          <button type="button" onClick={() => { if (window.confirm('Put back the standard shop details?')) setT({ ...DEFAULT_BILL_TEMPLATE }) }} className="rounded-lg border border-border px-3 py-2.5 text-xs">Standard</button>
        </div>
        <BillEmailSettings />
      </div>

      <div className="space-y-2 lg:sticky lg:top-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold">Preview (sample bill)</span>
          {(['A4', 'A5'] as PageSize[]).map((p) => (
            <button key={p} type="button" onClick={() => setPageSize(p)} className={`rounded-md border px-2 py-1 ${pageSize === p ? 'border-foreground bg-foreground text-background' : 'border-border'}`}>{p === 'A4' ? 'Big bill (A4)' : 'Small bill (A5)'}</button>
          ))}
        </div>
        <iframe title="Bill preview" srcDoc={preview} className="h-[75vh] w-full rounded-xl border border-border bg-white" />
      </div>
    </div>
  )
}
