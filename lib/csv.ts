// Small CSV reader shared by the uploads (client- and server-safe): quoted cells may contain
// commas and doubled quotes ("A, B" / "say ""hi"""). Rows are 1-based sheet row numbers.

export function csvToCells(text: string): { rowNumber: number; values: string[] }[] {
  const out: { rowNumber: number; values: string[] }[] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (!line.trim()) return
    const cells: string[] = []
    let cell = '', quoted = false
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      if (ch === '"') { if (quoted && line[j + 1] === '"') { cell += '"'; j++ } else quoted = !quoted }
      else if (ch === ',' && !quoted) { cells.push(cell.trim()); cell = '' }
      else cell += ch
    }
    cells.push(cell.trim())
    out.push({ rowNumber: i + 1, values: cells })
  })
  return out
}

/** A CSV file text from rows (cells with commas, quotes or line breaks are quoted). */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** Offer a CSV for download in the browser. */
export function downloadCsv(fileName: string, rows: (string | number)[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
