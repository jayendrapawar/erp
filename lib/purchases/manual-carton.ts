// Manual carton entry at receiving (owner, 20 Nov 2026): the outer carton label is damaged or will
// not scan. The receiver scans ONE pair box from the carton (article, colour, size, MRP, mfg date),
// chooses the carton's size range from the open proforma invoice lines for that article + colour,
// and the carton is received against that line exactly like a scanned carton:
//   • pairs per carton ALWAYS come from the proforma invoice line (never typed);
//   • contents by size come from the line's carton assortment; when the master has none, the
//     receiver types pairs per size (must add up to the invoice's pairs per carton) and it is saved
//     to Master → Assortments for the next carton (division + segment + pairs/carton + size range);
//   • the box's label is the receipt's key, so the same box cannot receive two cartons.
// Database work: options = 2 reads in parallel + 1 for the assortment choices; receive = 1
// transaction (~10–16 statements). Assortment choice follows assortment-match.ts; the receiver
// confirms it by pressing Receive (owner, 22 Nov 2026).

import { sql } from 'drizzle-orm'
import type { AssortmentSize } from '@/lib/db/schema'
import type { Actor, Db, DbOrTx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { parseQr } from '@/lib/qr/parser'
import { normalizeArticleValue } from '@/lib/article-utils'
import { expandSizeRange } from '@/lib/catalog/sizes'
import { lineChoices } from './assortment-match'
import { NeedsAssortment, settleLineAssortment } from './assortment-entry'
import { outcomeFor, postReceivedCartons, refreshBillStatus, type ReceiveOutcome } from './store'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`

export interface ManualBox {
  raw: string
  articleCode: string
  colourCode: string
  size: string
  mrp: number | null
  /** "07/2026" from the box label. */
  mfg: string | null
  articleName: string | null
  /** Segment of this article in the master (variant first, else any colour of the code). */
  segment: string | null
}

export interface ManualAssortment {
  id: number; segment: string; sizes: AssortmentSize[]
  /** Article codes it is only for ('' = any); covers = it already applies to this box's article. */
  onlyFor?: string; covers?: boolean
}

export interface ManualLine {
  lineId: number
  billId: number
  refNo: string
  billDate: string
  division: string
  sizeFrom: string
  sizeTo: string
  /** Sizes of the range (11–1 wraps for children). */
  sizes: string[]
  packLetter: string
  pairsPerCarton: number
  mrp: number
  cartons: number
  received: number
  /** The box's size is inside this range. */
  fitsBox: boolean
  single: boolean
  /** Assortment already chosen on the bill line. */
  assortment: ManualAssortment | null
  /** Active assortments in the master that fit (division + pairs per carton + range), any segment. */
  options: ManualAssortment[]
  /** The one to propose (the line's own, else the best by the rule); null = choose or enter. */
  proposalId: number | null
}

export type ManualOptions = { ok: false; message: string } | { ok: true; box: ManualBox; lines: ManualLine[] }

function readBox(raw: string): { ok: false; message: string } | { ok: true; box: Omit<ManualBox, 'articleName' | 'segment'>; key: string } {
  const p = parseQr(raw.trim())
  if (p.kind === 'carton') return { ok: false, message: 'This is a carton label — scan it with "Scan with camera" instead. Manual entry needs a pair box from the carton.' }
  if (p.kind !== 'box' || p.status === 'invalid' || p.status === 'unrecognised') return { ok: false, message: 'Not a pair box label. Scan the QR on one shoe box from this carton.' }
  const f = p.fields
  const articleCode = normalizeArticleValue(String(f.articleCode?.value ?? ''))
  const colourCode = normalizeArticleValue(String(f.colourCode?.value ?? ''))
  const size = String(f.size?.value ?? '')
  if (!articleCode || !colourCode || !size) return { ok: false, message: 'The box label is missing the article, colour or size.' }
  const m = f.mfgMonth?.value, y = f.mfgYear?.value
  return {
    ok: true,
    key: `manual:${p.dedupeKey ?? `raw:${p.payload}`}`,
    box: { raw: raw.trim(), articleCode, colourCode, size, mrp: f.mrp?.value != null ? Number(f.mrp.value) : null, mfg: m && y ? `${String(m).padStart(2, '0')}/${y}` : null },
  }
}

/** Step 1: read the pair box and list the open invoice lines it could belong to. */
export async function manualCartonOptions(db: DbOrTx, rawBox: string): Promise<ManualOptions> {
  const r = readBox(rawBox)
  if (!r.ok) return r
  const { articleCode: art, colourCode: col } = r.box
  const [lines, info] = await Promise.all([
    db.execute<{ id: number; billId: number; refNo: string; billDate: string; division: string; sizeFrom: string; sizeTo: string; packLetter: string; pairsPerCarton: number; mrp: string; cartons: number; received: number; assortmentId: number | null; aSegment: string | null; aSizes: AssortmentSize[] | null }>(sql`
      SELECT l.id, l."billId", b."refNo", b."billDate"::text AS "billDate", b.division, l."sizeFrom", l."sizeTo", l."packLetter", l."pairsPerCarton", l.mrp, l.cartons,
             (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active')::int AS received,
             l."assortmentId", a.segment AS "aSegment", a.sizes AS "aSizes"
        FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l."billId"
        LEFT JOIN carton_assortments a ON a.id = l."assortmentId"
       WHERE b.status IN ('expected', 'partial') AND l."articleCode" = ${art} AND l."colourCode" = ${col}
         AND l.cartons > (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active')
       ORDER BY b."expectedOn", b.id, l."lineNo"
       LIMIT 30`),
    db.execute<{ artName: string | null; segment: string | null }>(sql`
      SELECT (SELECT v."artName" FROM articles v WHERE ${NORM(sql`v."artCode"`)} = ${art} AND v.active ORDER BY v.id LIMIT 1) AS "artName",
             coalesce((SELECT v.segment FROM articles v WHERE ${NORM(sql`v."artCode"`)} = ${art} AND ${NORM(sql`v."colorCode"`)} = ${col} AND v.segment IS NOT NULL LIMIT 1),
                      (SELECT v.segment FROM articles v WHERE ${NORM(sql`v."artCode"`)} = ${art} AND v.segment IS NOT NULL ORDER BY v.id LIMIT 1)) AS segment`),
  ])
  const box: ManualBox = { ...r.box, articleName: info.rows[0]?.artName ?? null, segment: info.rows[0]?.segment ?? null }
  const choices = await lineChoices(db, { lineIds: lines.rows.filter((l) => l.sizeFrom !== l.sizeTo).map((l) => Number(l.id)) })
  return {
    ok: true,
    box,
    lines: lines.rows.map((l) => {
      const range = expandSizeRange(l.sizeFrom, l.sizeTo)
      const sizes = range.ok ? range.sizes : [l.sizeFrom]
      const ch = choices.get(Number(l.id))
      return {
        lineId: Number(l.id), billId: Number(l.billId), refNo: l.refNo, billDate: l.billDate, division: l.division,
        sizeFrom: l.sizeFrom, sizeTo: l.sizeTo, sizes, packLetter: l.packLetter, pairsPerCarton: Number(l.pairsPerCarton),
        mrp: Number(l.mrp), cartons: Number(l.cartons), received: Number(l.received), fitsBox: sizes.includes(box.size),
        single: l.sizeFrom === l.sizeTo,
        assortment: l.assortmentId != null && l.aSizes ? { id: Number(l.assortmentId), segment: l.aSegment ?? '', sizes: l.aSizes } : null,
        options: (ch?.options ?? []).map((o) => ({ id: o.id, segment: o.segment, sizes: o.sizes, onlyFor: o.onlyFor, covers: o.covers })),
        proposalId: ch?.proposal?.id ?? null,
      }
    }),
  }
}

export type ManualReceiveInput = {
  rawBox: string
  clientEventId: string
  lineId: number
  /** Use this active assortment (one of the line's options). */
  assortmentId?: number | null
  /** The chosen assortment is "only for" other articles: use it for this article too. */
  addArticle?: boolean
  /** Or create one (when the master has none that fits). */
  newAssortment?: { segment: string; sizes: AssortmentSize[] } | null
}

export type ManualReceiveOutcome = ReceiveOutcome | { status: 'needs_assortment'; message: string }

/** Step 2: receive the carton against the chosen invoice line. One transaction. */
export async function receiveManualCarton(db: Db, actor: Actor, input: ManualReceiveInput): Promise<ManualReceiveOutcome> {
  if (!UUID_RE.test(input.clientEventId)) throw new Error('Invalid request.')
  const r = readBox(input.rawBox)
  if (!r.ok) return { status: 'rejected', message: r.message }
  const { box, key } = r

  return db.transaction(async (tx) => {
    const replay = await tx.execute<{ id: number; label: string }>(sql`
      SELECT id, "articleCode" || ' ' || "colourCode" || ' ' || "sizeFrom" || '–' || "sizeTo" AS label FROM carton_receipts WHERE "clientEventId" = ${input.clientEventId}::uuid`)
    if (replay.rows[0]) return outcomeFor(tx, Number(replay.rows[0].id), `${replay.rows[0].label} (manual)`, [])
    const held = await tx.execute<{ refNo: string | null; userName: string }>(sql`
      SELECT b."refNo", c."userName" FROM carton_receipts c LEFT JOIN purchase_bills b ON b.id = c."billId"
       WHERE c."dedupeKey" = ${key} AND c.status = 'active' LIMIT 1`)
    if (held.rows[0]) {
      return { status: 'duplicate', label: `${box.articleCode} ${box.colourCode}`, message: `This box was already used to receive a carton${held.rows[0].refNo ? ` on bill ${held.rows[0].refNo}` : ''} (by ${held.rows[0].userName || 'someone'}). Scan a different box from this carton.` } as const
    }

    const lr = await tx.execute<{ id: number; billId: number; refNo: string; division: string; articleCode: string; colourCode: string; sizeFrom: string; sizeTo: string; packLetter: string; pairsPerCarton: number; mrp: string; cartons: number; assortmentId: number | null; received: number; open: boolean }>(sql`
      SELECT l.id, l."billId", b."refNo", b.division, l."articleCode", l."colourCode", l."sizeFrom", l."sizeTo", l."packLetter", l."pairsPerCarton", l.mrp, l.cartons, l."assortmentId",
             (SELECT count(*) FROM carton_receipts c WHERE c."billLineId" = l.id AND c.status = 'active')::int AS received,
             b.status IN ('expected', 'partial') AS open
        FROM purchase_bill_lines l JOIN purchase_bills b ON b.id = l."billId"
       WHERE l.id = ${input.lineId}
       FOR UPDATE OF l`)
    const line = lr.rows[0]
    if (!line || !line.open) throw new Error('That invoice line is not open any more. Reload and try again.')
    if (line.articleCode !== box.articleCode || line.colourCode !== box.colourCode) throw new Error('The box is a different article or colour from that invoice line.')
    if (Number(line.received) >= Number(line.cartons)) throw new Error(`All ${line.cartons} cartons of that invoice line are already received.`)
    const range = expandSizeRange(line.sizeFrom, line.sizeTo)
    const sizes = range.ok ? range.sizes : [line.sizeFrom]
    if (!sizes.includes(box.size)) throw new Error(`The box is size ${box.size}, which is not in this carton's range ${line.sizeFrom}–${line.sizeTo}. Choose the right range.`)

    // Carton contents: the assortment the receiver confirmed (chosen or typed), else the line's own.
    if (line.sizeFrom !== line.sizeTo) {
      const answer = input.assortmentId || input.newAssortment
        ? { assortmentId: input.assortmentId ?? null, addArticle: input.addArticle, newAssortment: input.newAssortment ?? null }
        : { assortmentId: line.assortmentId != null ? Number(line.assortmentId) : null }
      try {
        await settleLineAssortment(tx, actor, {
          id: Number(line.id), refNo: line.refNo, division: line.division ?? '', articleCode: line.articleCode, pairsPerCarton: Number(line.pairsPerCarton),
          sizeFrom: line.sizeFrom, sizeTo: line.sizeTo, assortmentId: line.assortmentId != null ? Number(line.assortmentId) : null,
        }, answer, 'manual carton entry')
      } catch (e) {
        if (e instanceof NeedsAssortment) return { status: 'needs_assortment', message: 'Enter the pairs in each size of this carton (the master has no assortment for it yet).' } as const
        throw e
      }
    }

    const warnings: string[] = ['Entered by hand (carton label not scanned).']
    if (box.mrp != null && Number(line.mrp) !== box.mrp) warnings.push(`Box MRP ₹${box.mrp} differs from the bill's ₹${Number(line.mrp)}.`)
    const label = `${line.articleCode} ${line.colourCode} ${line.sizeFrom}–${line.sizeTo}${line.packLetter ? ` ${line.packLetter}` : ''}`
    const ins = await tx.execute<{ id: number }>(sql`
      INSERT INTO carton_receipts ("clientEventId", "rawInput", "dedupeKey", "articleCode", "colourCode", "sizeFrom", "sizeTo", "packLetter", mrp, match, "billId", "billLineId", "userId", "userName")
      VALUES (${input.clientEventId}::uuid, ${box.raw}, ${key}, ${line.articleCode}, ${line.colourCode}, ${line.sizeFrom}, ${line.sizeTo}, ${line.packLetter}, ${box.mrp ?? line.mrp},
              'matched', ${Number(line.billId)}, ${Number(line.id)}, ${actor.id}, ${actor.name})
      ON CONFLICT DO NOTHING RETURNING id`)
    if (!ins.rows[0]) return { status: 'duplicate', label, message: 'Already received (saved twice at the same moment).' } as const
    const receiptId = Number(ins.rows[0].id)
    await refreshBillStatus(tx, Number(line.billId))
    await postReceivedCartons(tx, actor, [receiptId])
    await audit(tx, { actor, action: 'carton.received_manual', entityType: 'carton_receipt', entityId: receiptId, after: { label, billId: line.billId, lineId: line.id, box: box.raw, mfg: box.mfg } })
    return outcomeFor(tx, receiptId, label, warnings)
  })
}

