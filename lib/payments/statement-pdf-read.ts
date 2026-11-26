// The text pieces of a statement PDF with their positions (for readPdfStatement). Server only.

import { getDocumentProxy } from 'unpdf'
import type { PdfTextPage } from './statement-pdf'

export const MAX_STATEMENT_PAGES = 200

export async function pdfTextPages(bytes: Uint8Array): Promise<PdfTextPage[]> {
  // pdf.js takes over (detaches) the buffer it is given, so it gets a copy.
  const pdf = await getDocumentProxy(bytes.slice())
  if (pdf.numPages > MAX_STATEMENT_PAGES) throw new Error(`The PDF has ${pdf.numPages} pages (limit ${MAX_STATEMENT_PAGES}). Download a shorter period.`)
  const pages: PdfTextPage[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const items: PdfTextPage['items'] = []
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue
      items.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width })
    }
    pages.push({ items })
    page.cleanup()
  }
  await pdf.cleanup()
  return pages
}
