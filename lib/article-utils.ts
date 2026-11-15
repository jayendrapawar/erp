export function normalizeArticleValue(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
}

export function parseSizeText(value: string): string[] {
  const text = value.trim()
  if (!text) return []
  const range = text.match(/^(\d+)\s*-\s*(\d+)$/)
  if (range) {
    const min = Number(range[1])
    const max = Number(range[2])
    if (max < min || max - min > 100) return []
    return Array.from({ length: max - min + 1 }, (_, i) => String(min + i))
  }
  return [...new Set(text.split(',').map((label) => label.trim()).filter(Boolean))]
}

export function hasArticleNumberMismatch(artName: string, artCode: string): boolean {
  const nameDigits = artName.replace(/\D/g, '')
  const codeDigits = artCode.replace(/\D/g, '')
  return Boolean(nameDigits && codeDigits && Number(nameDigits) !== Number(codeDigits))
}
