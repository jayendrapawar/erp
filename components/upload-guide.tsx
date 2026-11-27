'use client'

// "How to upload" for every CSV / Excel upload: a link that opens the steps, the column names
// (first row of the file) and a template to download.

import { useState } from 'react'

export interface UploadColumn { name: string; required: boolean; example: string; help: string }

export function UploadGuide({ title, steps, columns, columnsNote, onTemplate, templateHref }: {
  title: string
  steps: string[]
  columns?: readonly UploadColumn[]
  columnsNote?: string
  onTemplate?: () => void
  templateHref?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(v => !v)} className="text-xs text-muted-foreground underline underline-offset-2">
        {open ? 'Hide help' : 'How to upload'}
      </button>
      {open && (
        <section className="mt-3 basis-full rounded-xl border border-border bg-muted/30 p-4 text-sm">
          <h3 className="font-semibold">{title}</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            {steps.map(s => <li key={s}>{s}</li>)}
          </ol>
          {columns && columns.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-background">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Column name</th>
                    <th className="px-2 py-1.5 text-left">Needed?</th>
                    <th className="px-2 py-1.5 text-left">Example</th>
                    <th className="px-2 py-1.5 text-left">What to enter</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {columns.map(c => (
                    <tr key={c.name}>
                      <td className="px-2 py-1.5 font-mono font-semibold whitespace-nowrap" data-no-translate>{c.name}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{c.required ? 'Required' : 'Optional'}</td>
                      <td className="px-2 py-1.5 font-mono whitespace-nowrap" data-no-translate>{c.example}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{c.help}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {columnsNote && <p className="mt-2 text-xs text-muted-foreground">{columnsNote}</p>}
          {(onTemplate || templateHref) && (
            templateHref
              ? <a href={templateHref} className="mt-3 inline-block rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted">↓ Download template</a>
              : <button type="button" onClick={onTemplate} className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted">↓ Download template</button>
          )}
        </section>
      )}
    </>
  )
}
