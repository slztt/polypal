import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import { useNavStore } from '@shared/stores/navStore'
import { errorMessage, libraryApi, type LibraryItem } from '@shared/api/polypalApi'
import { meshPathFromUrl } from '@areas/generate/meshPath'
import { useCreateStore } from '@areas/create/createStore'
import { formatBytes } from '@shared/utils/format'
import { brandText } from '@shared/branding'
import { usePageActive } from '@shared/hooks/usePageActive'

const ALL = '__all__'

function ItemDetails({ item, categories, onChanged, onDeleted, onOpen }: {
  item: LibraryItem
  categories: string[]
  onChanged: (item: LibraryItem) => void
  onDeleted: () => void
  onOpen: () => void
}): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const [name, setName] = useState(item.name)
  const [category, setCategory] = useState(item.category)
  const [tags, setTags] = useState(item.tags.join(', '))
  const [notes, setNotes] = useState(item.notes)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setName(item.name); setCategory(item.category); setTags(item.tags.join(', ')); setNotes(item.notes)
    setConfirmDelete(false); setError(null)
  }, [item])

  const dirty = name !== item.name || category !== item.category || tags !== item.tags.join(', ') || notes !== item.notes

  const save = async () => {
    try {
      onChanged(await libraryApi.update(item.id, {
        name: name.trim() || item.name,
        category,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        notes,
      }))
    } catch (e) { setError(errorMessage(e)) }
  }

  const exportAs = (format: 'glb' | 'obj' | 'stl') => {
    const path = meshPathFromUrl(item.url) ?? ''
    const link = document.createElement('a')
    link.href = format === item.format
      ? `${apiUrl}${item.url}`
      : `${apiUrl}/optimize/export?path=${encodeURIComponent(path)}&format=${format}&units=${format === 'stl' ? 'mm' : 'm'}`
    link.download = `${item.name}.${format}`
    link.click()
  }

  return (
    <aside className="pp-panel flex w-[320px] animate-rise-in shrink-0 flex-col gap-4 overflow-y-auto p-4" aria-label="Model details">
      <div className="aspect-square overflow-hidden rounded-xl bg-surface-300">
        {item.thumbnail_url
          ? <img src={`${apiUrl}${item.thumbnail_url}`} alt={item.name} className="h-full w-full object-contain" />
          : <div className="flex h-full items-center justify-center text-xs text-zinc-600">No preview</div>}
      </div>
      <button type="button" className="pp-btn-primary" onClick={onOpen}>Open in viewer</button>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="lib-name" className="pp-label">Name</label>
        <input id="lib-name" className="pp-input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="lib-category" className="pp-label">Category</label>
        <select id="lib-category" className="pp-input" value={category} onChange={(e) => setCategory(e.target.value)}>
          {[...new Set([...categories, item.category])].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="lib-tags" className="pp-label">Tags <span className="text-zinc-600">(comma separated)</span></label>
        <input id="lib-tags" className="pp-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="props, fantasy" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="lib-notes" className="pp-label">Notes</label>
        <textarea id="lib-notes" className="pp-input resize-none" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {dirty && <button type="button" className="pp-btn-primary" onClick={() => void save()}>Save changes</button>}

      <div className="flex flex-col gap-1.5">
        <span className="pp-label">Export</span>
        <div className="flex gap-2">
          {(['glb', 'obj', 'stl'] as const).map((f) => (
            <button key={f} type="button" className="pp-btn-ghost flex-1 uppercase" onClick={() => exportAs(f)}>{f}</button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-zinc-500">Size</dt><dd className="text-zinc-300">{formatBytes(item.bytes)}</dd>
        <dt className="text-zinc-500">Format</dt><dd className="uppercase text-zinc-300">{item.format}</dd>
        {item.model_name && <><dt className="text-zinc-500">Made with</dt><dd className="text-zinc-300">{brandText(item.model_name)}</dd></>}
        <dt className="text-zinc-500">Saved</dt><dd className="text-zinc-300">{new Date(item.created_at).toLocaleDateString()}</dd>
      </dl>

      {confirmDelete ? (
        <div className="flex gap-2">
          <button type="button" className="pp-btn-danger flex-1" data-sfx="delete" onClick={() => void libraryApi.remove(item.id).then(onDeleted, (e) => setError(errorMessage(e)))}>
            Delete for good
          </button>
          <button type="button" className="pp-btn-ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
        </div>
      ) : (
        <button type="button" className="pp-btn-ghost text-red-300" onClick={() => setConfirmDelete(true)}>Delete from library</button>
      )}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </aside>
  )
}

export default function LibraryPage(): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const navigate = useNavStore((s) => s.navigate)
  const [items, setItems] = useState<LibraryItem[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [category, setCategory] = useState<string>(ALL)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newCategory, setNewCategory] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [list, cats] = await Promise.all([libraryApi.list(), libraryApi.categories()])
      setItems(list)
      setCategories(cats)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  usePageActive('library', () => { void load() })

  const counts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const item of items) map[item.category] = (map[item.category] ?? 0) + 1
    return map
  }, [items])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) =>
      (category === ALL || item.category === category) &&
      (!needle || [item.name, item.notes, ...item.tags].some((t) => t.toLowerCase().includes(needle))))
  }, [items, category, query])

  const selected = items.find((i) => i.id === selectedId) ?? null

  const addCategory = async () => {
    const name = newCategory.trim()
    if (!name) return
    try {
      setCategories(await libraryApi.addCategory(name))
      setNewCategory('')
    } catch (e) { setError(errorMessage(e)) }
  }

  const removeCategory = async (name: string) => {
    try {
      setCategories(await libraryApi.removeCategory(name))
      if (category === name) setCategory(ALL)
      await load()
    } catch (e) { setError(errorMessage(e)) }
  }

  const open = (item: LibraryItem) => {
    const app = useAppStore.getState()
    useCreateStore.getState().reset()
    app.clearMeshHistory()
    app.setCurrentJob({
      id: `library-${item.id}`, imageFile: '', status: 'done', progress: 100, step: '',
      createdAt: Date.now(), outputUrl: item.url, originalOutputUrl: item.url,
    })
    app.pushMeshUrl(item.url, 'Opened from library')
    navigate(app.uiMode === 'advanced' ? 'generate' : 'create')
  }

  return (
    <div className="flex flex-1 gap-4 overflow-hidden p-4">
      {/* Categories */}
      <nav className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto" aria-label="Categories">
        <header className="mb-3">
          <h1 className="pp-title">Library</h1>
          <p className="pp-subtitle mt-1">Your saved models.</p>
        </header>
        {[ALL, ...categories].map((c) => (
          <div key={c} className="group flex items-center">
            <button type="button" onClick={() => setCategory(c)} aria-current={category === c}
              className={`flex flex-1 items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${category === c ? 'bg-accent/15 text-accent-light' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-white'}`}>
              <span className="truncate">{c === ALL ? 'All models' : c}</span>
              <span className="text-[11px] tabular-nums text-zinc-600">{c === ALL ? items.length : counts[c] ?? 0}</span>
            </button>
            {c !== ALL && c !== 'Uncategorised' && !counts[c] && (
              <button type="button" aria-label={`Remove category ${c}`} onClick={() => void removeCategory(c)}
                className="ml-1 hidden px-1 text-zinc-600 hover:text-red-400 group-hover:block">✕</button>
            )}
          </div>
        ))}
        <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void addCategory() }}>
          <input className="pp-input min-w-0 flex-1 py-1.5 text-xs" placeholder="New category" value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)} aria-label="New category name" />
          <button type="submit" className="pp-btn-ghost px-2.5 py-1.5 text-xs" disabled={!newCategory.trim()}>Add</button>
        </form>
      </nav>

      {/* Grid */}
      <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden" aria-label="Models">
        <input type="search" className="pp-input" placeholder="Search by name, tag or note" value={query}
          onChange={(e) => setQuery(e.target.value)} aria-label="Search the library" />
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="p-6 text-sm text-zinc-500">Loading…</p>
          ) : visible.length === 0 ? (
            <div className="pp-card flex flex-col items-center gap-2 p-10 text-center">
              <p className="text-sm text-white">{items.length ? 'Nothing matches' : 'Your library is empty'}</p>
              <p className="max-w-sm text-xs text-zinc-500">
                {items.length ? 'Try another search or category.' : 'After generating a model, press “Save to Library” to keep it here with a name and category.'}
              </p>
              {!items.length && <button type="button" className="pp-btn-primary mt-2" onClick={() => navigate('create')}>Make a model</button>}
            </div>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
              {visible.map((item, i) => (
                <li key={item.id} className="animate-rise-in" style={{ animationDelay: `${Math.min(i, 16) * 22}ms` }}>
                  <button type="button" onClick={() => setSelectedId(item.id)} onDoubleClick={() => open(item)}
                    className={`pp-card pp-card-hover group w-full overflow-hidden text-left ${selectedId === item.id ? 'border-accent/60' : 'hover:border-white/20'}`}>
                    <div className="aspect-square bg-surface-300">
                      {item.thumbnail_url
                        ? <img src={`${apiUrl}${item.thumbnail_url}`} alt="" className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-105" loading="lazy" />
                        : <div className="flex h-full items-center justify-center text-xs text-zinc-600">No preview</div>}
                    </div>
                    <div className="px-3 py-2">
                      <p className="truncate text-sm text-white">{item.name}</p>
                      <p className="truncate text-[11px] text-zinc-500">{item.category}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {selected && (
        <ItemDetails
          item={selected}
          categories={categories}
          onChanged={(updated) => setItems((list) => list.map((i) => (i.id === updated.id ? updated : i)))}
          onDeleted={() => { setSelectedId(null); void load() }}
          onOpen={() => open(selected)}
        />
      )}
    </div>
  )
}
