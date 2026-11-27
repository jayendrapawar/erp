/**
 * Compatibility adapter over the format-based parser in lib/qr/parser.ts.
 *
 * Older screens (billing scanner, biller verification, Feature 01 dialog) use this
 * simple shape. All parsing now happens in lib/qr/parser.ts; nothing here reads the
 * QR string itself.
 */
import { parseQr as parseFormat, type QrParseResult } from './qr/parser'
import { divisionForArticleCode } from './qr-config'

export interface ParsedQr {
  normalized: string
  articleCode: string
  colorCode: string
  size: string
  /** Hint from the article-code prefix only. Not stored; the article master decides the division. */
  division: string
  codePrefix: string
  mrp: number
  mfgMonth: number
  mfgYear: number
  /** Duplicate key for individual boxes; '' when the label has no unique id. */
  identity: string
  formatId: string
}

/** True for an individual-box label that can be counted (fully or partly understood). */
export function isValidWarehouseQr(raw: string): boolean {
  const r = parseFormat(raw)
  return r.kind === 'box' && (r.status === 'parsed' || r.status === 'partial') && Boolean(r.fields.articleCode && r.fields.size)
}

export function isCartonQr(raw: string): boolean {
  return parseFormat(raw).kind === 'carton'
}

export function divisionHint(articleCode: string): string {
  return divisionForArticleCode(articleCode)
}

export function toParsedQr(r: QrParseResult): ParsedQr {
  const articleCode = r.fields.articleCode?.value ?? ''
  return {
    normalized: r.payload,
    articleCode,
    colorCode: r.fields.colourCode?.value ?? '',
    size: r.fields.size?.value ?? '',
    division: divisionHint(articleCode),
    codePrefix: r.codePrefix ?? '',
    mrp: r.fields.mrp?.value ?? 0,
    mfgMonth: r.fields.mfgMonth?.value ?? 0,
    mfgYear: r.fields.mfgYear?.value ?? 0,
    identity: r.dedupeKey ?? '',
    formatId: r.formatId ?? '',
  }
}

export function parseQr(raw: string): ParsedQr {
  return toParsedQr(parseFormat(raw))
}

export function normalizeQr(raw: string): string {
  return parseFormat(raw).payload
}
