import { useEffect, useState } from 'react'
import { errorMessage, libraryApi, type LibraryItem } from '@shared/api/polypalApi'

/** A small PNG of what the 3D viewer currently shows (null if no viewer). */
export function captureViewerThumbnail(size = 384): string | null {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-polypal-viewer] canvas')
  if (!canvas || !canvas.width || !canvas.height) return null
  const scale = size / Math.max(canvas.width, canvas.height)
  const out = document.createElement('canvas')
  out.width = Math.round(canvas.width * scale)
  out.height = Math.round(canvas.height * scale)
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  try {
    return out.toDataURL('image/png')
  } catch {
    return null
  }
}

export function SaveToLibraryDialog({ source, defaultName = '', onClose, onSaved }: {
  source: string
  defaultName?: string
  onClose: () => void
  onSaved?: (item: LibraryItem) => void
}): JSX.Element {
  const [name, setName] = useState(defaultName)
  const [category, setCategory] = useState('Uncategorised')
  const [newCategory, setNewCategory] = useState('')
  const [categories, setCategories] = useState<string[]>(['Uncategorised'])
  const [tags, setTags] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thumbnail] = useState(() => captureViewerThumbnail())

  useEffect(() => { libraryApi.categories().then(setCategories).catch(() => {}) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const item = await libraryApi.save({
        source,
        name: name.trim() || 'Untitled model',
        category: category === '__new' ? newCategory.trim() || 'Uncategorised' : category,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        notes,
        thumbnail,
      })
      onSaved?.(item)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Save to library" className="pp-card w-full max-w-md p-6 animate-slide-up-center" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white">Save to Library</h2>
        <p className="mt-1 text-sm text-zinc-400">Keep a copy with a name and category so you can find it later.</p>

        <div className="mt-5 flex gap-4">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-white/[0.06] bg-black/40">
            {thumbnail ? <img src={thumbnail} alt="" className="h-full w-full object-cover" /> : null}
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <label className="pp-label" htmlFor="lib-name">Name</label>
            <input id="lib-name" autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save() }} className="pp-input" placeholder="My model" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="pp-label" htmlFor="lib-category">Category</label>
            <select id="lib-category" value={category} onChange={(e) => setCategory(e.target.value)} className="pp-input">
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              <option value="__new">+ New category…</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="pp-label" htmlFor="lib-tags">Tags</label>
            <input id="lib-tags" value={tags} onChange={(e) => setTags(e.target.value)} className="pp-input" placeholder="cute, print" />
          </div>
        </div>
        {category === '__new' && (
          <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className="pp-input mt-3" placeholder="Category name" aria-label="New category name" />
        )}
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="pp-input mt-3 resize-none" placeholder="Notes (optional)" aria-label="Notes" />

        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="pp-btn-ghost">Cancel</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="pp-btn-primary">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
