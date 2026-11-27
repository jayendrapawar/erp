// Size shown on order screens. One article NAME can cover several codes with the same size labels
// (SS-101: SS0101C children 11–13, 1 and SS0101S big 11–12). When a size label appears for two codes
// in the same article + colour, the code is added: "11 (SS0101S)". Otherwise just the size.

export type SizedItem = { sizeNumber: string | null; artCode?: string | null }

export function sizeWithCode(item: SizedItem, group: readonly SizedItem[]): string {
  const size = item.sizeNumber ?? '—'
  const code = (item.artCode ?? '').trim().toUpperCase()
  if (!code) return size
  const clash = group.some(o => o !== item && o.sizeNumber === item.sizeNumber && (o.artCode ?? '').trim().toUpperCase() !== code)
  return clash ? `${size} (${code})` : size
}
