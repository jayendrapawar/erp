export const SIZE_SUGGESTIONS: Record<string, string> = {
  G: '6-10',
  L: '4-9',
  B: '1-5',
  C: '11,12,13,1',
  S: '11-12',
  K: '6-10',
  M: '8-10',
  W: '8-10',
  F: '2-4',
  U: '1-4',
}

export function suggestSizes(articleCode: string): string {
  return SIZE_SUGGESTIONS[articleCode.slice(-1).toUpperCase()] ?? ''
}
