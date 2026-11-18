/**
 * Shayona QR parser — format registry.
 *
 * Design rules (see docs/qr-parser-report.md):
 *  - The raw scanner input is never modified; a normalised payload is derived from it.
 *  - Each known layout is a separate format with its own id and version.
 *  - Every field carries a confidence level: 'verified' (consistent across the whole
 *    sample corpus and cross-checked against another field or format), 'probable'
 *    (consistent across samples, not cross-checked) or 'hypothesis' (meaning guessed).
 *  - Anything that cannot be interpreted is kept in `unknown`, never dropped.
 *  - Division is NOT derived here. `codePrefix` is source information only; the
 *    approved article master decides the division.
 *
 * This module is dependency-free so it runs in the browser, on the server and in tests.
 */

export const PARSER_VERSION = '2026.11.18'

export type QrKind = 'box' | 'carton' | 'unknown'
export type ParseStatus = 'parsed' | 'partial' | 'invalid' | 'unrecognised'
export type Confidence = 'verified' | 'probable' | 'hypothesis'

export interface Field<T> {
  value: T
  raw: string
  confidence: Confidence
  note?: string
}

export interface QrFields {
  sourcePrefix?: Field<string>
  articleCode?: Field<string>
  colourCode?: Field<string>
  /** Box size, normalised without leading zeros ("0006" → "6"). */
  size?: Field<string>
  /** Carton size range, normalised ("06" → "6"). */
  sizeFrom?: Field<string>
  sizeTo?: Field<string>
  mrp?: Field<number>
  mfgMonth?: Field<number>
  mfgYear?: Field<number>
  /** Carton date, ISO yyyy-mm-dd. Meaning (packing vs manufacture) unverified. */
  cartonDate?: Field<string>
  plantCode?: Field<string>
  lineCode?: Field<string>
  packCode?: Field<string>
  ean?: Field<string>
  batchRef?: Field<string>
  labelCode?: Field<string>
  serial?: Field<string>
}

export interface QrIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
}

export interface QrParseResult {
  raw: string
  payload: string
  wrapper: 'url' | null
  kind: QrKind
  formatId: string | null
  formatVersion: number | null
  parserVersion: string
  status: ParseStatus
  fields: QrFields
  unknown: Array<{ position: string; value: string }>
  issues: QrIssue[]
  /** Leading letters of the article code (e.g. "PUG"). Informational only. */
  codePrefix: string | null
  /** True when the format carries an identifier believed unique per physical item. */
  hasUniqueId: boolean
  /** Key for duplicate detection. Same physical label ⇒ same key, whatever the wrapper or case. */
  dedupeKey: string | null
}

interface FormatDef {
  id: string
  version: number
  kind: Exclude<QrKind, 'unknown'>
  description: string
  parse(payload: string): Omit<QrParseResult, 'raw' | 'payload' | 'wrapper' | 'parserVersion' | 'codePrefix' | 'dedupeKey'> | null
}

// ── Normalisation ─────────────────────────────────────────────────────────────

export interface NormalisedInput {
  payload: string
  wrapper: 'url' | null
  issues: QrIssue[]
}

export function normaliseQrInput(raw: string): NormalisedInput {
  const issues: QrIssue[] = []
  let s = raw ?? ''
  // Strip BOM, zero-width and control characters some scanners and keyboards inject.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const cleaned = s.replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, '')
  if (cleaned !== s) issues.push(issue('control_chars_removed', 'warning', 'Invisible control characters were removed.'))
  s = cleaned.trim()

  let wrapper: 'url' | null = null
  const url = s.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i)
  if (url) {
    wrapper = 'url'
    s = url[1]
    // Phone scanners turn the payload into a host name: drop a trailing slash only.
    // Anything after a further "/" or "?" is kept so it is never silently lost.
    s = s.replace(/\/+$/, '')
  }

  if (/\s/.test(s)) {
    s = s.replace(/\s+/g, '')
    issues.push(issue('whitespace_removed', 'warning', 'Spaces inside the code were removed.'))
  }
  return { payload: s.toUpperCase(), wrapper, issues }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function issue(code: string, severity: QrIssue['severity'], message: string): QrIssue {
  return { code, severity, message }
}

function f<T>(value: T, raw: string, confidence: Confidence, note?: string): Field<T> {
  return note ? { value, raw, confidence, note } : { value, raw, confidence }
}

function stripZeros(digits: string): string {
  const n = Number.parseInt(digits, 10)
  return Number.isFinite(n) ? String(n) : digits
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10 === Number(code[12])
}

function codePrefixOf(articleCode: string | undefined): string | null {
  const m = articleCode?.match(/^[A-Z]+/)
  return m ? m[0] : null
}

const ARTICLE_CODE = /^[A-Z]{1,4}[A-Z0-9]*\d[A-Z0-9]*$/
const MRP = /^\d{1,5}\.\d{2}$/

function parseMrp(raw: string, issues: QrIssue[], confidence: Confidence): Field<number> | undefined {
  if (!MRP.test(raw)) { issues.push(issue('mrp_invalid', 'error', `MRP "${raw}" is not a price.`)); return undefined }
  const v = Number(raw)
  if (!(v > 0)) { issues.push(issue('mrp_invalid', 'error', 'MRP must be greater than zero.')); return undefined }
  return f(v, raw, confidence)
}

function parseDdMmYyyy(raw: string, issues: QrIssue[]): Field<string> | undefined {
  const m = raw.match(/^(\d{2})(\d{2})(\d{4})$/)
  if (!m) { issues.push(issue('date_invalid', 'error', `Date "${raw}" is not DDMMYYYY.`)); return undefined }
  const [, dd, mm, yyyy] = m
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)))
  if (d.getUTCFullYear() !== Number(yyyy) || d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) {
    issues.push(issue('date_invalid', 'error', `Date "${raw}" is not a real calendar date.`))
    return undefined
  }
  return f(`${yyyy}-${mm}-${dd}`, raw, 'probable', 'Carton date (DDMMYYYY). The owner labels it MFG DATE (table of 18 Nov 2026); the label itself does not say, so it stays "probable" until confirmed by Relaxo.')
}

function statusFrom(issues: QrIssue[], fallback: ParseStatus = 'parsed'): ParseStatus {
  return issues.some((i) => i.severity === 'error') ? 'invalid' : fallback
}

// ── Individual box: Relaxo "A1" family ───────────────────────────────────────
//
//   A1PUGN42G - WHWH0006 - 0726R10MA0 - 339.50 - [EAN13] - 1010 - [REF9] - [CODE5] - 1006101722
//   field 0     field 1    field 2      field 3   optional  plant  optional optional   serial
//
// Variants seen in the corpus:
//   short      7 fields: art, colour+size, mfg, mrp, plant, code5, serial        (2025–2026)
//   ean        9 fields: art, colour+size, mfg, mrp, ean, plant, ref9, code5, serial (Jul 2024, Jan 2025)
//   ean-nocode 8 fields: art, colour+size, mfg, mrp, ean, plant, ref9, serial    (Jan 2024)

interface BoxCore {
  fields: QrFields
  issues: QrIssue[]
}

function parseBoxCore(parts: string[]): BoxCore {
  const issues: QrIssue[] = []
  const fields: QrFields = {}
  const [p0, p1, p2, p3] = parts

  // field 0: "A1" + article code
  const m0 = p0.match(/^(A1)([A-Z0-9]+)$/)
  if (m0 && ARTICLE_CODE.test(m0[2])) {
    fields.sourcePrefix = f(m0[1], m0[1], 'probable', '"A1" precedes the article code on every individual-box label; its meaning is unverified.')
    fields.articleCode = f(m0[2], m0[2], 'verified', 'Matches the article code printed on the outer carton for every sample group.')
  } else {
    issues.push(issue('article_invalid', 'error', `First field "${p0}" is not "A1" followed by an article code.`))
  }

  // field 1: colour (4) + size (4 digits, zero padded)
  const m1 = p1?.match(/^([A-Z0-9]{4})(\d{4})$/)
  if (m1) {
    fields.colourCode = f(m1[1], m1[1], 'verified', 'Matches the carton colour code in every sample group.')
    const size = stripZeros(m1[2])
    if (size === '0') issues.push(issue('size_invalid', 'error', 'Size is zero.'))
    else fields.size = f(size, m1[2], 'verified', 'Inside the carton size range in every sample group.')
  } else {
    issues.push(issue('colour_size_invalid', 'error', `Second field "${p1 ?? ''}" is not a 4-character colour code followed by a 4-digit size.`))
  }

  // field 2: MMYY + R + plant(2) + line(3)
  const m2 = p2?.match(/^(\d{2})(\d{2})(R\d{2})([A-Z0-9]{3})$/)
  if (m2) {
    const month = Number(m2[1])
    if (month < 1 || month > 12) issues.push(issue('mfg_month_invalid', 'error', `Month "${m2[1]}" is not 01–12.`))
    else {
      fields.mfgMonth = f(month, m2[1], 'probable', 'Read as manufacturing month (MMYY). Consistent with carton dates in 5 of 7 sample groups.')
      fields.mfgYear = f(2000 + Number(m2[2]), m2[2], 'probable')
    }
    fields.plantCode = f(m2[3], m2[3], 'hypothesis', 'R + 2 digits; always equals the last two digits of the 4-digit code later in the label. Possibly a plant or unit code.')
    fields.lineCode = f(m2[4], m2[4], 'hypothesis', 'MA0 / MA1 / MA2 seen. Meaning unknown.')
  } else {
    issues.push(issue('mfg_invalid', 'error', `Third field "${p2 ?? ''}" is not MMYY + R + 2 digits + 3 characters.`))
  }

  if (p3 !== undefined) {
    const mrp = parseMrp(p3, issues, 'verified')
    if (mrp) fields.mrp = mrp
  } else {
    issues.push(issue('mrp_missing', 'error', 'MRP field is missing.'))
  }
  return { fields, issues }
}

function checkPlantPair(fields: QrFields, plant4: string, issues: QrIssue[]) {
  const short = fields.plantCode?.value
  if (short && plant4.slice(2) !== short.slice(1)) {
    issues.push(issue('plant_mismatch', 'warning', `Code "${plant4}" does not end with ${short.slice(1)} as in every sample.`))
  }
}

function boxFormat(id: string, version: number, description: string, layout: Array<'ean' | 'plant' | 'ref9' | 'code5' | 'serial'>): FormatDef {
  return {
    id, version, kind: 'box', description,
    parse(payload) {
      if (!payload.startsWith('A1')) return null
      const parts = payload.split('-')
      if (parts.length !== 4 + layout.length) return null
      // Shape check before committing to this format, so a different variant can claim it.
      const tail = parts.slice(4)
      const shape: Record<string, RegExp> = { ean: /^\d{13}$/, plant: /^\d{4}$/, ref9: /^\d{9}$/, code5: /^[A-Z0-9]{5}$/, serial: /^\d{9,11}$/ }
      if (!layout.every((kind, i) => shape[kind].test(tail[i]))) return null

      const { fields, issues } = parseBoxCore(parts)
      layout.forEach((kind, i) => {
        const v = tail[i]
        if (kind === 'ean') {
          fields.ean = f(v, v, isValidEan13(v) ? 'verified' : 'hypothesis', isValidEan13(v) ? 'Valid EAN-13 check digit (GS1 India prefix 890).' : 'Looks like EAN-13 but the check digit does not match.')
          if (!isValidEan13(v)) issues.push(issue('ean_checksum', 'warning', `EAN "${v}" has an invalid check digit.`))
        } else if (kind === 'plant') {
          fields.plantCode = f(v, v, 'hypothesis', `4-digit code; its last two digits always repeat the R-code (${fields.plantCode?.value ?? '?'}). Also appears on compact carton labels.`)
          // Keep the R-code too; it is not lost, it moves to unknown-with-meaning.
          checkPlantPair({ plantCode: f(parts[2]?.slice(4, 7) ?? '', '', 'hypothesis') }, v, issues)
        } else if (kind === 'ref9') {
          fields.batchRef = f(v, v, 'hypothesis', '9-digit number present only on EAN-bearing labels. Meaning unknown.')
        } else if (kind === 'code5') {
          fields.labelCode = f(v, v, 'probable', '5-character code, different on every box. Likely a label verification code.')
        } else {
          fields.serial = f(v, v, 'probable', '10-digit number, different on every box and rising over time across all divisions. Believed to be a label serial.')
        }
      })
      // The R-code was overwritten by the 4-digit code above; record it explicitly.
      const rCode = parts[2]?.match(/^\d{4}(R\d{2})/)?.[1]
      const unknown = rCode ? [{ position: 'field 2 (R-code)', value: rCode }] : []
      return { kind: 'box', formatId: id, formatVersion: version, status: statusFrom(issues), fields, unknown, issues, hasUniqueId: !issues.some((i) => i.severity === 'error') && Boolean(fields.serial) }
    },
  }
}

// ── Legacy 4-field box label (found only in development test data) ──────────
//   SX0991G-BKRD08-1026-599
const legacyBox: FormatDef = {
  id: 'legacy.box.4field',
  version: 1,
  kind: 'box',
  description: 'ART-COLOURSIZE-MMYY-MRP with no unique identifier. Seen only in development test scans.',
  parse(payload) {
    const parts = payload.split('-')
    if (parts.length !== 4 || payload.startsWith('A1')) return null
    const [p0, p1, p2, p3] = parts
    if (!ARTICLE_CODE.test(p0) || !/^[A-Z0-9]{4}\d{1,2}$/.test(p1) || !/^\d{4}$/.test(p2) || !/^\d+(\.\d{1,2})?$/.test(p3)) return null
    const issues: QrIssue[] = [issue('no_unique_id', 'warning', 'This label has no unique box identifier; duplicates cannot be detected from the QR alone.')]
    const fields: QrFields = {
      articleCode: f(p0, p0, 'probable'),
      colourCode: f(p1.slice(0, 4), p1.slice(0, 4), 'probable'),
      size: f(stripZeros(p1.slice(4)), p1.slice(4), 'probable'),
    }
    const month = Number(p2.slice(0, 2))
    if (month >= 1 && month <= 12) {
      fields.mfgMonth = f(month, p2.slice(0, 2), 'hypothesis')
      fields.mfgYear = f(2000 + Number(p2.slice(2)), p2.slice(2), 'hypothesis')
    } else issues.push(issue('mfg_month_invalid', 'error', `Month "${p2.slice(0, 2)}" is not 01–12.`))
    const mrp = Number(p3)
    if (mrp > 0) fields.mrp = f(mrp, p3, 'probable')
    else issues.push(issue('mrp_invalid', 'error', 'MRP must be greater than zero.'))
    return { kind: 'box', formatId: this.id, formatVersion: this.version, status: statusFrom(issues, 'partial'), fields, unknown: [], issues, hasUniqueId: false }
  },
}

// ── Outer carton: compact (no separators) ────────────────────────────────────
//   SS0703G BKRD 06 10 A 649.00 03102026 1005 1018424593
//   art(7)  col  from to pack mrp  date  plant serial
const cartonCompact: FormatDef = {
  id: 'relaxo.carton.compact',
  version: 1,
  kind: 'carton',
  description: 'Outer carton, no separators: article(7) colour(4) size-from(2) size-to(2) pack letter, MRP, DDMMYYYY, 4-digit code, serial.',
  parse(payload) {
    const m = payload.match(/^([A-Z0-9]{7})([A-Z0-9]{4})(\d{2})(\d{2})([A-Z])(\d{1,5}\.\d{2})(\d{8})(\d{4})(\d{8,12})$/)
    if (!m) return null
    const [, art, col, from, to, pack, mrp, date, plant, serial] = m
    if (!ARTICLE_CODE.test(art)) return null
    return buildCarton(this, { art, col, from, to, mrp, date, serial, artNote: 'Assumes a 7-character article code (true for every compact sample). Longer codes would shift the colour code; check against the article master.' }, (fields) => {
      fields.packCode = f(pack, pack, 'hypothesis', 'Single letter after the size range; "A" in every sample. Possibly an assortment or pack type. Must be confirmed before it is used to pick an assortment.')
      fields.plantCode = f(plant, plant, 'probable', 'Equals the 4-digit code on the matching individual boxes in all 4 compact sample groups.')
    })
  },
}

// ── Outer carton: hyphen after the article code ──────────────────────────────
//   FL0020L - BKBK 04 05 239.50 24072026 10030 0985036150
//   art       col  from to mrp  date     code5 serial
const cartonHyphen: FormatDef = {
  id: 'relaxo.carton.hyphen',
  version: 1,
  kind: 'carton',
  description: 'Outer carton with "-" after the article code: colour(4) size-from(2) size-to(2), MRP, DDMMYYYY, 5-character code, serial.',
  parse(payload) {
    const m = payload.match(/^([A-Z0-9]+)-([A-Z0-9]{4})(\d{2})(\d{2})(\d{1,5}\.\d{2})(\d{8})([A-Z0-9]{5})(\d{8,12})$/)
    if (!m) return null
    const [, art, col, from, to, mrp, date, code, serial] = m
    if (!ARTICLE_CODE.test(art)) return null
    return buildCarton(this, { art, col, from, to, mrp, date, serial }, (fields) => {
      fields.labelCode = f(code, code, 'hypothesis', '5 characters between the date and the serial. Numeric on some labels (10030, 10010), alphanumeric on others (1SQ7T, 3736J). The split between this code and the serial is uncertain.')
    })
  },
}

function buildCarton(
  def: FormatDef,
  p: { art: string; col: string; from: string; to: string; mrp: string; date: string; serial: string; artNote?: string },
  extra: (fields: QrFields) => void,
) {
  const issues: QrIssue[] = []
  const fields: QrFields = {
    articleCode: f(p.art, p.art, p.artNote ? 'probable' : 'verified', p.artNote ?? 'Matches the individual-box article code in every sample group.'),
    colourCode: f(p.col, p.col, 'verified', 'Matches the individual-box colour code in every sample group.'),
  }
  const from = Number(p.from), to = Number(p.to)
  // Children's ranges wrap from 11–13 back to 1 (11–1 = 11, 12, 13, 1), as in the article master.
  const wraps = from >= 11 && from <= 13 && to >= 1 && to < from
  // "00" + size = a single-size carton (bills list e.g. SF0192G-GFSL0007 = size 7 only).
  const single = from === 0 && to > 0
  if (!to || (!from && !single) || (from > to && !wraps)) issues.push(issue('size_range_invalid', 'error', `Size range ${p.from}–${p.to} is not valid.`))
  else {
    fields.sizeFrom = f(String(single ? to : from), p.from, single ? 'probable' : 'verified', single ? 'Single-size carton ("00" + size), as on Relaxo bills.' : 'Every matching box size falls inside this range.')
    fields.sizeTo = f(String(to), p.to, 'verified')
  }
  const mrp = parseMrp(p.mrp, issues, 'verified')
  if (mrp) fields.mrp = mrp
  const date = parseDdMmYyyy(p.date, issues)
  if (date) fields.cartonDate = date
  fields.serial = f(p.serial, p.serial, 'hypothesis', 'Trailing number, different on every carton sample. Not linked to the serials of the boxes inside.')
  if (p.serial.length !== 10) issues.push(issue('serial_length', 'warning', `Serial has ${p.serial.length} digits; most samples have 10.`))
  extra(fields)
  return { kind: 'carton' as const, formatId: def.id, formatVersion: def.version, status: statusFrom(issues), fields, unknown: [], issues, hasUniqueId: !issues.some((i) => i.severity === 'error') }
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const QR_FORMATS: readonly FormatDef[] = [
  boxFormat('relaxo.box.a1.short', 1, 'Individual box, 7 fields: A1+article, colour+size, MMYY+R-code+line, MRP, 4-digit code, 5-char code, serial.', ['plant', 'code5', 'serial']),
  boxFormat('relaxo.box.a1.ean', 1, 'Individual box, 9 fields: adds EAN-13 after MRP and a 9-digit reference after the 4-digit code.', ['ean', 'plant', 'ref9', 'code5', 'serial']),
  boxFormat('relaxo.box.a1.ean-nocode', 1, 'Individual box, 8 fields: as the EAN layout but without the 5-character code.', ['ean', 'plant', 'ref9', 'serial']),
  cartonCompact,
  cartonHyphen,
  legacyBox,
]

/** Best-effort read of an "A1" box label whose tail does not match a known variant. */
function partialA1(payload: string): ReturnType<FormatDef['parse']> {
  if (!payload.startsWith('A1')) return null
  const parts = payload.split('-')
  if (parts.length < 4) return null
  const { fields, issues } = parseBoxCore(parts)
  if (!fields.articleCode) return null
  issues.push(issue('unknown_variant', 'warning', `Box label with ${parts.length} fields does not match a known layout. Known fields were read; the rest is kept for review.`))
  const unknown = parts.slice(4).map((value, i) => ({ position: `field ${i + 4}`, value }))
  return { kind: 'box', formatId: 'relaxo.box.a1.unknown-variant', formatVersion: 0, status: issues.some((i) => i.severity === 'error') ? 'invalid' : 'partial', fields, unknown, issues, hasUniqueId: false }
}

export function parseQr(raw: string): QrParseResult {
  const norm = normaliseQrInput(raw)
  const base = { raw, payload: norm.payload, wrapper: norm.wrapper, parserVersion: PARSER_VERSION }

  if (!norm.payload) {
    return { ...base, kind: 'unknown', formatId: null, formatVersion: null, status: 'invalid', fields: {}, unknown: [], issues: [...norm.issues, issue('empty', 'error', 'Nothing was scanned.')], codePrefix: null, hasUniqueId: false, dedupeKey: null }
  }

  for (const def of QR_FORMATS) {
    const r = def.parse(norm.payload)
    if (r) return finish(base, norm, r)
  }
  const partial = partialA1(norm.payload)
  if (partial) return finish(base, norm, partial)

  return {
    ...base, kind: 'unknown', formatId: null, formatVersion: null, status: 'unrecognised', fields: {},
    unknown: [{ position: 'payload', value: norm.payload }],
    issues: [...norm.issues, issue('unrecognised', 'error', 'This QR does not match any known box or carton label.')],
    codePrefix: null, hasUniqueId: false, dedupeKey: null,
  }
}

function finish(
  base: Pick<QrParseResult, 'raw' | 'payload' | 'wrapper' | 'parserVersion'>,
  norm: NormalisedInput,
  r: NonNullable<ReturnType<FormatDef['parse']>>,
): QrParseResult {
  const ok = r.status !== 'invalid'
  return {
    ...base,
    ...r,
    issues: [...norm.issues, ...r.issues],
    codePrefix: codePrefixOf(r.fields.articleCode?.value),
    // The whole normalised payload is the key: the same label always normalises the same way,
    // and the key does not depend on which field we believe is the serial.
    dedupeKey: ok && r.hasUniqueId ? `${r.kind}:${base.payload}` : null,
  }
}

/** Flattened values for storage and display. */
export function flattenFields(fields: QrFields): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(fields)) if (v) out[k] = (v as Field<string | number>).value
  return out
}
