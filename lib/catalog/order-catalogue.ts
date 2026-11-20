// Order catalogue grouping (shared by New Order's catalogue, its single-article loader, tests and
// the duplicate-size check). Pure: no database access.
//
// Rule (owner, 20 Nov 2026): one article NAME may cover several article CODES whose size labels
// overlap (SS-101: SS0101C children 11–13, 1 · SS0101G 6–10 · SS0101S big 11–12). Colours are merged
// by name; when a colour comes in more than one code, every size gets the key "CODE:size", so two
// sizes of different codes can never merge — for existing and future articles alike.

export interface ArticleDetail {
  id: number        // id of first article row for this artName (stable key)
  artNumber: string // the artName
  colors: { id: number; articleId: number; colorName: string; colorHex: string | null }[]
  /**
   * Sizes per colour (articleId = the colour's representative variant). When one colour of this name
   * spans several article codes (SS-101 Black: SS0101C 11–13, 1 · SS0101G 6–10 · SS0101S 11–12),
   * `key` is "CODE:size" so the children's 11 and the big 11 stay apart; otherwise key = sizeLabel.
   */
  sizes: { id: number; articleId: number; sizeLabel: string; sortOrder: number; artCode: string; key: string }[]
}

export type ColourRow = { id: number; articleId: number; colorName: string; colorHex: string | null }
export type SizeRow = { id: number; articleId: number; sizeLabel: string; sortOrder: number }

/** Shared by the bulk catalogue and the single-article loader. Pure (no queries). */
export function groupArticles(
  artRows: { id: number; artName: string; artCode: string }[],
  colorsByArt: Map<number, ColourRow[]>,
  sizesByArt: Map<number, SizeRow[]>,
): Map<string, ArticleDetail> {
// One ArticleDetail per article name. Colours are merged by name; each colour keeps the sizes of
// every code it comes in, keyed per code when there is more than one code.
const normalizedLabel = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
const artDetailMap = new Map<string, ArticleDetail>()
type Group = { rep: number; variants: { id: number; artCode: string }[] }
const groupsByName = new Map<string, Map<string, Group>>()
for (const row of artRows) {
  if (!artDetailMap.has(row.artName)) artDetailMap.set(row.artName, { id: row.id, artNumber: row.artName, colors: [], sizes: [] })
  const detail = artDetailMap.get(row.artName)!
  if (!groupsByName.has(row.artName)) groupsByName.set(row.artName, new Map())
  const groups = groupsByName.get(row.artName)!
  const colours = colorsByArt.get(row.id) ?? []
  if (!colours.length) {
    // No colour configured: its sizes hang on the variant itself.
    groups.set(`#${row.id}`, { rep: row.id, variants: [{ id: row.id, artCode: row.artCode }] })
    continue
  }
  for (const c of colours) {
    const key = normalizedLabel(c.colorName)
    const g = groups.get(key)
    if (!g) { groups.set(key, { rep: c.articleId, variants: [{ id: row.id, artCode: row.artCode }] }); detail.colors.push(c) }
    else if (!g.variants.some(v => v.id === row.id)) g.variants.push({ id: row.id, artCode: row.artCode })
  }
}
for (const [name, groups] of groupsByName) {
  const detail = artDetailMap.get(name)!
  for (const g of groups.values()) {
    const multi = new Set(g.variants.map(v => v.artCode.trim().toUpperCase())).size > 1
    const seen = new Set<string>()
    const rows: ArticleDetail['sizes'] = []
    for (const v of g.variants) {
      for (const sz of sizesByArt.get(v.id) ?? []) {
        const key = multi ? `${v.artCode.trim().toUpperCase()}:${sz.sizeLabel}` : sz.sizeLabel
        if (seen.has(normalizedLabel(key))) continue
        seen.add(normalizedLabel(key))
        rows.push({ id: sz.id, articleId: g.rep, sizeLabel: sz.sizeLabel, sortOrder: sz.sortOrder, artCode: v.artCode.trim().toUpperCase(), key })
      }
    }
    // Codes in a sensible order: children's runs (with sizes 1–5) first, then by smallest size
    // (6–10 before big 11–12); sizes in chart order inside each code.
    const rank = new Map<string, number>()
    for (const code of new Set(rows.map(r => r.artCode))) {
      const nums = rows.filter(r => r.artCode === code).map(r => Number(r.sizeLabel)).filter(n => Number.isFinite(n))
      const kids = nums.some(n => n >= 1 && n <= 5)
      rank.set(code, (kids ? 0 : 1000) + (nums.length ? Math.min(...nums) : 999))
    }
    rows.sort((a, b) => (multi ? (rank.get(a.artCode)! - rank.get(b.artCode)!) || a.artCode.localeCompare(b.artCode) : 0)
      || a.sortOrder - b.sortOrder || a.sizeLabel.localeCompare(b.sizeLabel, undefined, { numeric: true }))
    detail.sizes.push(...rows)
  }
}
  return artDetailMap
}
