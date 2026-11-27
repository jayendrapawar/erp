// Reading a box label (pure: safe on the server and in the browser). Moved out of bill-stock.ts so the
// Edit bill screen checks a scan on the spot with exactly the server's rules.

import { parseQr } from '@/lib/qr/parser'
import { normalizeArticleValue } from '@/lib/article-utils'

export interface BoxLabel {
  raw: string
  dedupeKey: string
  /** True when the label carries its own unique id (can be matched to a stock scan). */
  unique: boolean
  articleCode: string
  colourCode: string
  sizeLabel: string
  mrp: number | null
}

export function readBoxLabel(rawInput: string): { ok: true; box: BoxLabel } | { ok: false; message: string } {
  const raw = String(rawInput ?? '').trim()
  if (!raw || raw.length > 500) return { ok: false, message: 'Empty or too long QR text.' }
  const p = parseQr(raw)
  if (p.kind === 'carton') return { ok: false, message: 'This is an outer-carton label. Scan the boxes inside.' }
  if (p.status === 'unrecognised' || p.status === 'invalid') {
    return { ok: false, message: p.issues.find((i) => i.severity === 'error')?.message ?? 'QR code not recognised.' }
  }
  const articleCode = normalizeArticleValue(p.fields.articleCode?.value ?? '')
  if (!articleCode) return { ok: false, message: 'The label has no article code.' }
  return {
    ok: true,
    box: {
      raw,
      dedupeKey: p.dedupeKey ?? `raw:${p.payload}`,
      unique: Boolean(p.dedupeKey),
      articleCode,
      colourCode: normalizeArticleValue(p.fields.colourCode?.value ?? ''),
      sizeLabel: p.fields.size?.value != null ? String(p.fields.size.value) : '',
      mrp: p.fields.mrp ? Number(p.fields.mrp.value.toFixed(2)) : null,
    },
  }
}
