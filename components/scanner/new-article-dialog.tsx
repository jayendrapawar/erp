'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { getArticleDefaults, getColoursForName, linkOrCreateArticle, searchArticleNames } from '@/app/actions/articles'
import { DIVISIONS, SEGMENTS } from '@/lib/catalog/assortments'
import type { ParsedQr } from '@/lib/qr-parser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { suggestSizes } from './size-suggestions'
import { DialogKeys } from '@/components/dialog-keys'

type Props = {
  rawQr: string
  parsed: ParsedQr
  mode: 'unknown' | 'new_colour'
  existingName?: string
  /** Scanner flag for the saved scan. */
  flag?: string
  /** Device-generated id of the scan being saved (makes retries safe). */
  clientEventId?: string
  saveScan?: boolean
  initialSizes?: string
  /** Text for the close (×) button; default says the scan is saved without details. */
  closeLabel?: string
  onClose: () => void
  onSaveLater: () => Promise<boolean>
  onLinked: () => Promise<void>
}

export function NewArticleDialog({ rawQr, parsed, mode, existingName, flag, clientEventId, saveScan = true, initialSizes, closeLabel = 'Close (scan is saved without article details)', onClose, onSaveLater, onLinked }: Props) {
  const [articleName, setArticleName] = useState(existingName ?? '')
  const [colourChoice, setColourChoice] = useState('')
  const [otherColour, setOtherColour] = useState('')
  const [segment, setSegment] = useState('')
  const [division, setDivision] = useState('')
  const [divisionSuggested, setDivisionSuggested] = useState(false)
  const [sizes, setSizes] = useState(initialSizes ?? suggestSizes(parsed.articleCode))
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [colours, setColours] = useState<string[]>([])
  const [pendingColours, setPendingColours] = useState<string[]>([])
  const [selectedKnownName, setSelectedKnownName] = useState(Boolean(existingName))
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [warning, setWarning] = useState<'mismatch' | 'size' | null>(null)
  const [articleSizes, setArticleSizes] = useState<string[]>([])
  const messageRef = useRef<HTMLDivElement>(null)
  const warningButtonRef = useRef<HTMLButtonElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)

  const isLockedName = mode === 'new_colour'
  const matchingName = suggestions.find((name) => name.trim().toLocaleLowerCase() === articleName.trim().toLocaleLowerCase())
  const hasKnownName = selectedKnownName || Boolean(matchingName)
  const showSizes = mode === 'unknown'
  const colourName = colours.length === 0 || colourChoice === '__other__' ? otherColour.trim() : colourChoice
  const canSubmit = articleName.trim().length > 0 && colourName.length > 0 && segment.length > 0 && division.length > 0 && (!showSizes || sizes.trim().length > 0)
  const readOnlyRows = useMemo(() => [
    ['Article code', parsed.articleCode],
    ['Colour code', parsed.colorCode],
    ['Size', parsed.size],
    ['MRP', parsed.mrp ? String(parsed.mrp) : '—'],
    ['Division hint (from code)', parsed.division || '—'],
  ], [parsed])

  useEffect(() => {
    if (isLockedName || articleName.trim().length < 2) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      searchArticleNames(articleName).then((names) => { if (!cancelled) setSuggestions(names) }).catch(() => { if (!cancelled) setSuggestions([]) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [articleName, isLockedName])

  useEffect(() => {
    const exactName = selectedKnownName ? articleName.trim() : matchingName
    if (!exactName) {
      setColours([])
      setPendingColours([])
      setColourChoice('')
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      getColoursForName(exactName, parsed.articleCode).then((values) => {
        if (!cancelled) {
          const names = values.map((value) => value.colorName)
          setColours(names)
          setPendingColours(values.filter((value) => value.pending).map((value) => value.colorName))
          setColourChoice((choice) => names.includes(choice) ? choice : '')
        }
      }).catch(() => { if (!cancelled) setColours([]) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [articleName, matchingName, selectedKnownName, parsed.articleCode])

  // Prefill segment and division from this article code (division suggested from the code if unknown).
  useEffect(() => {
    let cancelled = false
    getArticleDefaults(parsed.articleCode).then((d) => {
      if (cancelled) return
      if (d.segment) setSegment((cur) => cur || d.segment!)
      if (d.division) { setDivision((cur) => cur || d.division!); setDivisionSuggested(d.divisionSuggested) }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [parsed.articleCode])

  // Esc: <DialogKeys> (focus returns to the opener).

  useEffect(() => {
    if (!warning && !errorMessage) return
    messageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    if (warning) warningButtonRef.current?.focus()
    else createButtonRef.current?.focus()
  }, [warning, errorMessage])

  async function submit(event?: FormEvent<HTMLFormElement>, confirmWarnings = false, addScannedSize = false) {
    event?.preventDefault()
    if (!canSubmit || loading) return
    setLoading(true)
    setErrorMessage('')
    try {
      const result = await linkOrCreateArticle({
        rawQr,
        artName: articleName.trim(),
        colorName: colourName,
        sizesText: sizes.trim(),
        segment,
        division,
        addScannedSize,
        confirmWarnings,
        flag,
        clientEventId,
        saveScan,
      })
      if (result.ok) {
        await onLinked()
        return
      }
      if (result.error === 'NUMBER_MISMATCH') {
        setWarning('mismatch')
      } else if (result.error === 'SIZE_NOT_IN_ARTICLE') {
        setWarning('size')
        setArticleSizes(result.sizes)
      } else {
        const messages: Record<string, string> = {
          DUPLICATE_QR: 'This QR code has already been scanned.',
          SIZES_REQUIRED: 'Enter at least one size before creating this article.',
          NAME_REQUIRED: 'Enter both an article name and a colour name.',
          SEGMENT_REQUIRED: 'Choose the segment (Gents, Ladies, Kids or Baby).',
          DIVISION_REQUIRED: 'Choose the division.',
          ALREADY_EXISTS: 'An article with this article code and colour code already exists.',
          FORBIDDEN: 'You do not have access to link this article.',
          INVALID_QR: 'This QR code format is not recognised.',
        }
        setErrorMessage(messages[result.error] ?? 'The article could not be linked. Please try again.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/already been scanned|duplicate qr/i.test(message)) setErrorMessage('This QR code has already been scanned.')
      else if (/unauthorized|forbidden/i.test(message)) setErrorMessage('You do not have access to link this article.')
      else setErrorMessage('The article could not be linked. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function saveLater() {
    if (loading) return
    setLoading(true)
    setErrorMessage('')
    try {
      const saved = await onSaveLater()
      if (!saved) setErrorMessage('The scan was not saved. Please try again.')
    } catch {
      setErrorMessage('The scan could not be saved. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  function chooseName(name: string) {
    setArticleName(name)
    setSelectedKnownName(true)
    setSuggestions([])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
      <DialogKeys onClose={() => { if (!loading) onClose() }} />
      <div role="dialog" aria-modal="true" aria-labelledby="new-article-title" className="w-full max-w-lg max-h-[92dvh] overflow-y-auto rounded-xl border bg-background p-5 shadow-lg sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="new-article-title" className="text-lg font-semibold">New Article Detected</h2>
            <p className="mt-1 text-sm text-muted-foreground">Add article details or save this scan to finish later.</p>
          </div>
          <button type="button" aria-label={closeLabel} title={closeLabel} disabled={loading} onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-xl hover:bg-muted disabled:opacity-50">×</button>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3">
          {readOnlyRows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="truncate text-sm font-medium" title={value}>{value}</div>
            </div>
          ))}
        </div>

        <form onSubmit={(event) => submit(event)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-article-name">Article name</Label>
            <Input id="new-article-name" autoFocus={!isLockedName} autoComplete="off" value={articleName} readOnly={isLockedName} disabled={loading} onChange={(event) => { setArticleName(event.target.value); setSelectedKnownName(false); setColourChoice('') }} className="h-12 text-base" placeholder="Search or enter a name" />
            {!isLockedName && suggestions.length > 0 && !hasKnownName && (
              <div className="max-h-36 overflow-y-auto rounded-lg border bg-background">
                {suggestions.map((name) => <button key={name} type="button" onClick={() => chooseName(name)} className="block min-h-11 w-full px-3 text-left text-sm hover:bg-muted">{name}</button>)}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-article-colour">Colour name</Label>
            {colours.length === 0 ? <Input id="new-article-colour" autoFocus={isLockedName} value={otherColour} onChange={(event) => setOtherColour(event.target.value)} disabled={loading} className="h-12 text-base" placeholder="Enter colour name" /> : <select id="new-article-colour" autoFocus={isLockedName} value={colourChoice} disabled={loading} onChange={(event) => { setColourChoice(event.target.value); if (event.target.value !== '__other__') setOtherColour('') }} className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">Choose a colour</option>
              {pendingColours.length > 0 && <optgroup label="No colour code yet (this article)">
                {pendingColours.map((colour) => <option key={`p-${colour}`} value={colour}>{colour}</option>)}
              </optgroup>}
              <optgroup label={pendingColours.length > 0 ? 'Other colours' : 'Colours'}>
                {colours.filter((colour) => !pendingColours.includes(colour)).map((colour) => <option key={colour} value={colour}>{colour}</option>)}
              </optgroup>
              <option value="__other__">Other</option>
            </select>}
            {pendingColours.includes(colourChoice) && <p className="text-xs text-muted-foreground">{`This colour is in the master without a colour code. Saving gives it code ${parsed.colorCode}.`}</p>}
            {pendingColours.length > 0 && !colourChoice && <p className="text-xs text-amber-700 dark:text-amber-400">Colours under &quot;No colour code yet&quot; are waiting for their code. If this box is one of them, choose it.</p>}
            {colourChoice === '__other__' && <Input autoFocus value={otherColour} onChange={(event) => setOtherColour(event.target.value)} disabled={loading} className="h-12 text-base" placeholder="Enter colour name" />}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-article-segment">Segment</Label>
            <select id="new-article-segment" value={segment} disabled={loading} onChange={(event) => setSegment(event.target.value)} className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">Choose a segment</option>
              {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-article-division">Division</Label>
            <select id="new-article-division" value={division} disabled={loading} onChange={(event) => { setDivision(event.target.value); setDivisionSuggested(false) }} className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">Choose a division</option>
              {DIVISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {divisionSuggested && division && <p className="text-xs text-muted-foreground">Suggested from the article code. Change it if this article is from another division.</p>}
          </div>

          {showSizes && (
            <div className="space-y-1.5">
              <Label htmlFor="new-article-sizes">Sizes</Label>
              <Input id="new-article-sizes" value={sizes} onChange={(event) => setSizes(event.target.value)} disabled={loading} className="h-12 text-base" placeholder="For example 6-10 or 11,12,13,1" />
              <p className="text-xs text-muted-foreground">Suggested from the article code. Edit if needed.</p>
            </div>
          )}

          {warning === 'mismatch' && <div ref={messageRef} role="alert" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"><p>The article number in the name differs from the scanned code. Confirm to continue.</p><Button ref={warningButtonRef} type="button" disabled={loading} onClick={() => submit(undefined, true, false)} className="min-h-11 w-full">Confirm and continue</Button></div>}
          {warning === 'size' && <div ref={messageRef} role="alert" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"><p>Scanned size {parsed.size} is not in this article&apos;s sizes: {articleSizes.join(', ') || 'none listed'}.</p><Button ref={warningButtonRef} type="button" disabled={loading} onClick={() => submit(undefined, true, true)} className="min-h-11 w-full">Add size {parsed.size} to this article</Button></div>}
          {errorMessage && <div ref={messageRef} role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{errorMessage}</div>}

          <div className="grid gap-2 pt-1 sm:grid-cols-2">
            <Button ref={createButtonRef} type="submit" disabled={!canSubmit || loading} className="min-h-12 text-base">{loading ? 'Saving…' : 'Create / Link'}</Button>
            {saveScan && <Button type="button" variant="outline" disabled={loading} onClick={saveLater} className="min-h-12 whitespace-normal text-center">Save scan, add details later</Button>}
          </div>
        </form>
      </div>
    </div>
  )
}
