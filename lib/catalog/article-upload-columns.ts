// Column guide for the article list upload. Client-safe (no database imports): the Master
// screen shows it as "How to upload" and builds the template from it.

/** Column guide shown on the upload screen and written into the template. */
export const ARTICLE_UPLOAD_COLUMNS = [
  { name: 'artName', required: true, example: 'PXL-05', help: 'Article name (family name), e.g. SS-702, PXL-05, FL-48.' },
  { name: 'artCode', required: true, example: 'PXL005L', help: 'Article code exactly as on the box label.' },
  { name: 'color', required: true, example: 'Black', help: 'Colour name.' },
  { name: 'colorCode', required: false, example: 'BKBK', help: 'Colour code from the box label. Leave blank if not known: the row is kept with its colour name, and the code is added when the first box of that colour is scanned.' },
  { name: 'minSize', required: true, example: '3', help: 'Smallest size. Children’s runs may wrap: minSize 11, maxSize 5 = 11, 12, 13, 1 … 5.' },
  { name: 'maxSize', required: true, example: '8', help: 'Largest size.' },
  { name: 'Stock source', required: false, example: 'PU', help: 'Division: Sparx, PU, Flite (EVA) or Bahamas.' },
  { name: 'Segment', required: false, example: 'Gents', help: 'Gents, Ladies or Kids. You can keep this column; it is not saved yet (coming with the segment update).' },
] as const

/** Template CSV (opens in Excel) with the expected header and two example rows. */
export function articleTemplateCsv(): string {
  const header = ARTICLE_UPLOAD_COLUMNS.map((c) => c.name)
  const rows = [
    ['PXL-05', 'PXL005L', 'Black', 'BKBK', '3', '8', 'PU', ''],
    ['PXL-05', 'PXL005L', 'D. Pink', '', '3', '8', 'PU', ''],
  ]
  return [header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n'
}
