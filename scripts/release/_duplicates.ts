// Shared rules for resolving duplicate article code + colour code groups before migration 0001.
// Used by prepare-article-duplicates.ts (does it) and export-duplicate-review.ts (shows it),
// so the owner reviews exactly what the release will do.

import type pg from 'pg'
import { isSparxScope } from '../../lib/catalog/sparx-workbook'

export const NORM = (col: string) => `upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`

export interface DupRow { id: number; artName: string; artCode: string; colorCode: string; color: string; key: string; sizes: string }

export type DupAction = 'keep' | 'merge' | 'clear'

export interface DupDecision { row: DupRow; action: DupAction; keep: number | null; reason: string }

export async function loadDuplicateRows(c: pg.PoolClient | pg.Client): Promise<DupRow[]> {
  return (await c.query<DupRow>(`
    SELECT a.id, a."artName", a."artCode", a."colorCode", a.color, ${NORM('a."artCode"')} || '|' || ${NORM('a."colorCode"')} AS key,
      coalesce((SELECT string_agg(s."sizeLabel", ' ' ORDER BY s."sortOrder") FROM article_sizes s WHERE s."articleId" = a.id), '') AS sizes
    FROM articles a
    WHERE btrim(a."artCode") <> '' AND btrim(a."colorCode") <> ''
      AND ${NORM('a."artCode"')} || '|' || ${NORM('a."colorCode"')} IN (
        SELECT ${NORM('"artCode"')} || '|' || ${NORM('"colorCode"')} FROM articles
        WHERE btrim("artCode") <> '' AND btrim("colorCode") <> '' GROUP BY 1 HAVING count(*) > 1)
    ORDER BY key, a.id`)).rows
}

/**
 * Per group: keep the lowest-id Sparx row (the catalogue import then gives it the approved name,
 * colour and full size set); archive and remove the other Sparx rows; keep other-brand rows but
 * clear the Sparx code they carry by mistake. A group with no Sparx row: clear codes on every row.
 */
export function decideDuplicates(rows: DupRow[]): DupDecision[] {
  const groups = new Map<string, DupRow[]>()
  for (const r of rows) groups.set(r.key, [...(groups.get(r.key) ?? []), r])
  const out: DupDecision[] = []
  for (const [key, g] of groups) {
    const label = key.replace('|', ' ')
    const sparx = g.filter(r => isSparxScope(r.artCode, r.artName))
    if (sparx.length) {
      const keep = Math.min(...sparx.map(r => r.id))
      for (const r of g) {
        if (r.id === keep) out.push({ row: r, action: 'keep', keep: null, reason: `Lowest-id Sparx row for ${label}; the catalogue import sets its approved name, colour and sizes.` })
        else if (sparx.includes(r)) out.push({ row: r, action: 'merge', keep, reason: `Same Sparx product as #${keep} (${label}); its sizes are covered by the approved workbook.` })
        else out.push({ row: r, action: 'clear', keep: null, reason: `Not a Sparx article but carries Sparx code ${label}; the row stays, the wrong code is removed.` })
      }
    } else {
      for (const r of g) out.push({ row: r, action: 'clear', keep: null, reason: `Code ${label} is on ${g.length} non-Sparx rows (${g.map(x => `#${x.id} ${x.artName}`).join(', ')}); which one owns it is unknown.` })
    }
  }
  return out
}
