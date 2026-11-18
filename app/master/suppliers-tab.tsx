'use client'

import { useMemo, useState, useTransition } from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'
import { saveSupplier, type Supplier, type SupplierInput } from '@/app/actions/suppliers'

type Form = Omit<SupplierInput, 'divisions' | 'paymentTermsDays'> & { divisionsText: string; paymentTermsText: string }

const EMPTY_FORM: Form = {
  name: '', contactPerson: '', phone: '', email: '', gst: '', address: '', city: '',
  divisionsText: '', paymentTermsText: '', notes: '', status: 'active',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
      status === 'active'
        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
    }`}>
      {status === 'active' ? 'Active' : 'Inactive'}
    </span>
  )
}

interface Props {
  initialSuppliers: Supplier[]
  readOnly?: boolean
  onListChange?: (list: Supplier[]) => void
}

/** Supplier master (companies we buy from). Saved to the database; changes are audited. */
export function SuppliersTab({ initialSuppliers, readOnly = false, onListChange }: Props) {
  const [suppliers, setSuppliers] = useState<Supplier[]>(initialSuppliers)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [modalMode, setModalMode] = useState<'add' | 'edit' | null>(null)
  const [editId, setEditId] = useState<number | null>(null)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [saving, startSaving] = useTransition()

  const filtered = useMemo(() => {
    let list = suppliers
    if (filterStatus !== 'all') list = list.filter(s => s.status === filterStatus)
    return fuzzyFilter(list, search, s => [s.name, s.contactPerson, s.city, s.divisions.join(' '), s.gst])
  }, [suppliers, search, filterStatus])

  function openAdd() {
    setForm(EMPTY_FORM); setFormError(''); setEditId(null); setModalMode('add')
  }

  function openEdit(s: Supplier) {
    setForm({
      name: s.name, contactPerson: s.contactPerson, phone: s.phone, email: s.email, gst: s.gst, address: s.address, city: s.city,
      divisionsText: s.divisions.join(', '), paymentTermsText: s.paymentTermsDays == null ? '' : String(s.paymentTermsDays),
      notes: s.notes, status: s.status,
    })
    setFormError(''); setEditId(s.id); setModalMode('edit')
  }

  function handleSave() {
    if (!form.name.trim()) { setFormError('Name is required.'); return }
    const days = form.paymentTermsText.trim() ? Number(form.paymentTermsText) : null
    if (days != null && (!Number.isInteger(days) || days < 0)) { setFormError('Credit period must be a whole number of days.'); return }
    setFormError('')
    startSaving(async () => {
      try {
        const list = await saveSupplier({
          id: editId ?? undefined,
          name: form.name, contactPerson: form.contactPerson, phone: form.phone, email: form.email, gst: form.gst,
          address: form.address, city: form.city, notes: form.notes, status: form.status,
          divisions: form.divisionsText.split(','), paymentTermsDays: days,
        })
        setSuppliers(list)
        onListChange?.(list)
        setModalMode(null)
      } catch (e) {
        setFormError(e instanceof Error ? e.message : 'Could not save the supplier.')
      }
    })
  }

  const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring'
  const field = (key: keyof Form, label: string, props: { placeholder?: string; type?: string; span?: boolean } = {}) => (
    <div className={props.span ? 'col-span-2' : 'col-span-2 sm:col-span-1'}>
      <label htmlFor={`supplier-${key}`} className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">{label}</label>
      <input id={`supplier-${key}`} value={form[key] as string} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} className={inputCls} placeholder={props.placeholder} type={props.type} />
    </div>
  )

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="search"
          placeholder="Search suppliers…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[160px] rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value as typeof filterStatus)}
          className="rounded-lg border border-border bg-background px-2 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        {!readOnly && (
          <button onClick={openAdd} className="rounded-lg bg-foreground text-background px-3 py-2 text-xs font-semibold hover:opacity-90 transition-opacity">
            + Add Supplier
          </button>
        )}
      </div>

      {filtered.length === 0 && (
        <p className="text-center py-10 text-sm text-muted-foreground">
          {suppliers.length === 0 ? 'No suppliers yet. Add the companies you buy from, such as each Relaxo division.' : 'No suppliers found'}
        </p>
      )}

      <div className="sm:hidden space-y-3">
        {filtered.map(s => (
          <div key={s.id} className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-sm text-foreground">{s.name}</p>
              <StatusBadge status={s.status} />
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">Contact</span><span className="text-foreground">{s.contactPerson || '—'}</span>
              <span className="text-muted-foreground">Phone</span><span className="text-foreground">{s.phone || '—'}</span>
              <span className="text-muted-foreground">GSTIN</span><span className="text-foreground font-mono">{s.gst || '—'}</span>
              <span className="text-muted-foreground">Divisions</span><span className="text-foreground">{s.divisions.join(', ') || '—'}</span>
              <span className="text-muted-foreground">Credit</span><span className="text-foreground">{s.paymentTermsDays != null ? `${s.paymentTermsDays} days` : '—'}</span>
            </div>
            {!readOnly && (
              <div className="flex gap-2 pt-2 border-t border-border">
                <button onClick={() => openEdit(s)} className="flex-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted transition-colors">Edit</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="hidden sm:block rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contact</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Phone</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">GSTIN</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Divisions</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Credit</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                {!readOnly && <th className="text-left px-4 py-3 font-medium text-muted-foreground">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(s => (
                <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">{s.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.contactPerson || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.phone || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{s.gst || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.divisions.join(', ') || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{s.paymentTermsDays != null ? `${s.paymentTermsDays} days` : '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                  {!readOnly && (
                    <td className="px-4 py-3">
                      <button onClick={() => openEdit(s)} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors">Edit</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4" onClick={() => !saving && setModalMode(null)}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-background shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <p className="font-semibold text-sm text-foreground">{modalMode === 'add' ? 'Add Supplier' : 'Edit Supplier'}</p>
            </div>
            <div className="p-5 space-y-3">
              {formError && <p className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{formError}</p>}
              <div className="grid grid-cols-2 gap-3">
                {field('name', 'Name *', { placeholder: 'e.g. Relaxo Footwears Ltd — Sparx', span: true })}
                {field('contactPerson', 'Contact person')}
                {field('phone', 'Phone', { placeholder: '+91 …' })}
                {field('email', 'Email', { type: 'email', span: true })}
                {field('gst', 'GSTIN', { placeholder: '15 characters' })}
                {field('city', 'City')}
                {field('address', 'Address', { span: true })}
                {field('divisionsText', 'Divisions / brands', { placeholder: 'Sparx, Flite PU', span: true })}
                {field('paymentTermsText', 'Credit period (days)', { type: 'number' })}
                <div className="col-span-2 sm:col-span-1">
                  <label htmlFor="supplier-status" className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide block mb-1">Status</label>
                  <select id="supplier-status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value as 'active' | 'inactive' }))} className={inputCls}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
                {field('notes', 'Notes', { span: true })}
              </div>
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-border">
              <button disabled={saving} onClick={() => setModalMode(null)} className="flex-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted transition-colors">Cancel</button>
              <button disabled={saving} onClick={handleSave} className="flex-1 rounded-lg bg-foreground text-background px-3 py-2 text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-60">
                {saving ? 'Saving…' : modalMode === 'add' ? 'Add Supplier' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
